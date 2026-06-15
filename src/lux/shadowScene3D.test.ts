import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { boxReceiver } from './shadowScene3D'

describe('boxReceiver', () => {
  it('возвращает пол + по мешу на каждый box', () => {
    const meshes = boxReceiver(0, [
      { min: [-1, -1, 0], max: [1, 1, 0.5] },
      { min: [2, 0, 0], max: [3, 1, 2] },
    ])
    expect(meshes.length).toBe(3)
    meshes.forEach((m) => expect(m).toBeInstanceOf(THREE.Mesh))
  })

  it('все меши receiveShadow=true и НЕ castShadow (приёмник, не кастер)', () => {
    const meshes = boxReceiver(0, [{ min: [-1, -1, 0], max: [1, 1, 1] }])
    meshes.forEach((m) => {
      expect(m.receiveShadow).toBe(true)
      expect(m.castShadow).toBe(false)
    })
  })

  it('материал — ShadowMaterial (transparent), у всех мешей', () => {
    const meshes = boxReceiver(0, [{ min: [0, 0, 0], max: [1, 1, 1] }])
    meshes.forEach((m) => {
      expect(m.material).toBeInstanceOf(THREE.ShadowMaterial)
      expect((m.material as THREE.ShadowMaterial).transparent).toBe(true)
    })
  })

  it('пол лежит на floorZ (Z-up Blender-координаты): position.z == floorZ', () => {
    const [floor] = boxReceiver(2.5, [])
    expect(floor.position.z).toBeCloseTo(2.5, 6)
  })

  it('box центрирован в середине min/max и масштабирован по размеру', () => {
    const meshes = boxReceiver(0, [{ min: [2, 0, 0], max: [4, 2, 6] }])
    const box = meshes[1]
    expect(box.position.x).toBeCloseTo(3, 6)
    expect(box.position.y).toBeCloseTo(1, 6)
    expect(box.position.z).toBeCloseTo(3, 6)
    expect(box.scale.x).toBeCloseTo(2, 6)
    expect(box.scale.y).toBeCloseTo(2, 6)
    expect(box.scale.z).toBeCloseTo(6, 6)
  })
})
