import * as THREE from 'three'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import type { WorldMeta } from '../app/worldMeta'
import { makeDepthPhotoMesh, fitCoverCm } from './depthPhoto'

// Мир, собранный из папки worlds/<имя>/.
// scene → dolly (анимируется въездом) → root (выравнивание из meta.transform).
export interface BuiltWorld {
  scene: THREE.Scene
  dolly: THREE.Group
  root: THREE.Group
  meta: WorldMeta
}

async function assertExists(url: string): Promise<void> {
  const res = await fetch(url, { method: 'HEAD' })
  if (!res.ok) throw new Error(`Не загрузился ассет: ${url} (HTTP ${res.status})`)
}

export async function buildWorld(
  baseUrl: string, // '/assets/worlds/bedroom/'
  meta: WorldMeta,
  screenWcm: number,
  screenHcm: number,
  renderer: THREE.WebGLRenderer,
): Promise<BuiltWorld> {
  const scene = new THREE.Scene()
  const dolly = new THREE.Group()
  scene.add(dolly)
  const root = new THREE.Group()
  root.position.set(...meta.transform.position)
  root.rotation.y = (meta.transform.rotationYDeg * Math.PI) / 180
  root.scale.setScalar(meta.transform.scale)
  dolly.add(root)

  if (meta.format === 'splat') {
    const url = baseUrl + meta.file
    await assertExists(url)
    // SparkRenderer должен лежать в той сцене, которую рендерим
    scene.add(new SparkRenderer({ renderer }))
    root.add(new SplatMesh({ url })) // Spark грузит и стримит сам (LOD)
  } else {
    const fit = fitCoverCm(meta.aspect!, -60, screenWcm, screenHcm)
    const mesh = await makeDepthPhotoMesh({
      photoUrl: baseUrl + meta.file,
      depthUrl: baseUrl + meta.depthFile!,
      widthCm: fit.widthCm,
      heightCm: fit.heightCm,
      zCm: -60,
      depthAmountCm: 28,
    })
    root.add(mesh)
  }

  return { scene, dolly, root, meta }
}
