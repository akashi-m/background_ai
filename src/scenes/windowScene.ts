import * as THREE from 'three'
import { SCENE_CONFIG } from './config'
import { loadTextureCached } from './textures'

// Экран = окно квартиры: фото вечернего города как задник + рама у плоскости экрана.
// Рама — главный источник параллакса (город далеко, сдвигается слабо).
// Задник — ОБЫЧНОЕ фото (не панорама), поэтому плоскость, а не сфера.
export async function buildWindowScene(screenWcm: number, screenHcm: number): Promise<THREE.Scene> {
  const scene = new THREE.Scene()

  const tex = await loadTextureCached(SCENE_CONFIG.cityViewUrl)
  // Размер задника: должен покрывать обзор через «окно» при крайних позициях головы.
  // Глубина 180 см — компромисс: ближе = заметнее параллакс рамы, дальше = резче фото.
  const BACKDROP_Z = -180
  const BACKDROP_W = 400
  const BACKDROP_H = BACKDROP_W * (981 / 736) // аспект фото
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(BACKDROP_W, BACKDROP_H),
    new THREE.MeshBasicMaterial({ map: tex })
  )
  // Центр чуть ниже уровня глаз: линия горизонта города ~ на уровне взгляда,
  // балконные перила с фото остаются под нижней кромкой «окна».
  backdrop.position.set(0, -40, BACKDROP_Z)
  scene.add(backdrop)

  // Рама окна сразу за плоскостью экрана, размер из калибровки
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2e }) // тёмная, как в референсе
  const halfW = screenWcm / 2
  const halfH = screenHcm / 2
  const t = Math.max(1.5, screenWcm * 0.04) // толщина рамы, см — масштабируется с экраном
  const d = t                                // глубина брусков
  const bars: [number, number, number, number][] = [
    [screenWcm, t, 0, halfH - t / 2],    // верх
    [screenWcm, t, 0, -halfH + t / 2],   // низ
    [t, screenHcm, -halfW + t / 2, 0],   // лево
    [t, screenHcm, halfW - t / 2, 0],    // право
    [t * 0.6, screenHcm, 0, 0],          // средник вертикальный
    [screenWcm, t * 0.6, 0, 0],          // средник горизонтальный
  ]
  for (const [w, h, x, y] of bars) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat)
    bar.position.set(x, y, -d / 2 - 1) // сразу за «стеклом» (экран = z0)
    scene.add(bar)
  }
  // Подоконник: чуть шире проёма, целиком за стеклом
  const sill = new THREE.Mesh(new THREE.BoxGeometry(screenWcm * 1.05, t * 0.5, t * 3), frameMat)
  sill.position.set(0, -halfH + t * 0.25, -t * 1.5 - 1)
  scene.add(sill)

  scene.add(new THREE.AmbientLight(0xffffff, 1.0))
  return scene
}
