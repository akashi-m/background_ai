// DEV-ONLY alignment harness (Phase B1 verification). NOT imported by main.ts — never ships.
// Renders: living-room plate + the REAL static-proxy shadow, headless-screenshottable,
// with NO camera/capture/person. Reuses the real ShadowScene3D + makeMultiplyBlitMat so
// this verifies the actual B1 code (baked Blender Z-up camera, Key PointLight, box floor,
// static invisible capsule proxy at floor-center H≈1.7).
//
// Canvas is 9:16 portrait (matches plate aspect 0.5625 1:1) → uUvScale=(1,1), no cover crop.
import * as THREE from 'three'
import { ShadowScene3D, staticProxy, type ShadowData } from './shadowScene3D'
import { makeMultiplyBlitMat } from './multiplyBlit'

const PLATE_URL = '/assets/worlds/living/photo.png'
const LIGHTS_URL = '/assets/worlds/living/lights.json'

// Позиция тест-прокси (Blender Z-up world). Камера смотрит в +X, поэтому ставим
// прокси на видимый пол ПЕРЕД камерой. Перекрывается ?px&py&h. ?showproxy=1 рисует
// магента-маркеры базы/верха поверх, чтобы поймать точку на видимом полу.
const Q = new URLSearchParams(location.search)
const PX = Number(Q.get('px') ?? '3.5')
const PY = Number(Q.get('py') ?? '2.0')
const PH = Number(Q.get('h') ?? '1.7')
const SHOW_PROXY = Q.get('showproxy') === '1'

const canvas = document.getElementById('c') as HTMLCanvasElement
const info = document.getElementById('info') as HTMLDivElement

// 9:16 portrait sized to fit the window height (centered via CSS).
const H = window.innerHeight
const W = Math.round((H * 9) / 16)
canvas.width = W
canvas.height = H

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setSize(W, H, false)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.autoClear = false

// compositeRT holds the plate; shadowRT holds the shadow render. Final multiply → screen.
const rtOpts: THREE.RenderTargetOptions = {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
}
const compositeRT = new THREE.WebGLRenderTarget(W, H, rtOpts)
const shadowRT = new THREE.WebGLRenderTarget(W, H, rtOpts)

// Fullscreen-quad scene (GLSL1 fullscreen-triangle pattern: gl_Position = vec4(position.xy,0,1)).
// A PlaneGeometry(2,2) mesh fills clip space exactly with both materials.
const quadGeom = new THREE.PlaneGeometry(2, 2)
const quadScene = new THREE.Scene()
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

// Plate-blit material: sample the plate 1:1 (same vertex convention as multiplyBlitMat).
const plateMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL1,
  uniforms: { tPlate: { value: null as THREE.Texture | null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tPlate;
    void main() { gl_FragColor = vec4(texture2D(tPlate, vUv).rgb, 1.0); }
  `,
  depthTest: false,
})

const multiplyMat = makeMultiplyBlitMat()
multiplyMat.uniforms.tBg.value = compositeRT.texture
multiplyMat.uniforms.tShadow.value = shadowRT.texture
multiplyMat.uniforms.uUvScale.value = new THREE.Vector2(1, 1)
multiplyMat.uniforms.uShadowStrength.value = 0.6
multiplyMat.uniforms.uShadowFloorK.value = 0.7

const quad = new THREE.Mesh(quadGeom, plateMat)
quadScene.add(quad)

let shadowScene: ShadowScene3D | null = null
const markerScene = new THREE.Scene() // ?showproxy=1: магента/циан маркеры базы/верха

function renderFrame(): void {
  if (!shadowScene) return

  // 1) Plate → compositeRT (fullscreen quad, UV 1:1).
  quad.material = plateMat
  renderer.setRenderTarget(compositeRT)
  renderer.clear()
  renderer.render(quadScene, quadCam)

  // 2) Real shadow scene → shadowRT, WHITE clear (shadow = darkening of white).
  renderer.setRenderTarget(shadowRT)
  renderer.setClearColor(0xffffff, 1)
  renderer.clear()
  renderer.render(shadowScene.scene, shadowScene.camera)

  // 3) Real multiply-blit composite → screen.
  quad.material = multiplyMat
  renderer.setRenderTarget(null)
  renderer.setClearColor(0x000000, 1)
  renderer.clear()
  renderer.render(quadScene, quadCam)

  // 4) DEBUG (?showproxy=1): маркеры базы/верха прокси поверх, камерой сцены тени.
  // autoClear=false → рисуется поверх композита; depthTest=false → всегда видно.
  if (SHOW_PROXY) renderer.render(markerScene, shadowScene.camera)
}

async function boot(): Promise<void> {
  let lights: ShadowData
  try {
    const res = await fetch(LIGHTS_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${LIGHTS_URL}`)
    lights = (await res.json()) as ShadowData
  } catch (err) {
    console.error('[shadow-align] failed to load lights.json:', err)
    info.textContent = 'shadow-align: ERROR loading lights.json (see console)'
    return
  }

  let plateTex: THREE.Texture
  try {
    plateTex = await new THREE.TextureLoader().loadAsync(PLATE_URL)
  } catch (err) {
    console.error('[shadow-align] failed to load plate photo.png:', err)
    info.textContent = 'shadow-align: ERROR loading photo.png (see console)'
    return
  }
  // Loaded textures are flipY=true by default; our blit samples uv 1:1, so the plate
  // appears upright (same convention the shadow camera renders into shadowRT).
  plateTex.colorSpace = THREE.SRGBColorSpace
  plateMat.uniforms.tPlate.value = plateTex

  // Build the REAL B1 shadow scene from lights.json {lamps, camera, floorZ}.
  shadowScene = new ShadowScene3D(lights, renderer)
  // Поставить тест-прокси на видимый пол перед камерой (ShadowScene3D по умолчанию
  // строит его в [0,0,floorZ] — это Blender-origin, вне кадра; перекрываем setCaster).
  shadowScene.setCaster(staticProxy([PX, PY, lights.floorZ], PH))
  if (SHOW_PROXY) {
    const mk = (z: number, color: number, r: number): THREE.Mesh => {
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(r, 16, 16),
        new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
      )
      s.position.set(PX, PY, z)
      return s
    }
    markerScene.add(mk(lights.floorZ, 0xff00ff, 0.07)) // база (ноги) — магента
    markerScene.add(mk(lights.floorZ + PH, 0x00ffff, 0.05)) // верх (голова) — циан
  }

  const cam = lights.camera
  info.textContent =
    'shadow-align: plate+proxy (B1)\n' +
    `cam.pos   [${cam.pos.map((n) => n.toFixed(2)).join(', ')}]\n` +
    `cam.target[${cam.target.map((n) => n.toFixed(2)).join(', ')}]\n` +
    `floorZ ${lights.floorZ}  fovY ${cam.fovY.toFixed(3)}  aspect ${cam.aspect}\n` +
    `proxy: capsule @ [${PX}, ${PY}, ${lights.floorZ}] H=${PH}` + (SHOW_PROXY ? '  +markers' : '')

  const loop = (): void => {
    renderFrame()
    requestAnimationFrame(loop)
  }
  loop()
}

void boot()
