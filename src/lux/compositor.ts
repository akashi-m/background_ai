// Композитор Lux (спека §4): мир → RT → экран; затем тень, фигура
// (SBS-распаковка + LUT + light wrap + зерно), фейд смены миров.
// Light wrap берёт уменьшенную размытую копию RT фона.

import * as THREE from 'three'

import { LUX_CONFIG } from './config'
import { makeMultiplyBlitMat, makeBakedShadowMat } from './multiplyBlit'
import type { ShadowEllipse } from './shadow'
import type { ShadowCamera } from './shadowGeom'
import { ShadowScene3D } from './shadowScene3D'

// Якорь «ступней» бейка в плейт-UV (проекция стойки [4.3,2.5,0]); база следует за feetUV.
// Тюнятся по живой приёмке (флип/сдвиг — одна правка).
const BAKED_FEET_U = 0.233
const BAKED_FEET_V = 0.161
const BAKED_RAISE = 0.05 // поднять базу на 5% вверх (юзер)
// Прокси — БЛЕДНЫЙ живой слой ПОВЕРХ запечённой базы (артикуляция рук/ног). Фаза 2 (юзер).
const PROXY_SHADOW_ENABLED = true

export interface HarmonizeToggles {
  lut: boolean
  wrap: boolean
  shadow: boolean
  grain: boolean
  colorMatch: boolean
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
  private meanRT: THREE.WebGLRenderTarget // 1×1 — средний цвет сцены (цвет-матч)
  private compositeRT: THREE.WebGLRenderTarget // весь композит до зерна
  private shadowRT: THREE.WebGLRenderTarget // целевой RT физической тени (read+write split)
  private shadowRT2: THREE.WebGLRenderTarget // temp для multiply-blit read+write split (B1.9)
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private passScene = new THREE.Scene()
  private passMeshes = new Map<THREE.Material, THREE.Mesh>() // кэш — без аллокаций в кадре

  private blitMat: THREE.ShaderMaterial
  private blurMat: THREE.ShaderMaterial
  private meanMat: THREE.ShaderMaterial
  private grainMat: THREE.ShaderMaterial
  private coverMat: THREE.ShaderMaterial // flat-фон: cover-fit плейт без 3D-камеры
  private slideMat: THREE.ShaderMaterial
  private personMat: THREE.ShaderMaterial
  private groundShadowMat: THREE.ShaderMaterial // силуэтная контактная тень у ног
  private roomShadowMat: THREE.ShaderMaterial // физическая тень по мировым координатам комнаты
  private blobMat: THREE.ShaderMaterial // контактная «тень-капля», приклеена к ступням
  private multiplyBlitMat: THREE.ShaderMaterial // multiply-blit physical-тени (B1.9 wiring)
  private bakedShadowMat: THREE.ShaderMaterial // Фаза 1: запечённая Blender-база
  private fadeMat: THREE.MeshBasicMaterial
  private shadowScene3D: ShadowScene3D | null = null // B1: реальный 3D-рендер прокси-тени (lazy)

