import * as THREE from 'three'

// smoothstep как в GLSL (для числового зеркала шейдера).
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// Числовое зеркало затемнения multiplyBlitMat (юнит-тест модели без WebGL).
// shadowSample = texture(tShadow).r на БЕЛОМ clear: 1.0 вне тени, →0 в ядре.
// Возвращает скаляр dark ∈ [0..centerDark]: 0 = нет тени, centerDark = плотное ядро (умбра).
// dust опущен (детерминированный максимум 1.0). Цвет = mix(1, tint, dark) поканально.
export function multiplyShadowTerm(shadowSample: number, edgeDark: number, centerDark: number): number {
  const st = 1.0 - shadowSample                  // 0 свет .. 1 ядро
  const presence = smoothstep(0.02, 0.35, st)    // мягкий вход (вне тени → 0)
  const coreness = smoothstep(0.30, 0.85, st)    // ядро (умбра)
  return presence * (edgeDark + (centerDark - edgeDark) * coreness)
}

// Cover-fit выборка (зеркало coverMat): (uv-0.5)*scale+0.5.
export function coverUv(u: number, v: number, scaleX: number, scaleY: number): [number, number] {
  return [(u - 0.5) * scaleX + 0.5, (v - 0.5) * scaleY + 0.5]
}

const MB_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

// Фуллскрин multiply-blit: compositeRT(tBg) × shadowRT(tShadow), cover-fit кроп
// тени (uUvScale = coverMat) + потолок черноты (spec §4.4). GLSL1.
export function makeMultiplyBlitMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL1,
    uniforms: {
      tBg: { value: null }, tShadow: { value: null },
      uUvScale: { value: new THREE.Vector2(1, 1) },
      // (оставлены для совместимости с compositor-проводкой; формула — на uCenterDark/uEdgeDark)
      uShadowFloorK: { value: 0.7 }, uShadowStrength: { value: 0.5 },
      uCenterDark: { value: 0.5 },  // затемнение ЯДРА (умбра) — V1 «лёгкая» (выбор юзера)
      uEdgeDark: { value: 0.2 },    // затемнение КРАЯ (полутень) — мягкий выход
      uBlur: { value: 0.009 },      // радиус размытия маски тени (UV) — диффузный контур
      uShadowTint: { value: new THREE.Color(0.40, 0.35, 0.28) }, // тёплый тёмный (не чёрный)
    },
    vertexShader: MB_VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tBg; uniform sampler2D tShadow;
      uniform vec2 uUvScale; uniform float uShadowFloorK; uniform float uShadowStrength;
      uniform float uCenterDark; uniform float uEdgeDark; uniform float uBlur;
      uniform vec3 uShadowTint;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec2 cuv = (vUv - 0.5) * uUvScale + 0.5;
        // размытие маски тени (диффузный контур, без острых краёв): 4×4 box-тап
        float sh = 0.0;
        for (int j = 0; j < 4; j++) {
          for (int i = 0; i < 4; i++) {
            vec2 o = (vec2(float(i), float(j)) - 1.5) * uBlur;
            sh += texture2D(tShadow, cuv + o).r;
          }
        }
        sh /= 16.0;
        float st = 1.0 - sh;                                // 0 свет .. 1 ядро (размыто)
        float presence = smoothstep(0.02, 0.35, st);        // мягкий вход (вне тени → 0)
        float coreness = smoothstep(0.30, 0.85, st);        // ядро (умбра)
        float dust = mix(0.85, 1.0, hash(floor(cuv * 480.0)));
        float dark = presence * mix(uEdgeDark, uCenterDark, coreness) * dust;
        // multiply к тёплому тёмному (не к чёрному) — органично в интерьер
        vec3 mulf = mix(vec3(1.0), uShadowTint, dark);
        gl_FragColor = vec4(texture2D(tBg, cuv).rgb * mulf, 1.0);
      }
    `,
    depthTest: false,
  })
}
