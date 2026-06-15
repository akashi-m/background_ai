import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { boxReceiver, bakedShadowCamera, staticProxy } from './shadowScene3D'
import type { ShadowCamera } from './shadowGeom'

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

describe('bakedShadowCamera', () => {
  const cam: ShadowCamera = {
    pos: [0, -5, 1.6],       // Blender Z-up: камера сзади (−Y), высота Z=1.6
    target: [0, 0, 1.6],     // смотрит в начало по +Y
    fovY: Math.PI / 3,       // 60° в радианах
    aspect: 0.5625,          // 9:16 портрет
  }

  it('fov переведён в градусы из радиан fovY', () => {
    expect(bakedShadowCamera(cam).fov).toBeCloseTo(60, 4)
  })

  it('aspect взят из camera.aspect', () => {
    expect(bakedShadowCamera(cam).aspect).toBeCloseTo(0.5625, 6)
  })

  it('matrixAutoUpdate выключен (матрица запечена)', () => {
    expect(bakedShadowCamera(cam).matrixAutoUpdate).toBe(false)
  })

  it('запечённая matrixWorld ставит камеру в RAW Blender Z-up позицию (без свопа)', () => {
    const c = bakedShadowCamera(cam)
    const p = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld)
    expect(p.x).toBeCloseTo(0, 5)
    expect(p.y).toBeCloseTo(-5, 5)
    expect(p.z).toBeCloseTo(1.6, 5)
  })

  it('камера смотрит на target (forward -Z указывает на target в Z-up базисе)', () => {
    const c = bakedShadowCamera(cam)
    const eye = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld)
    const tgt = new THREE.Vector3(0, 0, 1.6) // raw Z-up
    const wantDir = tgt.clone().sub(eye).normalize()
    const fwd = new THREE.Vector3(0, 0, -1).applyMatrix4(
      new THREE.Matrix4().extractRotation(c.matrixWorld),
    ).normalize()
    expect(fwd.dot(wantDir)).toBeCloseTo(1, 4)
  })
})

describe('staticProxy (B1 invisible caster)', () => {
  it('кастер: castShadow=true, visible=true (visible=false выкинул бы из shadow-pass)', () => {
    const g = staticProxy([0, 0, 0], 1.7)
    let meshes = 0
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        meshes++
        expect((o as THREE.Mesh).castShadow).toBe(true)
        expect(o.visible).toBe(true)
      }
    })
    expect(meshes).toBeGreaterThan(0)
  })

  it('невидимый каст: материал colorWrite=false, depthWrite=false', () => {
    const g = staticProxy([0, 0, 0], 1.7)
    g.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined
      if (m) {
        expect(m.colorWrite).toBe(false)
        expect(m.depthWrite).toBe(false)
      }
    })
  })

  it('корень группы стоит в RAW F (Blender Z-up, без свопа)', () => {
    const g = staticProxy([1, 2, 0.5], 1.7)
    expect(g.position.x).toBeCloseTo(1, 6)
    expect(g.position.y).toBeCloseTo(2, 6)
    expect(g.position.z).toBeCloseTo(0.5, 6)
  })

  it('высота прокси вдоль +Z: верх ≈ F.z + H, основание ≈ F.z', () => {
    const g = staticProxy([0, 0, 0], 1.8)
    g.updateMatrixWorld(true)
    const bbox = new THREE.Box3().setFromObject(g)
    expect(bbox.max.z).toBeGreaterThan(1.4)
    expect(bbox.max.z).toBeLessThanOrEqual(1.8 + 1e-3)
    expect(bbox.min.z).toBeCloseTo(0, 2)
  })
})
