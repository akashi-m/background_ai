// 3D-сцена physical-тени (spec §4): невидимый прокси-кастер + box/EXR-приёмник,
// лампы PointLight (castShadow только Key), камера запечена из lights.json.
// Рендерится в shadowRT, multiply-blit на compositeRT (compositor.ts).
// Базис: Blender Z-up во всей сцене (камера up=(0,0,1)); без координатного свопа.
import * as THREE from 'three'

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
