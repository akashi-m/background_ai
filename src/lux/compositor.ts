// Композитор Lux (спека §4): мир → RT → экран; затем тень, фигура
// (SBS-распаковка + LUT + light wrap + зерно), фейд смены миров.
// Light wrap берёт уменьшенную размытую копию RT фона.

import * as THREE from 'three'

import { LUX_CONFIG } from './config'
import type { ResolvedLook } from './look'
import { makeMultiplyBlitMat, makeBakedShadowMat } from './multiplyBlit'
import type { ShadowEllipse } from './shadow'
import type { ShadowCamera } from './shadowGeom'
import { ShadowScene3D } from './shadowScene3D'
import { activeStages, type StageFrame, type StageInputs, type StageId } from './stages'

export interface HarmonizeToggles {
  lut: boolean
  wrap: boolean
  shadow: boolean
  grain: boolean
  colorMatch: boolean
  bloom: boolean
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

export interface RenderOpts {
  scene: THREE.Scene
  camera: THREE.Camera
  backplate: THREE.Texture | null  // flat-мир: фуллскрин-фон вместо 3D-сцены
  backplateAspect: number | null
  person: THREE.Texture | null
  personAspect: number | null
  lightDirX: number  // направление ключа интерьера: -1 слева, +1 справа, 0 сверху
  mirrorOpacity: number
  shadow: ShadowEllipse | null
  shadowStrength: number
  shadowData: { lamps: { pos: [number, number, number]; weight: number }[]; worldPos: THREE.Texture; floorZ: number; camera: ShadowCamera; bakedShadow?: THREE.Texture | null } | null
  personFloor: { F: [number, number, number]; H: number } | null
  pose: { world: number[][]; healthy: number } | null
  feetUV: { u: number; v: number; halfW: number } | null
  shadowCfg: { strength: number; softness: number; bias: number }
  lut: THREE.Data3DTexture
  lutSize: number
  toggles: HarmonizeToggles
  fade: number
  slides: SlideState
  timeSec: number
  canvasAspect: number
  look: ResolvedLook
}

export class LuxCompositor {
  private sceneRT: THREE.WebGLRenderTarget
  private wrapRT_A: THREE.WebGLRenderTarget
  private wrapRT_B: THREE.WebGLRenderTarget
  private meanRT: THREE.WebGLRenderTarget // 1×1 — средний цвет сцены (цвет-матч)
  private compositeRT: THREE.WebGLRenderTarget // весь композит до зерна
  private shadowRT: THREE.WebGLRenderTarget // целевой RT физической тени (read+write split)
  private shadowRT2: THREE.WebGLRenderTarget // temp для multiply-blit read+write split (B1.9)
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private passScene = new THREE.Scene()
  private passMeshes = new Map<THREE.Material, THREE.Mesh>() // кэш — без аллокаций в кадре

  private blitMat: THREE.ShaderMaterial
  private blurMat: THREE.ShaderMaterial
  private bloomBrightMat: THREE.ShaderMaterial
  private meanMat: THREE.ShaderMaterial
  private grainMat: THREE.ShaderMaterial
  private coverMat: THREE.ShaderMaterial // flat-фон: cover-fit плейт без 3D-камеры
  private slideMat: THREE.ShaderMaterial
  private personMat: THREE.ShaderMaterial
  private unifyMat: THREE.ShaderMaterial // whole-frame LUT: грейд всего кадра одной текстурой
  private groundShadowMat: THREE.ShaderMaterial // силуэтная контактная тень у ног
  private blobMat: THREE.ShaderMaterial // контактная «тень-капля», приклеена к ступням
  private multiplyBlitMat: THREE.ShaderMaterial // multiply-blit physical-тени (B1.9 wiring)
  private bakedShadowMat: THREE.ShaderMaterial // Фаза 1: запечённая Blender-база
  private fadeMat: THREE.MeshBasicMaterial
  private shadowScene3D: ShadowScene3D | null = null // B1: реальный 3D-рендер прокси-тени (lazy)

