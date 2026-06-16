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
      uCenterDark: { value: 0.36 }, // затемнение ЯДРА (умбра) — ещё +10% прозрачности (юзер)
      uEdgeDark: { value: 0.072 },  // затемнение КРАЯ (полутень) — ещё +10% прозрачности (юзер)
      uBlur: { value: 0.009 },      // радиус размытия маски тени (UV) — диффузный контур
      uShadowTint: { value: new THREE.Color(0.40, 0.35, 0.28) }, // тёплый тёмный (не чёрный)
      // смещение маски тени в экранных UV: x>0 вправо, y>0 вверх. (-0.03,+0.05): 3% влево,
      // подъём к ступням как у блоба (0.06) минус опускание на 1% = 0.05.
      uShadowOffset: { value: new THREE.Vector2(-0.03, 0.05) },
    },
    vertexShader: MB_VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tBg; uniform sampler2D tShadow;
      uniform vec2 uUvScale; uniform float uShadowFloorK; uniform float uShadowStrength;
      uniform float uCenterDark; uniform float uEdgeDark; uniform float uBlur;
      uniform vec3 uShadowTint; uniform vec2 uShadowOffset;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec2 cuv = (vUv - 0.5) * uUvScale + 0.5;           // фон НЕ двигаем
        // смещение тени в экранных UV (x вправо, y вверх): сэмпл маски сдвинут противоходом
        vec2 scuv = cuv - uShadowOffset;
        // размытие маски тени (диффузный контур, без острых краёв): 4×4 box-тап
        float sh = 0.0;
        for (int j = 0; j < 4; j++) {
          for (int i = 0; i < 4; i++) {
            vec2 o = (vec2(float(i), float(j)) - 1.5) * uBlur;
            sh += texture2D(tShadow, scuv + o).r;
          }
        }
        sh /= 16.0;
        float st = 1.0 - sh;                                // 0 свет .. 1 ядро (размыто)
        float presence = smoothstep(0.02, 0.50, st);        // растянутый вход → полутень мягче/шире
        float coreness = smoothstep(0.45, 0.90, st);        // умбра ТУЖЕ: ядро только у контакта,
        //  всё растянутое (края + дальний хвост) спадает к uEdgeDark → дальше/края прозрачнее (п.2+3)
        float dust = mix(0.85, 1.0, hash(floor(vUv * 480.0))); // зерно по vUv — идентично блобу
        float dark = presence * mix(uEdgeDark, uCenterDark, coreness) * dust;
        // multiply к тёплому тёмному (не к чёрному) — органично в интерьер
        vec3 mulf = mix(vec3(1.0), uShadowTint, dark);
        gl_FragColor = vec4(texture2D(tBg, cuv).rgb * mulf, 1.0);
      }
    `,
    depthTest: false,
  })
}

// Запечённая база (Blender shadow-catcher) КАК ЕСТЬ (юзер: не менять/не улучшать).
// tBaked.a = покрытие тенью (0 нет .. 1 тень). Просто умножаем плейт на (1 - покрытие):
// весь софт/penumbra/тон/контакты — уже в бейке, ничего не пересинтезируем и не тонируем.
// uOffset/uUvScale — позиция/cover-fit. GLSL1.
export function makeBakedShadowMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL1,
    uniforms: {
      tBg: { value: null }, tBaked: { value: null },
      uUvScale: { value: new THREE.Vector2(1, 1) },
      uOffset: { value: new THREE.Vector2(0, 0) },
      uMaxShadow: { value: 0.5 }, // потолок черноты: контакты у стоп не уходят в чистый чёрный
      uFeetMask: { value: new THREE.Vector2(0.233, 0.161) }, // «ноги» в маске бейка (центр выреза)
      uCutR: { value: 0.12 }, // радиус выреза «под телом» (UV) — блоб подхватит контакт
      uCutFloor: { value: 0.17 }, // у стоп оставить ~17% тени (не в ноль) → мягкий стык с блобом
    },
    vertexShader: MB_VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tBg; uniform sampler2D tBaked;
      uniform vec2 uUvScale; uniform vec2 uOffset; uniform float uMaxShadow;
      uniform vec2 uFeetMask; uniform float uCutR; uniform float uCutFloor;
      void main() {
        vec2 cuv = (vUv - 0.5) * uUvScale + 0.5;       // фон
        vec2 suv = cuv - uOffset;                       // маску тени — опц. смещение (по умолч. 0)
        float sh = min(texture2D(tBaked, suv).a, uMaxShadow); // покрытие, но не в чистый чёрный
        // вырез зоны «под телом»: НЕ в ноль, а до uCutFloor (~17%) → плавный переход в блоб
        float cut = smoothstep(uCutR * 0.55, uCutR, distance(suv, uFeetMask));
        sh *= mix(uCutFloor, 1.0, cut);
        gl_FragColor = vec4(texture2D(tBg, cuv).rgb * (1.0 - sh), 1.0);
      }
    `,
    depthTest: false,
  })
}
