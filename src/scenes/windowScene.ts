import * as THREE from 'three'
import { SCENE_CONFIG } from './config'
import { makeDepthPhotoMesh, fitCoverCm } from './depthPhoto'

// Экран = выход на балкон: широкое фото вечернего города как 2.5D-задник.
// Параллакс делает сам снимок: перила балкона на переднем плане (по карте
// глубины) сдвигаются относительно далёкого города. Никакой рисованной рамы —
// всё, что видно, настоящее фото.
export async function buildWindowScene(screenWcm: number, screenHcm: number): Promise<THREE.Scene> {
  const scene = new THREE.Scene()

  // Фото подгоняется под экран (cover-fit, 21:9 шире экрана — бока в запас
  // параллаксу). Дальний план на -90 см, перила выходят на ~ -20 см.
  const { url, depthUrl, aspect } = SCENE_CONFIG.cityView
  const Z = -90
  const fit = fitCoverCm(aspect, Z, screenWcm, screenHcm, 1.2)
  const backdrop = await makeDepthPhotoMesh({
    photoUrl: url,
    depthUrl,
    widthCm: fit.widthCm,
    heightCm: fit.heightCm,
    zCm: Z,
    depthAmountCm: 70,
  })
  scene.add(backdrop)

  return scene
}