  constructor(
    private renderer: THREE.WebGLRenderer,
    width: number,
    height: number,
  ) {
    this.sceneRT = new THREE.WebGLRenderTarget(width, height)
    this.wrapRT_A = new THREE.WebGLRenderTarget(width >> 2, height >> 2)
    this.wrapRT_B = new THREE.WebGLRenderTarget(width >> 2, height >> 2)
    this.meanRT = new THREE.WebGLRenderTarget(1, 1)
    this.compositeRT = new THREE.WebGLRenderTarget(width, height)
    this.shadowRT = new THREE.WebGLRenderTarget(width, height)
    this.shadowRT2 = new THREE.WebGLRenderTarget(width, height)

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

    // flat-фон зеркала: cover-fit блит плейта (заполняет канвас без искажений),
    // без 3D-камеры/eye → зум невозможен в принципе
    this.coverMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uUvScale: { value: new THREE.Vector2(1, 1) } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uUvScale;
        void main() {
          vec2 uv = (vUv - 0.5) * uUvScale + 0.5;
          gl_FragColor = texture2D(tSrc, uv);
        }
      `,
      depthTest: false,
    })

    // средний цвет сцены: 8×8-сетка отсчётов уже-размытого фона → 1×1
    this.meanMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tSrc;
        void main() {
          vec3 acc = vec3(0.0);
          for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 8; x++) {
              acc += texture2D(tSrc, (vec2(float(x), float(y)) + 0.5) / 8.0).rgb;
            }
          }
          gl_FragColor = vec4(acc / 64.0, 1.0);
        }
      `,
      depthTest: false,
    })

