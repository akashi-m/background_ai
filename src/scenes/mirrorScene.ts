import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { SCENE_CONFIG } from './config'
import { buildBedroom } from './bedroom'
import { makeDepthPhotoMesh, fitCoverCm } from './depthPhoto'

// Сцена режима «Комната». Приоритет:
//  1. GLTF-интерьер заказчика (если задан)
//  2. реальное фото комнаты с 2.5D-параллаксом (mirrorBackground: 'photo')
//  3. процедурная спальня (bedroom.ts)
export async function buildMirrorScene(screenWcm: number, screenHcm: number): Promise<THREE.Scene> {
  const scene = new THREE.Scene()

  if (SCENE_CONFIG.interiorGltfUrl) {
    const gltf = await new GLTFLoader().loadAsync(SCENE_CONFIG.interiorGltfUrl)
    scene.add(gltf.scene)
    scene.add(new THREE.AmbientLight(0xffffff, 0.5))
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.2)
    sun.position.set(100, 200, 100)
    scene.add(sun)
  } else if (SCENE_CONFIG.mirrorBackground === 'photo') {
    // Фото подгоняется под экран (cover-fit): весь кадр виден с нейтральной
    // позиции, запас по краям — на параллакс. Глубина даёт «жизнь»:
    // кровать/растение/тапки выдвигаются к зрителю на ~50 см.
    const { url, depthUrl, aspect } = SCENE_CONFIG.photoRoom
    const Z = -60
    const fit = fitCoverCm(aspect, Z, screenWcm, screenHcm)
    const photo = await makeDepthPhotoMesh({
      photoUrl: url,
      depthUrl,
      widthCm: fit.widthCm,
      heightCm: fit.heightCm,
      zCm: Z,
      depthAmountCm: 50,
    })
    scene.add(photo) // шейдер не использует свет — фото уже «запечено»
  } else {
    await buildBedroom(scene) // спальня приносит свой свет
  }

  return scene
}
