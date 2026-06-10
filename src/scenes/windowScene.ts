import * as THREE from 'three'
import { SCENE_CONFIG } from './config'
import { loadTextureCached } from './textures'

// Экран = окно квартиры: панорама города на сфере + рама близко к плоскости экрана.
// Рама — главный источник параллакса (панорама далеко, сдвигается слабо).
export async function buildWindowScene(): Promise<THREE.Scene> {
  const scene = new THREE.Scene()

  const cached = await loadTextureCached(SCENE_CONFIG.cityPanoramaUrl)
  // clone: общая загрузка/декод с mirrorScene, но своя GPU-текстура из-за другого mapping
  const tex = cached.clone()
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.needsUpdate = true
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(5000, 48, 32),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide })
  )
  scene.add(sky)

  // Рама окна сразу за плоскостью экрана (z = -4 см)
  const frameMat = new THREE.MeshLambertMaterial({ color: 0xf2efe9 })
  const bars: [number, number, number, number][] = [
    [400, 12, 0, 136],   // верх
    [400, 12, 0, -136],  // низ
    [12, 280, -194, 0],  // лево
    [12, 280, 194, 0],   // право
    [8, 280, 0, 0],      // средник вертикальный
    [400, 8, 0, 0],      // средник горизонтальный
  ]
  for (const [w, h, x, y] of bars) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 8), frameMat)
    bar.position.set(x, y, -4)
    scene.add(bar)
  }
  // Подоконник
  const sill = new THREE.Mesh(new THREE.BoxGeometry(420, 6, 30), frameMat)
  sill.position.set(0, -145, -10)
  scene.add(sill)

  scene.add(new THREE.AmbientLight(0xffffff, 1.0))
  return scene
}
