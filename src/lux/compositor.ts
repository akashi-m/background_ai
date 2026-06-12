// Композитор Lux (спека §4): мир → RT → экран; затем тень, фигура
// (SBS-распаковка + LUT + light wrap + зерно), фейд смены миров.
// Light wrap берёт уменьшенную размытую копию RT фона.

import * as THREE from 'three'

import type { ShadowEllipse } from './shadow'

export interface HarmonizeToggles {
  lut: boolean
  wrap: boolean
  shadow: boolean
  grain: boolean
}

export interface SlideState {
  a: THREE.Texture | null
  b: THREE.Texture | null
  mix: number
  visible: number // 0..1 — альфа слайдшоу (кроссфейд с зеркалом)
}

const FSQ = new THREE.PlaneGeometry(2, 2)
const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

// Отдельный вертексный шейдер для GLSL3 (personMat)
const VERT3 = /* glsl */ `
  out vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

function fsqMesh(mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(FSQ, mat)
  m.frustumCulled = false
  return m
}

export class LuxCompositor {
  private sceneRT: THREE.WebGLRenderTarget
  private wrapRT_A: THREE.WebGLRenderTarget
  private wrapRT_B: THREE.WebGLRenderTarget
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private passScene = new THREE.Scene()
  private passMeshes = new Map<THREE.Material, THREE.Mesh>() // кэш — без аллокаций в кадре

  private blitMat: THREE.ShaderMaterial
  private blurMat: THREE.ShaderMaterial
  private slideMat: THREE.ShaderMaterial
  private shadowMat: THREE.ShaderMaterial
  private personMat: THREE.ShaderMaterial
  private fadeMat: THREE.MeshBasicMaterial

  constructor(private renderer: THREE.WebGLRenderer, width: number, height: number) {
    this.sceneRT = new THREE.WebGLRenderTarget(width, height)
    this.wrapRT_A = new THREE.WebGLRenderTarget(width >> 2, height >> 2)
    this.wrapRT_B = new THREE.WebGLRenderTarget(width >> 2, height >> 2)

    this.blitMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tSrc;
        void main() { gl_FragColor = texture2D(tSrc, vUv); }
      `,
      depthTest: false,
    })

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2(1, 0) } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uDir;
        void main() {
          vec4 acc = vec4(0.0);
          float w[5]; w[0]=0.227; w[1]=0.194; w[2]=0.121; w[3]=0.054; w[4]=0.016;
          acc += texture2D(tSrc, vUv) * w[0];
          for (int i = 1; i < 5; i++) {
            vec2 off = uDir * float(i);
            acc += texture2D(tSrc, vUv + off) * w[i];
            acc += texture2D(tSrc, vUv - off) * w[i];
          }
          gl_FragColor = acc;
        }
      `,
      depthTest: false,
    })

    this.slideMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      uniforms: {
        tA: { value: null }, tB: { value: null },
        uMix: { value: 0 }, uVisible: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tA; uniform sampler2D tB;
        uniform float uMix; uniform float uVisible;
        void main() {
          vec3 a = texture2D(tA, vUv).rgb;
          vec3 b = texture2D(tB, vUv).rgb;
          gl_FragColor = vec4(mix(a, b, uMix), uVisible);
        }
      `,
    })

    this.shadowMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      uniforms: {
        uC: { value: new THREE.Vector2(0.5, 0.9) },
        uR: { value: new THREE.Vector2(0.2, 0.05) },
        uOpacity: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform vec2 uC; uniform vec2 uR; uniform float uOpacity;
        void main() {
          // vUv.y инвертируем: bbox в видео-координатах (y вниз)
          vec2 p = vec2(vUv.x, 1.0 - vUv.y);
          float d = length((p - uC) / uR);
          float a = smoothstep(1.0, 0.35, d) * uOpacity;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }
      `,
    })

    // personMat требует GLSL3: sampler3D доступен только в WebGL2/GLSL ES 3.00.
    // Конвертация: VERT3 (out вместо varying), in-квалификаторы, out vec4 fragColor,
    // texture() вместо texture2D() везде. Отклонение от плана — план смешивал
    // texture2D и sampler3D в GLSL1, что не компилируется.
    this.personMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      glslVersion: THREE.GLSL3,
      uniforms: {
        tVideo: { value: null },
        tLut: { value: null },
        uLutSize: { value: 16 },
        tWrap: { value: null },
        uOpacity: { value: 0 },
        uUvScale: { value: new THREE.Vector2(1, 1) },
        uUvOffset: { value: new THREE.Vector2(0, 0) },
        uFeather: { value: new THREE.Vector2(0.05, 0.95) },
        uWrapStrength: { value: 0.6 },
        uGrain: { value: 0.04 },
        uTime: { value: 0 },
        uLutOn: { value: 1 },
        uWrapOn: { value: 1 },
        uGrainOn: { value: 1 },
      },
      vertexShader: VERT3,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler3D;
        in vec2 vUv;
        uniform sampler2D tVideo; uniform sampler3D tLut; uniform float uLutSize;
        uniform sampler2D tWrap;
        uniform float uOpacity; uniform vec2 uUvScale; uniform vec2 uUvOffset;
        uniform vec2 uFeather; uniform float uWrapStrength; uniform float uGrain;
        uniform float uTime; uniform float uLutOn; uniform float uWrapOn; uniform float uGrainOn;
        out vec4 fragColor;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7)) + uTime) * 43758.5453);
        }

        void main() {
          // cover-fit видео + зеркальный флип
          vec2 uv = (vUv - 0.5) * uUvScale + 0.5 + uUvOffset;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          vec2 uvm = vec2(1.0 - uv.x, uv.y);
          vec3 rgb = texture(tVideo, vec2(uvm.x * 0.5, uvm.y)).rgb;
          float a = texture(tVideo, vec2(0.5 + uvm.x * 0.5, uvm.y)).r;
          a = smoothstep(uFeather.x, uFeather.y, a);

          // LUT интерьера
          if (uLutOn > 0.5) {
            vec3 c = clamp(rgb, 0.0, 1.0);
            vec3 lutUv = c * (uLutSize - 1.0) / uLutSize + 0.5 / uLutSize;
            rgb = texture(tLut, lutUv).rgb;
          }

          // light wrap: фон «обнимает» контур (максимум на полупрозрачном крае)
          if (uWrapOn > 0.5) {
            vec3 wrapC = texture(tWrap, vUv).rgb;
            float edge = a * (1.0 - a) * 4.0;
            rgb = mix(rgb, wrapC, uWrapStrength * edge);
          }

          // зерно
          if (uGrainOn > 0.5) {
            rgb += (hash(gl_FragCoord.xy) - 0.5) * uGrain;
          }

          fragColor = vec4(rgb, a * uOpacity);
        }
      `,
    })

    this.fadeMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0, depthTest: false,
    })
  }

  setSize(width: number, height: number): void {
    this.sceneRT.setSize(width, height)
    this.wrapRT_A.setSize(width >> 2, height >> 2)
    this.wrapRT_B.setSize(width >> 2, height >> 2)
  }

  private pass(mat: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    let mesh = this.passMeshes.get(mat)
    if (!mesh) {
      mesh = fsqMesh(mat)
      this.passMeshes.set(mat, mesh)
    }
    this.passScene.children.length = 0
    this.passScene.add(mesh)
    const prev = this.renderer.autoClear
    this.renderer.autoClear = false
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.passScene, this.ortho)
    this.renderer.setRenderTarget(null)
    this.renderer.autoClear = prev
  }

  render(opts: {
    scene: THREE.Scene
    camera: THREE.Camera
    person: THREE.Texture | null
    personAspect: number | null
    mirrorOpacity: number
    shadow: ShadowEllipse | null
    shadowStrength: number
    lut: THREE.Data3DTexture
    lutSize: number
    toggles: HarmonizeToggles
    fade: number
    slides: SlideState
    timeSec: number
    canvasAspect: number
  }): void {
    const mirrorVisible = opts.mirrorOpacity > 0.001

    // 1. мир → RT (только когда зеркало видно)
    if (mirrorVisible) {
      this.renderer.setRenderTarget(this.sceneRT)
      this.renderer.render(opts.scene, opts.camera)
      this.renderer.setRenderTarget(null)

      // блюр для light wrap: RT → A (даунскейл блитом) → B (гориз.) → A (верт.)
      this.blitMat.uniforms.tSrc.value = this.sceneRT.texture
      this.pass(this.blitMat, this.wrapRT_A)
      const texel = new THREE.Vector2(1 / this.wrapRT_A.width, 1 / this.wrapRT_A.height)
      this.blurMat.uniforms.tSrc.value = this.wrapRT_A.texture
      this.blurMat.uniforms.uDir.value.set(texel.x, 0)
      this.pass(this.blurMat, this.wrapRT_B)
      this.blurMat.uniforms.tSrc.value = this.wrapRT_B.texture
      this.blurMat.uniforms.uDir.value.set(0, texel.y)
      this.pass(this.blurMat, this.wrapRT_A)
    }

    // 2. на экран: мир-блит
    this.renderer.clear()
    if (mirrorVisible) {
      this.blitMat.uniforms.tSrc.value = this.sceneRT.texture
      this.pass(this.blitMat, null)
    }

    // 3. слайдшоу IDLE (кроссфейдится с зеркалом через visible)
    if (opts.slides.visible > 0.001 && opts.slides.a) {
      this.slideMat.uniforms.tA.value = opts.slides.a
      this.slideMat.uniforms.tB.value = opts.slides.b ?? opts.slides.a
      this.slideMat.uniforms.uMix.value = opts.slides.mix
      this.slideMat.uniforms.uVisible.value = opts.slides.visible
      this.pass(this.slideMat, null)
    }

    // 4. контактная тень
    if (mirrorVisible && opts.toggles.shadow && opts.shadow) {
      this.shadowMat.uniforms.uC.value.set(opts.shadow.cx, opts.shadow.cy)
      this.shadowMat.uniforms.uR.value.set(opts.shadow.rx, opts.shadow.ry)
      this.shadowMat.uniforms.uOpacity.value =
        opts.shadow.opacity * opts.shadowStrength * opts.mirrorOpacity
      this.pass(this.shadowMat, null)
    }

    // 5. фигура
    if (mirrorVisible && opts.person) {
      const u = this.personMat.uniforms
      u.tVideo.value = opts.person
      u.tLut.value = opts.lut
      u.uLutSize.value = opts.lutSize
      u.tWrap.value = this.wrapRT_A.texture
      u.uOpacity.value = opts.mirrorOpacity
      u.uTime.value = opts.timeSec
      u.uLutOn.value = opts.toggles.lut ? 1 : 0
      u.uWrapOn.value = opts.toggles.wrap ? 1 : 0
      u.uGrainOn.value = opts.toggles.grain ? 1 : 0
      // cover-fit: видео заполняет экран без искажений
      if (opts.personAspect) {
        const va = opts.personAspect
        const ca = opts.canvasAspect
        if (ca > va) u.uUvScale.value.set(1, va / ca)
        else u.uUvScale.value.set(ca / va, 1)
      } else {
        u.uUvScale.value.set(1, 1)
      }
      this.pass(this.personMat, null)
    }

    // 6. шторка смены миров
    if (opts.fade > 0.001) {
      this.fadeMat.opacity = opts.fade
      this.pass(this.fadeMat, null)
    }
  }
}
