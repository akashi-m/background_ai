import * as THREE from 'three'

// «2.5D-фото»: плоскость, вершины которой выдвигаются к зрителю по карте глубины
// (светлее = ближе). Эффект как у «3D-фото» в соцсетях: при движении головы
// ближние объекты сдвигаются сильнее дальних — реальное фото оживает.
// Карты глубины генерируются заранее: node scripts/gen-depth.mjs <фото> <выход>.
//
// Текстуры грузим БЕЗ colorSpace: ShaderMaterial пишет в буфер как есть,
// и «сырой» sRGB фотографии — ровно то, что должно попасть на экран.

export interface DepthPhotoOptions {
  photoUrl: string
  depthUrl: string
  widthCm: number       // ширина плоскости, см
  heightCm: number
  zCm: number           // глубина ДАЛЬНЕГО плана (отрицательная)
  depthAmountCm: number // насколько ближние участки выдвигаются к зрителю
  yCm?: number
}

const SEGMENTS = 256 // плотность сетки смещения

export async function makeDepthPhotoMesh(opts: DepthPhotoOptions): Promise<THREE.Mesh> {
  const loader = new THREE.TextureLoader()
  const load = (url: string) =>
    loader.loadAsync(url).catch(() => { throw new Error('Не загрузился ассет: ' + url) })
  const [photo, depth] = await Promise.all([load(opts.photoUrl), load(opts.depthUrl)])

  const geo = new THREE.PlaneGeometry(opts.widthCm, opts.heightCm, SEGMENTS, SEGMENTS)
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: photo },
      uDepth: { value: depth },
      uAmount: { value: opts.depthAmountCm },
    },
    vertexShader: /* glsl */ `
      uniform sampler2D uDepth;
      uniform float uAmount;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        float d = texture2D(uDepth, uv).r; // 1 — близко, 0 — далеко
        vec3 p = position;
        p.z += d * uAmount; // ближние пиксели — к зрителю
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vUv;
      void main() { gl_FragColor = vec4(texture2D(uMap, vUv).rgb, 1.0); }
    `,
  })

  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.set(0, opts.yCm ?? 0, opts.zCm)
  return mesh
}
