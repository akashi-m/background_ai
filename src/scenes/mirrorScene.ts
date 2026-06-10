import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { SCENE_CONFIG } from './config'
import { buildBedroom } from './bedroom'
import { makeDepthPhotoMesh } from './depthPhoto'

// Сцена режима «Зеркало». Приоритет:
//  1. GLTF-интерьер заказчика (если задан)
//  2. реальное фото комнаты с 2.5D-параллаксом (mirrorBackground: 'photo')
//  3. процедурная спальня (bedroom.ts)
export async function buildMirrorScene(): Promise<THREE.Scene> {
  const scene = new THREE.Scene()

  if (SCENE_CONFIG.interiorGltfUrl) {
    const gltf = await new GLTFLoader().loadAsync(SCENE_CONFIG.interiorGltfUrl)
    scene.add(gltf.scene)
    scene.add(new THREE.AmbientLight(0xffffff, 0.5))
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.2)
    sun.position.set(100, 200, 100)
    scene.add(sun)
  } else if (SCENE_CONFIG.mirrorBackground === 'photo') {
    // Задник за спиной посетителя: ширина с запасом, чтобы крайние позиции
    // головы не выходили за фото; дальний план на -280 см, ближний (кровать,
    // растение) выдвигается на ~140 см к зрителю.
    const { url, depthUrl, aspect } = SCENE_CONFIG.photoRoom
    const widthCm = 500
    const photo = await makeDepthPhotoMesh({
      photoUrl: url,
      depthUrl,
      widthCm,
      heightCm: widthCm / aspect,
      zCm: -280,
      depthAmountCm: 140,
    })
    scene.add(photo) // шейдер не использует свет — фото уже «запечено»
  } else {
    await buildBedroom(scene) // спальня приносит свой свет
  }

  return scene
}
