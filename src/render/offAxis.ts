import type { PerspectiveCamera } from 'three'

// Позиция глаз зрителя в см относительно ЦЕНТРА экрана.
// Оси: x — вправо (от зрителя), y — вверх, z — от экрана к зрителю (z > 0).
export interface EyeCm { x: number; y: number; z: number }

export interface FrustumCm { left: number; right: number; top: number; bottom: number }

// near=1 / far=1e5 даёт приемлемую точность глубины для геометрии до ~50 м;
// если появится far-field геометрия, соотношение near/far нужно пересмотреть.
const NEAR_CM = 1
const FAR_CM = 100000

// Generalized perspective projection (Kooima): экран — окно в мир,
// фрустум строится от глаза к физическим краям экрана.
// ВАЖНО: вызывающий код в render-цикле обязан зажимать eye.z (например, max(z, 20)),
// потому что глюки трекинга могут дать z ≤ 0 — функция выбросит исключение.
export function offAxisFrustum(eye: EyeCm, screenWcm: number, screenHcm: number, nearCm: number): FrustumCm {
  if (eye.z <= 0) throw new Error('eye.z должен быть > 0 (зритель перед экраном)')
  const s = nearCm / eye.z
  return {
    left: (-screenWcm / 2 - eye.x) * s,
    right: (screenWcm / 2 - eye.x) * s,
    bottom: (-screenHcm / 2 - eye.y) * s,
    top: (screenHcm / 2 - eye.y) * s,
  }
}

// Ставит камеру в позицию глаз и подменяет проекционную матрицу.
// ВАЖНО: камера должна быть прямым дочерним объектом сцены (без родителя);
// rotation.set(0,0,0) предполагает отсутствие родительского трансформа.
// ВАЖНО: не вызывать camera.updateProjectionMatrix() — она затрёт нашу матрицу.
export function applyOffAxis(camera: PerspectiveCamera, eye: EyeCm, screenWcm: number, screenHcm: number): void {
  const f = offAxisFrustum(eye, screenWcm, screenHcm, NEAR_CM)
  camera.near = NEAR_CM
  camera.far = FAR_CM
  camera.position.set(eye.x, eye.y, eye.z)
  camera.rotation.set(0, 0, 0) // всегда смотрим перпендикулярно экрану
  camera.projectionMatrix.makePerspective(f.left, f.right, f.top, f.bottom, NEAR_CM, FAR_CM)
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  camera.updateMatrixWorld()
}