  constructor(
    private renderer: THREE.WebGLRenderer,
    width: number,
    height: number,
    tuning: {
      wrapStrength: number; grainAmount: number; feather: [number, number]
      colorMatch: { cast: number; exposure: number }; shadeAmount: number; erode: number
    },
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
        tSrc: { value: null }, uGrain: { value: tuning.grainAmount },
        uGrainOn: { value: 1 }, uTime: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tSrc;
        uniform float uGrain; uniform float uGrainOn; uniform float uTime;
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7)) + uTime) * 43758.5453);
        }
        void main() {
          vec3 c = texture2D(tSrc, vUv).rgb;
          if (uGrainOn > 0.5) c += (hash(gl_FragCoord.xy) - 0.5) * uGrain;
          gl_FragColor = vec4(c, 1.0);
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
        uFeather: { value: new THREE.Vector2(tuning.feather[0], tuning.feather[1]) },
        uErode: { value: tuning.erode }, // эрозия альфы (UV) — срезает гало-бахрому RVM
        uWrapStrength: { value: tuning.wrapStrength },
        uCast: { value: tuning.colorMatch.cast },
        uExp: { value: tuning.colorMatch.exposure },
        uShade: { value: tuning.shadeAmount },
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
          vec2 av = vec2(0.5 + uvm.x * 0.5, uvm.y);
          float a = texture(tVideo, av).r;
          a = min(a, texture(tVideo, av + vec2(uErode, 0.0)).r);
          a = min(a, texture(tVideo, av + vec2(-uErode, 0.0)).r);
          a = min(a, texture(tVideo, av + vec2(0.0, uErode)).r);
          a = min(a, texture(tVideo, av + vec2(0.0, -uErode)).r);
          a = smoothstep(uFeather.x, uFeather.y, a);

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

    // Физическая тень: для каждого пикселя комнаты знаем его МИРОВУЮ 3D-позицию
    // (запечённая EXR worldPos). Кастуем луч из этой точки к каждой лампе; если
    // луч пересекает силуэт-билборд человека (плоскость в точке ног F, высотой H,
    // лицом к камере) — пиксель в тени → затемняем фон. Ложится корректно на пол,
    // мебель и стены по их реальной глубине.
    this.roomShadowMat = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, glslVersion: THREE.GLSL3,
      uniforms: {
        tBg: { value: null }, tWorld: { value: null }, tVideo: { value: null },
        uUvScale: { value: new THREE.Vector2(1, 1) },
        uVideoAspect: { value: 0.5625 },
        uF: { value: new THREE.Vector3() }, uH: { value: 1.7 },
        uCamPos: { value: new THREE.Vector3() },
        uLamp0: { value: new THREE.Vector3() }, uLamp1: { value: new THREE.Vector3() }, uLamp2: { value: new THREE.Vector3() },
        uW: { value: new THREE.Vector3(1, 0, 0) },
        uStrength: { value: 0.4 }, uBias: { value: 0.005 }, uSoft: { value: 1.0 },
        uOpacity: { value: 0 }, uNLamps: { value: 0 },
      },
      vertexShader: VERT3,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv; out vec4 fragColor;
        uniform sampler2D tBg, tWorld, tVideo;
        uniform vec2 uUvScale;
        uniform vec3 uF, uCamPos, uLamp0, uLamp1, uLamp2, uW;
        uniform float uH, uStrength, uBias, uOpacity, uNLamps, uVideoAspect, uSoft;

        // pen — масштаб полутени (PCSS: растёт с расстоянием окклюдер→приёмник)
        float silAlpha(vec3 P, float pen) {
          vec3 n = normalize(vec3(uCamPos.xy - uF.xy, 0.0));   // нормаль билборда (к камере, горизонт.)
          vec3 tang = normalize(cross(vec3(0.0, 0.0, 1.0), n)); // касательная (вбок)
          float u = dot(P - uF, tang);
          float v = (P.z - uF.z) / max(uH, 0.01);              // 0 ступни .. 1 макушка
          if (v < 0.0 || v > 1.0) return 0.0;
          float halfW = uH * uVideoAspect * 0.5;               // ширина билборда = рост × аспект
          float su = 0.5 + u / max(2.0 * halfW, 0.01);
          // PCF-ядро шириной e: penumbra = база × uSoft × pen(расстояние)
          float e = 0.012 * uSoft * pen;
          float a = 0.0;
          for (int i = -2; i <= 2; i++) {
            for (int j = -2; j <= 2; j++) {
              float sj = clamp(su + float(i) * e, 0.0, 1.0);
              float vj = clamp(v + float(j) * e, 0.0, 1.0);
              a += texture(tVideo, vec2(0.5 + (1.0 - sj) * 0.5, vj)).r; // флип + правая половина SBS
            }
          }
          return a / 25.0;
        }

        float shadowFromLamp(vec3 Pw, vec3 L) {
          vec3 n = normalize(vec3(uCamPos.xy - uF.xy, 0.0));
          vec3 dir = L - Pw;
          float denom = dot(dir, n);
          if (abs(denom) < 1e-4) return 0.0;
          float tHit = dot(uF - Pw, n) / denom;
          if (tHit <= uBias || tHit >= 1.0) return 0.0;
          vec3 hit = Pw + dir * tHit;
          // PCSS: чем дальше тело от пола по лучу (больше tHit), тем шире полутень
          return silAlpha(hit, 1.0 + tHit * 6.0);
        }

        void main() {
          vec3 bg = texture(tBg, vUv).rgb;
          vec2 wuv = (vUv - 0.5) * uUvScale + 0.5;
          vec3 Pw = texture(tWorld, wuv).rgb;
          float s = 0.0;
          if (uNLamps > 0.5) s += shadowFromLamp(Pw, uLamp0) * uW.x;
          if (uNLamps > 1.5) s += shadowFromLamp(Pw, uLamp1) * uW.y;
          if (uNLamps > 2.5) s += shadowFromLamp(Pw, uLamp2) * uW.z;
          s = clamp(s, 0.0, 1.0);
          bg *= (1.0 - uStrength * s * uOpacity);
          fragColor = vec4(bg, 1.0);
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

  render(opts: {
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
  }): void {
    const mirrorVisible = opts.mirrorOpacity > 0.001

    // 1. мир → RT (только когда зеркало видно)
    if (mirrorVisible) {
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
    }

    // 2. слои композита собираем в compositeRT (зерно — финальным пассом)
    this.renderer.setRenderTarget(this.compositeRT)
    this.renderer.clear()
    this.renderer.setRenderTarget(null)
    if (mirrorVisible) {
      this.blitMat.uniforms.tSrc.value = this.sceneRT.texture
      this.pass(this.blitMat, this.compositeRT)
    }

    // 3. слайдшоу IDLE (кроссфейдится с зеркалом через visible)
    if (opts.slides.visible > 0.001 && opts.slides.a) {
      this.slideMat.uniforms.tA.value = opts.slides.a
      this.slideMat.uniforms.tB.value = opts.slides.b ?? opts.slides.a
      this.slideMat.uniforms.uMix.value = opts.slides.mix
      this.slideMat.uniforms.uVisible.value = opts.slides.visible
      this.pass(this.slideMat, this.compositeRT)
    }

    // cover-fit фигуры (общий масштаб для тени и фигуры)
    let sx = 1, sy = 1
    if (opts.personAspect) {
      const va = opts.personAspect
      const ca = opts.canvasAspect
      if (ca > va) sy = va / ca
      else sx = ca / va
    }

    // 4. тень: физическая (по мировым координатам комнаты) или фолбэк-силуэт.
    // Физический пасс читает compositeRT (там уже лежит фон), пишет в shadowRT,
    // затем блитит shadowRT обратно в compositeRT (read+write одного RT недопустим).
    // Фолбэк — силуэтная контактная тень ПЕРЕД фигурой (фигура закроет её везде,
    // кроме зоны у ступней → мягкое пятно по форме стоп, без привязки к ногам).
    if (mirrorVisible && opts.toggles.shadow && opts.person) {
      if (opts.shadowData && opts.personFloor) {
        // Фаза 1: запечённая Blender-база (приоритет). Привязка к ступням — сдвигаем маску так,
        // чтобы её «ноги» легли в живые feetUV. Софт/тон/контакты уже в бейке (не пересинтез).
        if (opts.shadowData.bakedShadow) {
          const bsu = this.bakedShadowMat.uniforms
          bsu.tBg.value = this.compositeRT.texture
          bsu.tBaked.value = opts.shadowData.bakedShadow
          bsu.uUvScale.value.copy(this.coverMat.uniforms.uUvScale.value)
          // привязка к ступням: сдвиг маски так, чтобы «ноги» бейка легли в живые feetUV
          // (вид тени — как есть из Blender; двигаем только позицию). Нет feetUV → нативно.
          if (opts.feetUV) {
            bsu.uOffset.value.set(opts.feetUV.u - BAKED_FEET_U, opts.feetUV.v - BAKED_FEET_V + BAKED_RAISE)
          } else {
            bsu.uOffset.value.set(0, BAKED_RAISE)
          }
          this.pass(this.bakedShadowMat, this.shadowRT2)
          this.blitMat.uniforms.tSrc.value = this.shadowRT2.texture
          this.pass(this.blitMat, this.compositeRT)
        }
        // Фаза 2: прокси — БЛЕДНЫЙ живой слой ПОВЕРХ базы (артикуляция рук/ног), идёт ВМЕСТЕ с базой.
        if (PROXY_SHADOW_ENABLED && opts.pose) {
          // proxy-тень — ТОЛЬКО при сглаженной gated позе; нет позы → не рисуем (не «замерзает», C.6).
          if (!this.shadowScene3D) {
            this.shadowScene3D = new ShadowScene3D(
              { lamps: opts.shadowData.lamps, camera: opts.shadowData.camera, floorZ: opts.shadowData.floorZ },
              this.renderer,
            )
          }
          this.shadowScene3D.proxyRig.update(
            opts.pose.world,
            new THREE.Vector3(opts.personFloor.F[0], opts.personFloor.F[1], opts.personFloor.F[2]),
            opts.personFloor.H,
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
          mbu.uCenterDark.value = 0.12
          mbu.uEdgeDark.value = 0.03
          mbu.uBlur.value = 0.014
          // вырез прокси-тени у ног (контакт-стопу держит блоб). Центр = САМИ ступни (без +0.04
          // подъёма блоба — стопа прокси ниже), радиус щедрый, чтобы убрать остаток следа.
          if (opts.feetUV) {
            const cs = this.coverMat.uniforms.uUvScale.value
            mbu.uFeetCut.value.set(
              (opts.feetUV.u - 0.5) / cs.x + 0.5,
              (opts.feetUV.v - 0.5) / cs.y + 0.5,
            )
            mbu.uFeetCutR.value = 0.16
          } else {
            mbu.uFeetCutR.value = 0.0
          }
          this.pass(this.multiplyBlitMat, this.shadowRT2)
          this.blitMat.uniforms.tSrc.value = this.shadowRT2.texture
          this.pass(this.blitMat, this.compositeRT)
        }

        // (B1: заменено 3D-рендером выше; v1 roomShadowMat сохранён как fallback —
        //  восстанавливается в D2-лестнице. Здесь обёрнут if(false) → код жив, но не исполняется.)
        if (false as boolean) {
          const u = this.roomShadowMat.uniforms
          u.tBg.value = this.compositeRT.texture
          u.tWorld.value = opts.shadowData.worldPos
          u.tVideo.value = opts.person
          u.uUvScale.value.copy(this.coverMat.uniforms.uUvScale.value)
          u.uVideoAspect.value = opts.personAspect ?? 0.5625
          u.uF.value.set(opts.personFloor.F[0], opts.personFloor.F[1], opts.personFloor.F[2])
          u.uH.value = opts.personFloor.H
          u.uCamPos.value.set(opts.shadowData.camera.pos[0], opts.shadowData.camera.pos[1], opts.shadowData.camera.pos[2])
          const lamps = opts.shadowData.lamps
          u.uNLamps.value = Math.min(3, lamps.length)
          if (lamps[0]) u.uLamp0.value.set(lamps[0].pos[0], lamps[0].pos[1], lamps[0].pos[2])
          if (lamps[1]) u.uLamp1.value.set(lamps[1].pos[0], lamps[1].pos[1], lamps[1].pos[2])
          if (lamps[2]) u.uLamp2.value.set(lamps[2].pos[0], lamps[2].pos[1], lamps[2].pos[2])
          u.uW.value.set(lamps[0]?.weight ?? 0, lamps[1]?.weight ?? 0, lamps[2]?.weight ?? 0)
          u.uStrength.value = opts.shadowCfg.strength
          u.uBias.value = opts.shadowCfg.bias
          u.uSoft.value = opts.shadowCfg.softness
          u.uOpacity.value = opts.mirrorOpacity
          this.pass(this.roomShadowMat, this.shadowRT)
          this.blitMat.uniforms.tSrc.value = this.shadowRT.texture
          this.pass(this.blitMat, this.compositeRT)
        }
      } else {
        const g = this.groundShadowMat.uniforms
        g.tVideo.value = opts.person
        g.uUvScale.value.set(sx, sy)
        g.uOpacity.value = opts.shadowStrength * opts.mirrorOpacity
        g.uLightX.value = opts.lightDirX * 0.015 // лёгкий снос по ключу (реальная почти вертикальна)
        this.pass(this.groundShadowMat, this.compositeRT)
      }
      // 4б. контактная «тень-капля» — ВСЕГДА, приклеена к экранным ступням
      if (opts.feetUV) {
        const b = this.blobMat.uniforms
        b.tBg.value = this.compositeRT.texture
        b.uCenter.value.set((opts.feetUV.u - 0.5) / sx + 0.5, (opts.feetUV.v - 0.5) / sy + 0.5 + 0.04) // 0.06→0.04: ниже на 2% (юзер)
        const rx = (opts.feetUV.halfW / sx) * 1.0
        b.uRadius.value.set(rx, rx * 0.3)
        b.uOpacity.value = 0.36 * opts.mirrorOpacity // непрозрачность блоба = 0.36 (юзер)
        this.pass(this.blobMat, this.shadowRT)
        this.blitMat.uniforms.tSrc.value = this.shadowRT.texture
        this.pass(this.blitMat, this.compositeRT)
      }
    }

    // 5. фигура
    if (mirrorVisible && opts.person) {
      const u = this.personMat.uniforms
      u.tVideo.value = opts.person
      u.tLut.value = opts.lut
      u.uLutSize.value = opts.lutSize
      u.tWrap.value = this.wrapRT_A.texture
      u.tMean.value = this.meanRT.texture
      u.uOpacity.value = opts.mirrorOpacity
      u.uLutOn.value = opts.toggles.lut ? 1 : 0
      u.uWrapOn.value = opts.toggles.wrap ? 1 : 0
      u.uColorMatchOn.value = opts.toggles.colorMatch ? 1 : 0
      u.uShadeDirX.value = -opts.lightDirX // ключ слева (dirX<0) → левый бок ярче
      u.uUvScale.value.set(sx, sy)
      this.pass(this.personMat, this.compositeRT)
    }

    // 6. финальное зерно на весь кадр: compositeRT → экран
    this.renderer.clear()
    this.grainMat.uniforms.tSrc.value = this.compositeRT.texture
    this.grainMat.uniforms.uGrainOn.value = opts.toggles.grain ? 1 : 0
    this.grainMat.uniforms.uTime.value = opts.timeSec
    this.pass(this.grainMat, null)

    // 7. шторка смены миров (поверх зерна)
    if (opts.fade > 0.001) {
      this.fadeMat.opacity = opts.fade
      this.pass(this.fadeMat, null)
    }
  }
}
