import { describe, it, expect } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { offAxisFrustum, applyOffAxis } from './offAxis'

// Экран 30×19 см (MacBook), near = 1 см
const W = 30, H = 19, NEAR = 1

describe('offAxisFrustum', () => {
  it('глаз по центру → симметричный фрустум', () => {
    const f = offAxisFrustum({ x: 0, y: 0, z: 60 }, W, H, NEAR)
    expect(f.right).toBeCloseTo(-f.left, 6)
    expect(f.top).toBeCloseTo(-f.bottom, 6)
    expect(f.right).toBeCloseTo((W / 2) * (NEAR / 60), 6)
  })

  it('глаз вправо → ширина фрустума не меняется, но сдвигается влево', () => {
    const fCenter = offAxisFrustum({ x: 0, y: 0, z: 60 }, W, H, NEAR)
    const fRight  = offAxisFrustum({ x: 10, y: 0, z: 60 }, W, H, NEAR)
    // Ширина фрустума (right - left) при той же z не зависит от eye.x
    expect(fRight.right - fRight.left).toBeCloseTo(fCenter.right - fCenter.left, 6)
    // Асимметрия: |left| > |right| — фрустум скошен влево
    expect(Math.abs(fRight.left)).toBeGreaterThan(Math.abs(fRight.right))
  })

  it('глаз вдвое дальше → фрустум вдвое уже', () => {
    const near60 = offAxisFrustum({ x: 0, y: 0, z: 60 }, W, H, NEAR)
    const near120 = offAxisFrustum({ x: 0, y: 0, z: 120 }, W, H, NEAR)
    expect(near120.right).toBeCloseTo(near60.right / 2, 6)
  })

  // Отслеживание может давать z ≤ 0 — функция обязана выбросить ошибку,
  // иначе матрица проекции вырождается или переворачивается.
  it('z <= 0 — ошибка (зритель за экраном невозможен)', () => {
    expect(() => offAxisFrustum({ x: 0, y: 0, z: 0 }, W, H, NEAR)).toThrow()
    expect(() => offAxisFrustum({ x: 0, y: 0, z: -5 }, W, H, NEAR)).toThrow()
  })
})

describe('applyOffAxis', () => {
  // (a) Поведенческий тест: физические углы экрана должны проецироваться
  //     точно в NDC ±1 (иначе top/bottom или left/right перепутаны).
  it('углы экрана проецируются в NDC ±1', () => {
    const camera = new PerspectiveCamera()
    applyOffAxis(camera, { x: 10, y: -5, z: 55 }, W, H)

    // Синхронизация near/far
    expect(camera.near).toBe(1)
    expect(camera.far).toBe(100000)

    const corners: [number, number, number, number, number][] = [
      // [wx, wy, wz, ожид. NDC x, ожид. NDC y]
      [ W / 2,  H / 2, 0,  1,  1],
      [-W / 2,  H / 2, 0, -1,  1],
      [ W / 2, -H / 2, 0,  1, -1],
      [-W / 2, -H / 2, 0, -1, -1],
    ]
    for (const [wx, wy, wz, ex, ey] of corners) {
      const ndc = new Vector3(wx, wy, wz).project(camera)
      expect(ndc.x).toBeCloseTo(ex, 4)
      expect(ndc.y).toBeCloseTo(ey, 4)
    }
  })

  // (b) Свойство нулевого параллакса: точка на плоскости экрана (z=0) должна
  //     давать одинаковые NDC x/y для разных позиций глаза.
  it('точка на плоскости экрана имеет одинаковый NDC для разных глаз', () => {
    const point = new Vector3(3, 4, 0)

    const cam1 = new PerspectiveCamera()
    applyOffAxis(cam1, { x: 0, y: 0, z: 60 }, W, H)
    const ndc1 = point.clone().project(cam1)

    const cam2 = new PerspectiveCamera()
    applyOffAxis(cam2, { x: 12, y: 6, z: 45 }, W, H)
    const ndc2 = point.clone().project(cam2)

    expect(ndc2.x).toBeCloseTo(ndc1.x, 4)
    expect(ndc2.y).toBeCloseTo(ndc1.y, 4)
  })
})
