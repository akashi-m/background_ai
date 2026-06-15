import * as THREE from 'three'

// Числовое зеркало multiplyBlitMat (юнит-тест модели без WebGL).
// shadowSample = texture(tShadow).r на БЕЛОМ clear: 1.0 вне тени, →0 в тени.
export function multiplyShadowTerm(shadowSample: number, strength: number, floorK: number): number {
  const shadowTerm = 1.0 - shadowSample
  const floor = 1.0 - strength * floorK
  return 1.0 * (1 - shadowTerm) + floor * shadowTerm // mix(1, floor, shadowTerm)
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
      uShadowFloorK: { value: 0.7 }, uShadowStrength: { value: 0.5 },
    },
    vertexShader: MB_VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tBg; uniform sampler2D tShadow;
      uniform vec2 uUvScale; uniform float uShadowFloorK; uniform float uShadowStrength;
      void main() {
        vec2 cuv = (vUv - 0.5) * uUvScale + 0.5;
        float shadowTerm = 1.0 - texture2D(tShadow, cuv).r;
        float m = mix(1.0, 1.0 - uShadowStrength * uShadowFloorK, shadowTerm);
        gl_FragColor = vec4(texture2D(tBg, cuv).rgb * m, 1.0);
      }
    `,
    depthTest: false,
  })
}
