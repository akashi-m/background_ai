import * as THREE from 'three'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import type { WorldMeta } from '../app/worldMeta'
import { makeDepthPhotoMesh, fitCoverCm } from './depthPhoto'
import { loadAlignOverride } from '../debug/align'

// Мир, собранный из папки worlds/<имя>/.
// scene → dolly (анимируется въездом) → root (выравнивание из meta.transform).
export interface BuiltWorld {
  scene: THREE.Scene
  dolly: THREE.Group
  root: THREE.Group
  meta: WorldMeta
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

  // Незакоммиченное выравнивание из localStorage перекрывает meta.json
  const override = loadAlignOverride(baseUrl.split('/').filter(Boolean).pop()!)
  if (override) {
    root.position.set(...override.position)
    root.rotation.y = (override.rotationYDeg * Math.PI) / 180
    root.scale.setScalar(override.scale)
  }

  if (meta.format === 'splat') {
    const url = baseUrl + meta.file
    // SparkRenderer должен лежать в той сцене, которую рендерим
    scene.add(new SparkRenderer({ renderer }))
    const splat = new SplatMesh({ url })
    // Сплаты конвенционально Y-вниз (PLY/SPZ); переворачиваем в Y-вверх three.js.
    // Поворот мира вокруг Y из meta.transform применяется выше, на root.
    splat.quaternion.set(1, 0, 0, 0)
    root.add(splat)
    try {
      await splat.initialized
    } catch (e) {
      throw new Error(`Не загрузился ассет: ${url} (${e instanceof Error ? e.message : String(e)})`)
    }
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
