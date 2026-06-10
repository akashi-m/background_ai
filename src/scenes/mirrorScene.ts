import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { SCENE_CONFIG } from './config'
import { buildBedroom } from './bedroom'

// Сцена режима «Зеркало»: GLTF-интерьер заказчика, если задан,
// иначе процедурная спальня по референсу (см. bedroom.ts).
export async function buildMirrorScene(): Promise<THREE.Scene> {
  const scene = new THREE.Scene()

  if (SCENE_CONFIG.interiorGltfUrl) {
    const gltf = await new GLTFLoader().loadAsync(SCENE_CONFIG.interiorGltfUrl)
    scene.add(gltf.scene)
    scene.add(new THREE.AmbientLight(0xffffff, 0.5))
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.2)
    sun.position.set(100, 200, 100)
    scene.add(sun)
  } else {
    await buildBedroom(scene) // спальня приносит свой свет
  }

  return scene
}
