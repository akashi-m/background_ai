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
import { POSE_IDX } from './shadowGeom'

// Синтетическая «стоячая» поза в КОНВЕНЦИИ MediaPipe world: hip-origin, метры, Y-ВНИЗ
// (голова в −Y, ступни в +Y), x-вправо, z-глубина. Для симуляции прокси без камеры.
function simPose(): number[][] {
  const p = Array.from({ length: 33 }, () => [0, 0, 0, 0])
  p[POSE_IDX.NOSE] = [0, -0.65, 0, 1]
  p[POSE_IDX.L_SHOULDER] = [-0.18, -0.5, 0, 1]
  p[POSE_IDX.R_SHOULDER] = [0.18, -0.5, 0, 1]
  p[POSE_IDX.L_ELBOW] = [-0.22, -0.25, 0, 1]
  p[POSE_IDX.R_ELBOW] = [0.22, -0.25, 0, 1]
  p[POSE_IDX.L_WRIST] = [-0.24, 0.0, 0, 1]
  p[POSE_IDX.R_WRIST] = [0.24, 0.0, 0, 1]
  p[POSE_IDX.L_HIP] = [-0.1, 0, 0, 1]
  p[POSE_IDX.R_HIP] = [0.1, 0, 0, 1]
  p[POSE_IDX.L_KNEE] = [-0.1, 0.45, 0, 1]
  p[POSE_IDX.R_KNEE] = [0.1, 0.45, 0, 1]
  p[POSE_IDX.L_ANKLE] = [-0.1, 0.9, 0, 1]
  p[POSE_IDX.R_ANKLE] = [0.1, 0.9, 0, 1]
  return p
}

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
const DBG_PROXY = Q.get('dbgproxy') === '1' // видимый рендер капсул прокси (диагностика ориентации)

const canvas = document.getElementById('c') as HTMLCanvasElement
const info = document.getElementById('info') as HTMLDivElement

// 9:16 portrait sized to fit the window height (centered via CSS).
// fallback: preview-браузер может выполнить deferred-модуль ДО лэйаута (innerHeight=0) →
// канвас/RT родились бы нулевыми. Гарантируем ≥720, чтобы стенд всегда рендерил.
const H = Math.max(window.innerHeight || 0, 720)
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

  if (DBG_PROXY) {
    // диагностика: капсулы прокси ВИДИМО на тёмном фоне (видна реальная поза/ориентация)
    renderer.setRenderTarget(null)
    renderer.setClearColor(0x222222, 1)
    renderer.clear()
    renderer.render(shadowScene.scene, shadowScene.camera)
    return
  }

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
  // СИМУЛЯЦИЯ позы: гоним синтетическую стоячую позу в РЕАЛЬНЫЙ proxyRig (без камеры/человека),
  // ставим его на видимый пол [PX,PY] и делаем кастером. Так итерируем форму/маппинг тени.
  // ?sim=static — вернуть простой staticProxy для сравнения.
  if (Q.get('sim') === 'static') {
    shadowScene.setCaster(staticProxy([PX, PY, lights.floorZ], PH))
  } else {
    shadowScene.proxyRig.update(simPose(), new THREE.Vector3(PX, PY, lights.floorZ), PH)
    shadowScene.setCaster(shadowScene.proxyRig.object)
  }
  if (DBG_PROXY) {
    // делаем капсулы прокси видимыми (по умолчанию colorWrite=false) — для диагностики
    shadowScene.proxyRig.object.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) m.material = new THREE.MeshBasicMaterial({ color: 0xff4444 })
    })
  }
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