    // финальное зерно на весь кадр: компонует composite → экран, добавляя шум
    this.grainMat = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null }, uGrain: { value: 0.07 },
        uGrainOn: { value: 1 }, uTime: { value: 0 },
        // общий Bloom: добавляется ДО зерна (свечение ярких зон поверх всего композита)
        tBloom: { value: null }, uBloom: { value: 0.5 }, uBloomOn: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tSrc;
        uniform float uGrain; uniform float uGrainOn; uniform float uTime;
        uniform sampler2D tBloom; uniform float uBloom; uniform float uBloomOn;
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7)) + uTime) * 43758.5453);
        }
        void main() {
          vec3 c = texture2D(tSrc, vUv).rgb;
          if (uBloomOn > 0.5) c += texture2D(tBloom, vUv).rgb * uBloom; // оптическое свечение
          if (uGrainOn > 0.5) c += (hash(gl_FragCoord.xy) - 0.5) * uGrain;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthTest: false,
    })

    // Bloom bright-pass: оставляет только яркие зоны (лампы/окна/LED) выше порога,
    // затем размывается (blurMat, ¼-res) и аддитивно добавляется в grainMat.
    this.bloomBrightMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uThreshold: { value: 0.72 } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tSrc; uniform float uThreshold;
        void main() {
          vec3 c = texture2D(tSrc, vUv).rgb;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          gl_FragColor = vec4(c * smoothstep(uThreshold, 1.0, l), 1.0);
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

    // personMat требует GLSL3: sampler3D доступен только в WebGL2/GLSL ES 3.00.
    // Конвертация: VERT3 (out вместо varying), in-квалификаторы, out vec4 fragColor,
    // texture() вместо texture2D() везде.
    // GLSL3 явно: sampler3D — тип ES 3.0; three сам конвертирует GLSL1-шейдеры,
    // но явная версия честнее и не зависит от авто-конвертации.
    this.personMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      glslVersion: THREE.GLSL3,
      uniforms: {
        tVideo: { value: null },
        tLut: { value: null },
        uLutSize: { value: 16 },
        tWrap: { value: null },
        tMean: { value: null },
        uOpacity: { value: 0 },
        uUvScale: { value: new THREE.Vector2(1, 1) },
        uUvOffset: { value: new THREE.Vector2(0, 0) },
        uFeather: { value: new THREE.Vector2(0.4, 0.8) },
        uErode: { value: 0.0025 }, // эрозия альфы (UV) — срезает гало-бахрому RVM
        uWrapStrength: { value: 0.85 },
        uCast: { value: 0.35 },
        uExp: { value: 0.15 },
        uContrast: { value: 1.08 }, // контраст вокруг средне-серого
        uTemp: { value: 0.02 },         // температура: тёплый(+)/холодный(−)
        uShade: { value: 0.18 },
        uShadeDirX: { value: 0 },
        uLutOn: { value: 1 },
        uWrapOn: { value: 1 },
        uColorMatchOn: { value: 1 },
      },
      vertexShader: VERT3,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler3D;
        in vec2 vUv;
        uniform sampler2D tVideo; uniform sampler3D tLut; uniform float uLutSize;
        uniform sampler2D tWrap; uniform sampler2D tMean;
        uniform float uOpacity; uniform vec2 uUvScale; uniform vec2 uUvOffset;
        uniform vec2 uFeather; uniform float uErode; uniform float uWrapStrength;
        uniform float uCast; uniform float uExp;
        uniform float uContrast; uniform float uTemp;
        uniform float uShade; uniform float uShadeDirX;
        uniform float uLutOn; uniform float uWrapOn;
        uniform float uColorMatchOn;
        out vec4 fragColor;

        void main() {
          // cover-fit видео + зеркальный флип
          vec2 uv = (vUv - 0.5) * uUvScale + 0.5 + uUvOffset;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          vec2 uvm = vec2(1.0 - uv.x, uv.y);
          vec3 rgb = texture(tVideo, vec2(uvm.x * 0.5, uvm.y)).rgb;
          // альфа из правой половины SBS + ЭРОЗИЯ (min по соседям): поджимает матт внутрь,
          // срезая полупрозрачную гало-бахрому RVM (грязный край) ДО feather.
          // Все альфа-тапы КЛАМПим в альфа-половину [0.5+eps, 1-eps] — иначе −uErode и
          // билинейный шов залезают в RGB-половину (.r цвета как альфа → выемка по краю).
          float ax0 = 0.5 + 0.0015, ax1 = 1.0 - 0.0015;
          vec2 av = vec2(clamp(0.5 + uvm.x * 0.5, ax0, ax1), uvm.y);
          float a = texture(tVideo, av).r;
          a = min(a, texture(tVideo, vec2(min(av.x + uErode, ax1), av.y)).r);
          a = min(a, texture(tVideo, vec2(max(av.x - uErode, ax0), av.y)).r);
          a = min(a, texture(tVideo, av + vec2(0.0, uErode)).r);
          a = min(a, texture(tVideo, av + vec2(0.0, -uErode)).r);
          a = smoothstep(uFeather.x, uFeather.y, a);
          // затухание у КРОМКИ кадра: матт растворяется в леттербокс, а не бритвенный срез.
          // Высокий/близкий человек (голова у верхней границы / ступни у нижней) — мягкий
          // контур вместо горизонтального среза. Полоса узкая (3%), фигуру в кадре не трогает.
          float fe = 0.03;
          a *= smoothstep(0.0, fe, uv.x) * smoothstep(0.0, fe, 1.0 - uv.x)
             * smoothstep(0.0, fe, uv.y) * smoothstep(0.0, fe, 1.0 - uv.y);

          // LUT интерьера
          if (uLutOn > 0.5) {
            vec3 c = clamp(rgb, 0.0, 1.0);
            vec3 lutUv = c * (uLutSize - 1.0) / uLutSize + 0.5 / uLutSize;
            rgb = texture(tLut, lutUv).rgb;
          }

          // цвет-матч: переносим каст и экспозицию среднего цвета сцены на фигуру
          // (математика миррорит colorMatch.ts; среднее — в 1×1 tMean)
          if (uColorMatchOn > 0.5) {
            vec3 m = texture(tMean, vec2(0.5)).rgb;
            float luma = dot(m, vec3(0.2126, 0.7152, 0.0722));
            vec3 chroma = luma > 1e-3 ? m / luma : vec3(1.0);
            vec3 castMul = mix(vec3(1.0), chroma, uCast);
            float expMul = mix(1.0, luma / 0.5, uExp);
            rgb = clamp(rgb * castMul * expMul, 0.0, 1.0);
            // контраст вокруг средне-серого + температура (тёплый +R−B / холодный −R+B)
            rgb = clamp((rgb - 0.5) * uContrast + 0.5, 0.0, 1.0);
            rgb = clamp(rgb + vec3(uTemp, 0.0, -uTemp), 0.0, 1.0);
          }

          // направленный свет сцены: сторона к ключу ярче, от ключа темнее
          // uShadeDirX: +1 свет слева (левый край ярче), -1 свет справа
          float lit = 1.0 + uShade * (0.5 - vUv.x) * 2.0 * uShadeDirX;
          rgb = clamp(rgb * lit, 0.0, 1.0);

          // light wrap: фон «обнимает» контур (максимум на полупрозрачном крае)
          if (uWrapOn > 0.5) {
            vec3 wrapC = texture(tWrap, vUv).rgb;
            // полоса кромки расширена внутрь (sqrt) → свет фона затекает глубже на контур
            float edge = sqrt(clamp(a * (1.0 - a) * 4.0, 0.0, 1.0));
            rgb = mix(rgb, wrapC, uWrapStrength * edge);
          }

          // зерно теперь финальным пассом на весь кадр (grainMat), не здесь

          fragColor = vec4(rgb, a * uOpacity);
        }
      `,
    })

    // unifyMat: интерьерный 3D-LUT на ВЕСЬ кадр (комната+тень+человек) одной текстурой.
    // Та же LUT-математика, что и в personMat-блоке, но whole-frame + сила uLutStrength.
    this.unifyMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tSrc: { value: null }, tLut: { value: null },
        uLutSize: { value: 16 }, uLutStrength: { value: 1 },
      },
      vertexShader: VERT3,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler3D;
        in vec2 vUv;
        uniform sampler2D tSrc; uniform sampler3D tLut;
        uniform float uLutSize; uniform float uLutStrength;
        out vec4 fragColor;
        void main() {
          vec3 c = clamp(texture(tSrc, vUv).rgb, 0.0, 1.0);
          vec3 lutUv = c * (uLutSize - 1.0) / uLutSize + 0.5 / uLutSize;
          vec3 graded = texture(tLut, lutUv).rgb;
          fragColor = vec4(mix(c, graded, uLutStrength), 1.0);
        }
      `,
      depthTest: false,
    })

    // Силуэтная контактная тень: тот же cover-fit/флип, что у фигуры, но силуэт
    // СДВИНУТ вниз по экрану (uDrop) и размыт. Рисуется ПЕРЕД фигурой → везде,
    // кроме зоны под ступнями, тень закрыта непрозрачной фигурой → мягкое
    // пятно по форме стоп у пола. Привязка к «линии ног» не нужна.
    this.groundShadowMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      glslVersion: THREE.GLSL3,
      uniforms: {
        tVideo: { value: null },
        uUvScale: { value: new THREE.Vector2(1, 1) },
        uUvOffset: { value: new THREE.Vector2(0, 0) },
        uOpacity: { value: 0 },
        uDrop: { value: 0.022 },  // тугая лужа у ступней (эталон: проекс-рендер)
        uLightX: { value: 0.0 },  // снос вбок (верхний свет → ~0)
      },
      vertexShader: VERT3,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv;
        uniform sampler2D tVideo; uniform vec2 uUvScale; uniform vec2 uUvOffset;
        uniform float uOpacity; uniform float uDrop; uniform float uLightX;
        out vec4 fragColor;

        float sampleA(vec2 sv) {
          vec2 uv = (sv - 0.5) * uUvScale + 0.5 + uUvOffset;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
          vec2 uvm = vec2(1.0 - uv.x, uv.y);
          return texture(tVideo, vec2(0.5 + uvm.x * 0.5, uvm.y)).r;
        }

        void main() {
          // смотрим ВЫШE по телу (vUv.y + uDrop) → тень ложится НИЖЕ; мягкое 5×5
          vec2 base = vUv + vec2(uLightX, uDrop);
          float a = 0.0;
          for (int y = -2; y <= 2; y++)
            for (int x = -2; x <= 2; x++)
              a += sampleA(base + vec2(float(x), float(y)) * 0.008); // мягче край
          a /= 25.0;
          fragColor = vec4(0.0, 0.0, 0.0, a * uOpacity);
        }
      `,
    })

    // контактная «тень-капля»: мягкий радиальный эллипс, намертво в экранной
    // точке ступней — «приклеивает» ноги к полу (убийца Peter-Pan). Затемняет фон.
    this.blobMat = new THREE.ShaderMaterial({
      uniforms: {
        tBg: { value: null }, uCenter: { value: new THREE.Vector2(0.5, 0.1) },
        uRadius: { value: new THREE.Vector2(0.1, 0.04) }, uOpacity: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tBg; uniform vec2 uCenter, uRadius; uniform float uOpacity;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main() {
          vec3 bg = texture2D(tBg, vUv).rgb;
          vec2 d = (vUv - uCenter) / uRadius;
          float r = length(d);
          float dust = mix(0.85, 1.0, hash(floor(vUv * 480.0))); // пыльная текстура (как у прокси-тени)
          float a = (1.0 - smoothstep(0.35, 1.0, r)) * uOpacity * dust; // плотнее в центре, мягкий край
          gl_FragColor = vec4(bg * (1.0 - a), 1.0);
        }
      `,
      depthTest: false,
    })

    this.multiplyBlitMat = makeMultiplyBlitMat()
    this.multiplyBlitMat.uniforms.uShadowFloorK.value = LUX_CONFIG.shadow.shadowFloorK
    this.bakedShadowMat = makeBakedShadowMat()

    this.fadeMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0, depthTest: false,
    })
  }

  // Статичные пер-мир юниформы из ResolvedLook (грейд/тон тени). Каждый кадр перед циклом
  // стадий: look — единственный источник этих ручек (заменил конструкторный tuning/setTuning).
  private applyLook(look: ResolvedLook): void {
    const p = this.personMat.uniforms
    const g = look.grade
    p.uWrapStrength.value = g.wrapStrength
    p.uErode.value = look.matte.erode
    p.uFeather.value.set(look.matte.feather[0], look.matte.feather[1])
    p.uCast.value = g.colorMatch.cast
    p.uExp.value = g.colorMatch.exposure
    p.uContrast.value = g.contrast
    p.uTemp.value = g.temp
    p.uShade.value = g.shade
    this.grainMat.uniforms.uGrain.value = look.unify.grain
    this.grainMat.uniforms.uBloom.value = look.unify.bloom
    this.bloomBrightMat.uniforms.uThreshold.value = look.unify.bloomThreshold
    this.multiplyBlitMat.uniforms.uShadowTint.value.setRGB(
      look.shadow.multiply.tint[0], look.shadow.multiply.tint[1], look.shadow.multiply.tint[2])
    this.bakedShadowMat.uniforms.uMaxShadow.value = look.shadow.multiply.maxShadow
    this.bakedShadowMat.uniforms.uFeetMask.value.set(look.shadow.baked.feetUV[0], look.shadow.baked.feetUV[1])
  }

  setSize(width: number, height: number): void {
    this.sceneRT.setSize(width, height)
    this.wrapRT_A.setSize(width >> 2, height >> 2)
    this.wrapRT_B.setSize(width >> 2, height >> 2)
    this.compositeRT.setSize(width, height)
    this.shadowRT.setSize(width, height)
    this.shadowRT2.setSize(width, height)
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

  render(opts: RenderOpts): void {
    const mirrorVisible = opts.mirrorOpacity > 0.001

    // cover-fit фигуры (общий масштаб для тени и фигуры)
    let sx = 1, sy = 1
    if (opts.personAspect) {
      const va = opts.personAspect
      const ca = opts.canvasAspect
      if (ca > va) sy = va / ca
      else sx = ca / va
    }

    // look — статичные пер-мир юниформы (грейд/тон тени) перед циклом стадий
    this.applyLook(opts.look)

    const f: StageFrame = {
      opts: {
        toggles: { shadow: opts.toggles.shadow, bloom: opts.toggles.bloom, lut: opts.toggles.lut },
        person: opts.person, shadowData: opts.shadowData, personFloor: opts.personFloor,
        pose: opts.pose, feetUV: opts.feetUV, slides: opts.slides, fade: opts.fade,
      } as StageInputs,
      mirrorVisible, sx, sy,
    }

    for (const id of activeStages(f)) this.runStage(id, f, opts)
  }

  private runStage(id: StageId, f: StageFrame, opts: RenderOpts): void {
    const { mirrorVisible, sx, sy } = f
    switch (id) {
      case 'sceneBackground': {
        // 1. мир → RT (только когда зеркало видно)
        if (opts.backplate) {
          // flat-фон: cover-fit блит плейта в sceneRT (без 3D-камеры → без зума)
          const ca = opts.canvasAspect
          const ta = opts.backplateAspect ?? ca
          if (ca > ta) this.coverMat.uniforms.uUvScale.value.set(1, ta / ca)
          else this.coverMat.uniforms.uUvScale.value.set(ca / ta, 1)
          this.coverMat.uniforms.tSrc.value = opts.backplate
          this.renderer.setRenderTarget(this.sceneRT)
          this.renderer.clear()
          this.renderer.setRenderTarget(null)
          this.pass(this.coverMat, this.sceneRT)
        } else {
          this.renderer.setRenderTarget(this.sceneRT)
          this.renderer.clear() // RT обязан чиститься сам: глобальный autoClear=false
          this.renderer.render(opts.scene, opts.camera)
          this.renderer.setRenderTarget(null)
        }

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

        // средний цвет сцены (для цвет-матча фигуры) → 1×1
        this.meanMat.uniforms.tSrc.value = this.wrapRT_A.texture
        this.pass(this.meanMat, this.meanRT)
        break
      }

      case 'compositeBase': {
        // 2. слои композита собираем в compositeRT (зерно — финальным пассом)
        this.renderer.setRenderTarget(this.compositeRT)
        this.renderer.clear()
        this.renderer.setRenderTarget(null)
        if (mirrorVisible) {
          this.blitMat.uniforms.tSrc.value = this.sceneRT.texture
          this.pass(this.blitMat, this.compositeRT)
        }
        break
      }

      case 'idleSlides': {
        // 3. слайдшоу IDLE (кроссфейдится с зеркалом через visible)
        this.slideMat.uniforms.tA.value = opts.slides.a
        this.slideMat.uniforms.tB.value = opts.slides.b ?? opts.slides.a
        this.slideMat.uniforms.uMix.value = opts.slides.mix
        this.slideMat.uniforms.uVisible.value = opts.slides.visible
        this.pass(this.slideMat, this.compositeRT)
        break
      }

      case 'bakedShadow': {
        // Фаза 1: запечённая Blender-база (приоритет). Привязка к ступням — сдвигаем маску так,
        // чтобы её «ноги» легли в живые feetUV. Софт/тон/контакты уже в бейке (не пересинтез).
        const bsu = this.bakedShadowMat.uniforms
        bsu.tBg.value = this.compositeRT.texture
        bsu.tBaked.value = opts.shadowData!.bakedShadow
        bsu.uUvScale.value.copy(this.coverMat.uniforms.uUvScale.value)
        // привязка к ступням: сдвиг маски так, чтобы «ноги» бейка легли в живые feetUV
        // (вид тени — как есть из Blender; двигаем только позицию). Нет feetUV → нативно.
        const bakedFeetU = opts.look.shadow.baked.feetUV[0]
        const bakedFeetV = opts.look.shadow.baked.feetUV[1]
        const bakedRaise = opts.look.shadow.baked.raise
        if (opts.feetUV) {
          bsu.uOffset.value.set(opts.feetUV.u - bakedFeetU, opts.feetUV.v - bakedFeetV + bakedRaise)
        } else {
          bsu.uOffset.value.set(0, bakedRaise)
        }
        this.pass(this.bakedShadowMat, this.shadowRT2)
        this.blitMat.uniforms.tSrc.value = this.shadowRT2.texture
        this.pass(this.blitMat, this.compositeRT)
        break
      }

      case 'proxyShadow': {
        // Фаза 2: прокси — БЛЕДНЫЙ живой слой ПОВЕРХ базы (артикуляция рук/ног), идёт ВМЕСТЕ с базой.
        // proxy-тень — ТОЛЬКО при сглаженной gated позе; нет позы → не рисуем (не «замерзает», C.6).
        if (!this.shadowScene3D) {
          this.shadowScene3D = new ShadowScene3D(
            { lamps: opts.shadowData!.lamps, camera: opts.shadowData!.camera, floorZ: opts.shadowData!.floorZ },
            this.renderer,
          )
        }
        this.shadowScene3D.proxyRig.update(
          opts.pose!.world,
          new THREE.Vector3(opts.personFloor!.F[0], opts.personFloor!.F[1], opts.personFloor!.F[2]),
          opts.personFloor!.H,
        )
        this.shadowScene3D.setCaster(this.shadowScene3D.proxyRig.object)
        const prevClear = new THREE.Color()
        this.renderer.getClearColor(prevClear)
        const prevAlpha = this.renderer.getClearAlpha()
        this.renderer.setRenderTarget(this.shadowRT)
        this.renderer.setClearColor(0xffffff, 1)
        this.renderer.clear()
        this.renderer.render(this.shadowScene3D.scene, this.shadowScene3D.camera)
        this.renderer.setRenderTarget(null)
        this.renderer.setClearColor(prevClear, prevAlpha)
        const mbu = this.multiplyBlitMat.uniforms
        mbu.tBg.value = this.compositeRT.texture
        mbu.tShadow.value = this.shadowRT.texture
        mbu.uUvScale.value.copy(this.coverMat.uniforms.uUvScale.value)
        mbu.uShadowStrength.value = opts.shadowStrength
        // бледный + сильно размытый: только намёк на движение поверх базы (капсульность прячется)
        mbu.uCenterDark.value = opts.look.shadow.proxy.centerDark
        mbu.uEdgeDark.value = opts.look.shadow.proxy.edgeDark
        mbu.uBlur.value = opts.look.shadow.proxy.blur
        // вырез прокси-тени у ног (контакт-стопу держит блоб). Центр = САМИ ступни (без +0.04
        // подъёма блоба — стопа прокси ниже), радиус щедрый, чтобы убрать остаток следа.
        if (opts.feetUV) {
          const cs = this.coverMat.uniforms.uUvScale.value
          mbu.uFeetCut.value.set(
            Math.min(1, Math.max(0, (opts.feetUV.u - 0.5) / cs.x + 0.5)),
            Math.min(1, Math.max(0, (opts.feetUV.v - 0.5) / cs.y + 0.5)),
          )
          mbu.uFeetCutR.value = opts.look.shadow.proxy.feetCutR
        } else {
          mbu.uFeetCutR.value = 0.0
        }
        this.pass(this.multiplyBlitMat, this.shadowRT2)
        this.blitMat.uniforms.tSrc.value = this.shadowRT2.texture
        this.pass(this.blitMat, this.compositeRT)
        break
      }

      case 'fallbackSilhouette': {
        const g = this.groundShadowMat.uniforms
        g.tVideo.value = opts.person
        g.uUvScale.value.set(sx, sy)
        g.uOpacity.value = opts.shadowStrength * opts.mirrorOpacity
        g.uLightX.value = opts.lightDirX * 0.015 // лёгкий снос по ключу (реальная почти вертикальна)
        this.pass(this.groundShadowMat, this.compositeRT)
        break
      }

      case 'blobContact': {
        // 4б. контактная «тень-капля» — ВСЕГДА, приклеена к экранным ступням
        const b = this.blobMat.uniforms
        b.tBg.value = this.compositeRT.texture
        // центр блоба — экранные ступни (cover-fit ремап), КЛАМП в [0,1]: при высоком/близком
        // (ноги у кромки) центр не уезжает за кадр → контакт-тень не пропадает. 0.06→0.04: ниже 2% (юзер)
        b.uCenter.value.set(
          Math.min(1, Math.max(0, (opts.feetUV!.u - 0.5) / sx + 0.5)),
          Math.min(1, Math.max(0, (opts.feetUV!.v - 0.5) / sy + 0.5 + opts.look.shadow.blob.raise)),
        )
        const rx = (opts.feetUV!.halfW / sx) * 1.0
        b.uRadius.value.set(rx, rx * opts.look.shadow.blob.ratioY)
        b.uOpacity.value = opts.look.shadow.blob.opacity * opts.mirrorOpacity // непрозрачность блоба = look.shadow.blob.opacity
        this.pass(this.blobMat, this.shadowRT)
        this.blitMat.uniforms.tSrc.value = this.shadowRT.texture
        this.pass(this.blitMat, this.compositeRT)
        break
      }

      case 'person': {
        // 5. фигура
        const u = this.personMat.uniforms
        u.tVideo.value = opts.person
        u.tLut.value = opts.lut
        u.uLutSize.value = opts.lutSize
        u.tWrap.value = this.wrapRT_A.texture
        u.tMean.value = this.meanRT.texture
        u.uOpacity.value = opts.mirrorOpacity
        u.uLutOn.value = 0 // LUT теперь whole-frame (стадия unifyLut), не на person
        u.uWrapOn.value = opts.toggles.wrap ? 1 : 0
        u.uColorMatchOn.value = opts.toggles.colorMatch ? 1 : 0
        u.uShadeDirX.value = -opts.lightDirX // ключ слева (dirX<0) → левый бок ярче
        u.uUvScale.value.set(sx, sy)
        this.pass(this.personMat, this.compositeRT)
        break
      }

      case 'unifyLut': {
        // 5.5 whole-frame LUT: компонуем весь кадр одной интерьерной текстурой
        // (комната + тень + человек). Пинг-понг через shadowRT2 (свободен — тени
        // отработали), блит обратно в compositeRT → bloom извлекается из грейда.
        const u = this.unifyMat.uniforms
        u.tSrc.value = this.compositeRT.texture
        u.tLut.value = opts.lut
        u.uLutSize.value = opts.lutSize
        u.uLutStrength.value = opts.look.unify.lutStrength
        this.pass(this.unifyMat, this.shadowRT2)
        this.blitMat.uniforms.tSrc.value = this.shadowRT2.texture
        this.pass(this.blitMat, this.compositeRT)
        break
      }

      case 'bloom': {
        // 5б. Bloom: яркие зоны (лампы/окна/LED) → размытие (¼-res, переиспользуем wrapRT) →
        // аддитивно в финальном пассе. Общий буфер — свечение поверх всего композита.
        this.bloomBrightMat.uniforms.tSrc.value = this.compositeRT.texture
        this.pass(this.bloomBrightMat, this.wrapRT_A)
        const bt = new THREE.Vector2(1 / this.wrapRT_A.width, 1 / this.wrapRT_A.height)
        this.blurMat.uniforms.tSrc.value = this.wrapRT_A.texture
        this.blurMat.uniforms.uDir.value.set(bt.x, 0)
        this.pass(this.blurMat, this.wrapRT_B)
        this.blurMat.uniforms.tSrc.value = this.wrapRT_B.texture
        this.blurMat.uniforms.uDir.value.set(0, bt.y)
        this.pass(this.blurMat, this.wrapRT_A)
        this.grainMat.uniforms.tBloom.value = this.wrapRT_A.texture
        break
      }

      case 'grainPresent': {
        // uBloomOn присваивается ВСЕГДА (вне bloom-условия — было до зерна каждый кадр)
        this.grainMat.uniforms.uBloomOn.value = opts.toggles.bloom ? 1 : 0
        // 6. финальное зерно на весь кадр: compositeRT → экран
        this.renderer.clear()
        this.grainMat.uniforms.tSrc.value = this.compositeRT.texture
        this.grainMat.uniforms.uGrainOn.value = opts.toggles.grain ? 1 : 0
        this.grainMat.uniforms.uTime.value = opts.timeSec
        this.pass(this.grainMat, null)
        break
      }

      case 'fadeCurtain': {
        // 7. шторка смены миров (поверх зерна)
        this.fadeMat.opacity = opts.fade
        this.pass(this.fadeMat, null)
        break
      }
    }
  }
}
