import * as THREE from 'three'
import { SCENE_CONFIG } from './config'
import { makeDepthPhotoMesh } from './depthPhoto'

// Экран = выход на балкон: широкое фото вечернего города как 2.5D-задник.
// Параллакс делает сам снимок: перила балкона на переднем плане (по карте
// глубины) сдвигаются относительно далёкого города. Никакой рисованной рамы —
// всё, что видно, настоящее фото.
export async function buildWindowScene(): Promise<THREE.Scene> {
  const scene = new THREE.Scene()

  // Размер задника: с запасом, чтобы крайние позиции головы не выходили
  // за фото. Дальний план на -200 см, перила выходят на ~ -60 см.
  const { url, depthUrl, aspect } = SCENE_CONFIG.cityView
  const widthCm = 560
  const backdrop = await makeDepthPhotoMesh({
    photoUrl: url,
    depthUrl,
    widthCm,
    heightCm: widthCm / aspect,
    zCm: -200,
    depthAmountCm: 140,
    // Центр чуть ниже уровня глаз: горизонт города ~ на уровне взгляда,
    // перила — в нижней части кадра
    yCm: -20,
  })
  scene.add(backdrop)

  return scene
}
