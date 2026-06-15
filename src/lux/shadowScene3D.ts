// 3D-сцена physical-тени (spec §4): невидимый прокси-кастер + box/EXR-приёмник,
// лампы PointLight (castShadow только Key), камера запечена из lights.json.
// Рендерится в shadowRT, multiply-blit на compositeRT (compositor.ts).
// Базис: Blender Z-up во всей сцене (камера up=(0,0,1)); без координатного свопа.
import * as THREE from 'three'
import type { ShadowCamera } from './shadowGeom'

// Box задаётся axis-aligned min/max в Blender Z-up мировых координатах.
export interface ReceiverBox { min: [number, number, number]; max: [number, number, number] }

// B1-приёмник (alignment-этап + fallback-пол): плоскость пола + box-прокси мебели.
// Материал ShadowMaterial: всюду прозрачен, рисует только тень-терм; receiveShadow.
export function boxReceiver(floorZ: number, boxes: ReceiverBox[]): THREE.Mesh[] {
  const mkMat = () => new THREE.ShadowMaterial({ color: 0x000000, transparent: true, opacity: 1 })

  // Пол: большая плоскость в Z=floorZ (Blender Z-up — плоскость в XY, нормаль +Z).
  const floorGeom = new THREE.PlaneGeometry(100, 100)
  const floor = new THREE.Mesh(floorGeom, mkMat())
  floor.position.set(0, 0, floorZ)
  floor.receiveShadow = true
  floor.castShadow = false

  const meshes: THREE.Mesh[] = [floor]
  for (const b of boxes) {
    const sx = b.max[0] - b.min[0]
    const sy = b.max[1] - b.min[1]
    const sz = b.max[2] - b.min[2]
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mkMat())
    mesh.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2)
    mesh.scale.set(sx, sy, sz)
    mesh.receiveShadow = true
    mesh.castShadow = false
    meshes.push(mesh)
  }
  return meshes
}

// Запечённая камера тени = ровно Blender-камера плейта (lights.json.camera).
// Базис: Blender Z-up во всей сцене → camera.up=(0,0,1), БЕЗ свопа координат
// (приёмник boxReceiver/EXR-mesh тоже в Z-up). matrixAutoUpdate=false: мировую
// матрицу собираем вручную (lookAt в Z-up), чтобы тень проецировалась в те же
// пиксели, что геометрия на плоском плейте (spec §4.3, reconcile §B.9).
export function bakedShadowCamera(cam: ShadowCamera): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(cam.fovY), cam.aspect, 0.05, 100)
  c.matrixAutoUpdate = false
  const eye = new THREE.Vector3(cam.pos[0], cam.pos[1], cam.pos[2])
  const tgt = new THREE.Vector3(cam.target[0], cam.target[1], cam.target[2])
  // lookAt строит ориентацию; up = Blender world-up = (0,0,1) (камера не закручена)
  const m = new THREE.Matrix4().lookAt(eye, tgt, new THREE.Vector3(0, 0, 1))
  m.setPosition(eye)
  c.matrix.copy(m)
  c.matrixWorld.copy(m)          // нет родителя → world = local
  c.matrixWorldNeedsUpdate = false
  c.updateProjectionMatrix()
  return c
}
