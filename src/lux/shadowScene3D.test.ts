import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { boxReceiver, bakedShadowCamera, staticProxy, keyPointLights, ShadowScene3D } from './shadowScene3D'
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

describe('keyPointLights', () => {
  const lamps = [
    { pos: [1, 1, 2] as [number, number, number], weight: 0.4 },
    { pos: [-1, 2, 2.5] as [number, number, number], weight: 1.0 }, // Key (max weight)
    { pos: [0, -1, 2] as [number, number, number], weight: 0.6 },
  ]

  it('одна PointLight на каждую лампу', () => {
    const lights = keyPointLights(lamps)
    expect(lights.length).toBe(3)
    lights.forEach((l) => expect(l).toBeInstanceOf(THREE.PointLight))
  })

  it('castShadow=true ТОЛЬКО у лампы с максимальным weight (Key)', () => {
    const lights = keyPointLights(lamps)
    expect(lights[0].castShadow).toBe(false)
    expect(lights[1].castShadow).toBe(true)  // weight=1.0
    expect(lights[2].castShadow).toBe(false)
  })

  it('Key shadow: mapSize 2048, bias -0.0005, normalBias 0.03', () => {
    const key = keyPointLights(lamps).find((l) => l.castShadow)!
    expect(key.shadow.mapSize.width).toBe(2048)
    expect(key.shadow.mapSize.height).toBe(2048)
    expect(key.shadow.bias).toBeCloseTo(-0.0005, 6)
    expect(key.shadow.normalBias).toBeCloseTo(0.03, 6)
  })

  it('позиция лампы RAW Blender Z-up (без свопа); интенсивность ∝ weight', () => {
    const lights = keyPointLights(lamps)
    // lamps[1] RAW [-1,2,2.5] — без свопа
    expect(lights[1].position.x).toBeCloseTo(-1, 6)
    expect(lights[1].position.y).toBeCloseTo(2, 6)
    expect(lights[1].position.z).toBeCloseTo(2.5, 6)
    expect(lights[1].intensity).toBeGreaterThan(lights[0].intensity)
  })
})

describe('ShadowScene3D (B1 сборка)', () => {
  const shadowData = {
    lamps: [
      { pos: [1, 1, 2] as [number, number, number], weight: 1.0 },
      { pos: [-1, 2, 2] as [number, number, number], weight: 0.5 },
    ],
    camera: {
      pos: [0, -5, 1.6] as [number, number, number],
      target: [0, 0, 1.6] as [number, number, number],
      fovY: Math.PI / 3,
      aspect: 0.5625,
    },
    floorZ: 0,
    boxes: [{ min: [-1, -1, 0] as [number, number, number], max: [1, 1, 2] as [number, number, number] }],
  }
  const fakeRenderer = {} as THREE.WebGLRenderer

  it('экспонирует scene (THREE.Scene) и camera (PerspectiveCamera, fov=60)', () => {
    const s = new ShadowScene3D(shadowData, fakeRenderer)
    expect(s.scene).toBeInstanceOf(THREE.Scene)
    expect(s.camera).toBeInstanceOf(THREE.PerspectiveCamera)
    expect(s.camera.fov).toBeCloseTo(60, 4)
  })

  it('в сцене PointLight-и по числу ламп и ровно один castShadow', () => {
    const s = new ShadowScene3D(shadowData, fakeRenderer)
    const lights: THREE.PointLight[] = []
    s.scene.traverse((o) => { if ((o as THREE.PointLight).isPointLight) lights.push(o as THREE.PointLight) })
    expect(lights.length).toBe(2)
    expect(lights.filter((l) => l.castShadow).length).toBe(1)
  })

  it('в сцене приёмник (ShadowMaterial, receiveShadow) и кастер (castShadow)', () => {
    const s = new ShadowScene3D(shadowData, fakeRenderer)
    let receivers = 0, casters = 0
    s.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      if (m.receiveShadow && m.material instanceof THREE.ShadowMaterial) receivers++
      if (m.castShadow) casters++
    })
    expect(receivers).toBeGreaterThanOrEqual(2) // пол + 1 box
    expect(casters).toBeGreaterThanOrEqual(1)    // static proxy
  })

  it('setReceiver заменяет приёмник (B2 swap box→mesh)', () => {
    const s = new ShadowScene3D(shadowData, fakeRenderer)
    const nr = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial())
    nr.receiveShadow = true
    ;(nr as unknown as { __tag: string }).__tag = 'b2'
    s.setReceiver([nr])
    let found = false
    s.scene.traverse((o) => { if ((o as unknown as { __tag?: string }).__tag === 'b2') found = true })
    expect(found).toBe(true)
  })

  it('setCaster заменяет кастер (Phase C: staticProxy→ProxyRig)', () => {
    const s = new ShadowScene3D(shadowData, fakeRenderer)
    const tag = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.5), new THREE.MeshBasicMaterial())
    tag.castShadow = true
    s.setCaster(tag)
    expect(s.caster).toBe(tag)
    let found = false
    s.scene.traverse((o) => { if (o === tag) found = true })
    expect(found).toBe(true)
  })

  it('update не бросает в B1 (статический прокси; pose-drive — Фаза C)', () => {
    const s = new ShadowScene3D(shadowData, fakeRenderer)
    expect(() => s.update(null, { F: new THREE.Vector3(0, 0, 0), H: 1.7 }, shadowData)).not.toThrow()
  })
})
