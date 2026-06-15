import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { passesFloorGate, personFloorWorld, sampleWorldXYZ, Z_THR, PoseSmoother, proxyCapsuleTransforms, POSE_IDX, type ShadowCamera, type CapsuleXf } from './shadowGeom'

// камера у балконной двери смотрит на восток (как плейт гостиной)
const CAM: ShadowCamera = {
  pos: [1.35, 2.2, 1.62], target: [8.0, 1.5, 1.05], fovY: 1.05, aspect: 1080 / 1920,
}

describe('personFloorWorld', () => {
  it('дальше дистанция → точка F дальше от камеры по оси взгляда', () => {
    const near = personFloorWorld({ distanceCm: 120, bboxCx: 0.5, bboxH: 0.8 }, CAM, 0)
    const far = personFloorWorld({ distanceCm: 250, bboxCx: 0.5, bboxH: 0.5 }, CAM, 0)
    const dNear = Math.hypot(near.F[0] - 1.35, near.F[1] - 2.2)
    const dFar = Math.hypot(far.F[0] - 1.35, far.F[1] - 2.2)
    expect(dFar).toBeGreaterThan(dNear)
    expect(near.F[2]).toBeCloseTo(0, 5) // на полу
  })

  it('смещение bbox вправо → F смещается вбок (Y меняется)', () => {
    const c = personFloorWorld({ distanceCm: 200, bboxCx: 0.5, bboxH: 0.6 }, CAM, 0)
    const r = personFloorWorld({ distanceCm: 200, bboxCx: 0.8, bboxH: 0.6 }, CAM, 0)
    expect(Math.abs(r.F[1] - c.F[1])).toBeGreaterThan(0.1)
  })

  it('рост из bbox+дистанции в диапазоне [1.4, 2.0]', () => {
    const p = personFloorWorld({ distanceCm: 200, bboxCx: 0.5, bboxH: 0.9 }, CAM, 0)
    expect(p.H).toBeGreaterThanOrEqual(1.4)
    expect(p.H).toBeLessThanOrEqual(2.0)
  })
})

describe('sampleWorldXYZ', () => {
  const data = new Float32Array([
    0, 0, 7, 1,   1, 0, 7, 1,   // row 0: (0,0) (1,0)
    0, 1, 7, 1,   1, 1, 7, 1,   // row 1: (0,1) (1,1)
  ])
  const wp = { data, width: 2, height: 2 }

  it('сэмплит верхний-левый при u=0,v=0 (flipY=false → py=0)', () => {
    expect(sampleWorldXYZ(wp, 0, 0)).toEqual([0, 0, 7])
  })
  it('сэмплит нижний-правый при u=1,v=1', () => {
    expect(sampleWorldXYZ(wp, 1, 1)).toEqual([1, 1, 7])
  })
  it('округляет: u=0.6,v=0.4 → px=round(0.6)=1, py=round(0.4)=0', () => {
    expect(sampleWorldXYZ(wp, 0.6, 0.4)).toEqual([1, 0, 7])
  })
  it('клампит u/v за пределами [0,1] в крайние тексели', () => {
    expect(sampleWorldXYZ(wp, -5, 5)).toEqual([0, 1, 7])
  })
})

describe('passesFloorGate (F sanity-gate §5)', () => {
  it('Z_THR = 0.15 (контракт)', () => {
    expect(Z_THR).toBe(0.15)
  })
  it('F.z ровно на полу → принимаем', () => {
    expect(passesFloorGate([3, 1, 0.0], 0.0)).toBe(true)
  })
  it('F.z в пределах порога (|Δ| < 0.15) → принимаем', () => {
    expect(passesFloorGate([3, 1, 0.1], 0.0)).toBe(true)
    expect(passesFloorGate([3, 1, -0.1], 0.0)).toBe(true)
  })
  it('F.z далеко от floorZ (стена/разрыв, |Δ| > 0.15) → отвергаем → fallback v1', () => {
    expect(passesFloorGate([3, 1, 1.6], 0.0)).toBe(false)
    expect(passesFloorGate([3, 1, 0.5], 0.0)).toBe(false)
  })
  it('учитывает ненулевой floorZ', () => {
    expect(passesFloorGate([3, 1, 1.05], 1.0)).toBe(true)  // |1.05-1.0|=0.05 < 0.15
    expect(passesFloorGate([3, 1, 1.3], 1.0)).toBe(false)  // |1.3-1.0|=0.30 > 0.15
  })
  it('нечисловой/NaN сэмпл (битый EXR-пиксель) → отвергаем', () => {
    expect(passesFloorGate([3, 1, NaN], 0.0)).toBe(false)
  })
})

describe('PoseSmoother (§5 exp-smooth + z-damp)', () => {
  // мини-поза: 2 landmark'а [x,y,z,visibility] (тест не зависит от полных 33)
  const A = [[0, 0, 0, 1], [1, 1, 1, 1]]
  const B = [[10, 10, 10, 1], [11, 11, 11, 1]]

  it('первый кадр проходит как есть (нет истории)', () => {
    const s = new PoseSmoother()
    const out = s.push(A, 0.016)
    expect(out[0][0]).toBeCloseTo(0, 6)
    expect(out[1][0]).toBeCloseTo(1, 6)
  })

  it('exp-smooth тянет к новой цели, не допрыгивая за один кадр', () => {
    const s = new PoseSmoother()
    s.push(A, 0.016)
    const out = s.push(B, 0.016)
    expect(out[0][0]).toBeGreaterThan(0)
    expect(out[0][0]).toBeLessThan(10)
    expect(out[0][0]).toBeCloseTo((10 - 0) * (1 - Math.exp(-0.016 * 8)), 4)
  })

  it('z демпфируется СИЛЬНЕЕ xy: при равном скачке z двигается медленнее x', () => {
    const sx = new PoseSmoother()
    sx.push(A, 0.016)
    const out = sx.push(B, 0.016)
    const dx = out[0][0] - 0
    const dz = out[0][2] - 0
    expect(dz).toBeLessThan(dx)
    expect(dz).toBeGreaterThan(0)
  })

  it('visibility (канал 3) переносится из последней цели без сглаживания', () => {
    const s = new PoseSmoother()
    s.push(A, 0.016)
    const out = s.push([[10, 10, 10, 0.42], [11, 11, 11, 0.9]], 0.016)
    expect(out[0][3]).toBe(0.42)
    expect(out[1][3]).toBe(0.9)
  })

  it('стабильный вход → выход сходится к нему (дрожь гаснет)', () => {
    const s = new PoseSmoother()
    for (let i = 0; i < 200; i++) s.push(B, 0.016)
    const out = s.push(B, 0.016)
    expect(out[0][0]).toBeCloseTo(10, 3)
    expect(out[0][2]).toBeCloseTo(10, 3)
  })
})

// синтетическая поза: задаём только нужные суставы, остальные [0,0,0,0].
function blankPose(): number[][] {
  return Array.from({ length: 33 }, () => [0, 0, 0, 0])
}
function withJoints(setter: (p: number[][]) => void): number[][] {
  const p = blankPose()
  setter(p)
  return p
}

describe('POSE_IDX (MediaPipe Pose 33-landmark константы)', () => {
  it('канонические индексы суставов', () => {
    expect(POSE_IDX.L_SHOULDER).toBe(11)
    expect(POSE_IDX.R_SHOULDER).toBe(12)
    expect(POSE_IDX.L_ELBOW).toBe(13)
    expect(POSE_IDX.L_WRIST).toBe(15)
    expect(POSE_IDX.R_WRIST).toBe(16)
    expect(POSE_IDX.L_HIP).toBe(23)
    expect(POSE_IDX.R_HIP).toBe(24)
    expect(POSE_IDX.L_KNEE).toBe(25)
    expect(POSE_IDX.L_ANKLE).toBe(27)
    expect(POSE_IDX.R_ANKLE).toBe(28)
    expect(POSE_IDX.NOSE).toBe(0)
  })
})

describe('proxyCapsuleTransforms (§4.2 ориентация из landmarks)', () => {
  it('левое предплечье вдоль +Y → кватернион ~identity (ось капсулы Y совпала с сегментом)', () => {
    const p = withJoints((p) => {
      p[POSE_IDX.L_ELBOW] = [0, 0, 0, 1]
      p[POSE_IDX.L_WRIST] = [0, 1, 0, 1]
    })
    const xfs: CapsuleXf[] = proxyCapsuleTransforms(p)
    const fa = xfs.find((x) => x.name === 'forearm_L')!
    expect(fa).toBeDefined()
    expect(fa.center[0]).toBeCloseTo(0, 5)
    expect(fa.center[1]).toBeCloseTo(0.5, 5)
    expect(fa.length).toBeCloseTo(1, 5)
    const q = new THREE.Quaternion(fa.quat[0], fa.quat[1], fa.quat[2], fa.quat[3])
    const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    expect(yAxis.x).toBeCloseTo(0, 5)
    expect(yAxis.y).toBeCloseTo(1, 5)
    expect(yAxis.z).toBeCloseTo(0, 5)
  })

  it('поднятая рука → кватернион плеча меняется (артикуляция, §10 live-критерий)', () => {
    const down = withJoints((p) => {
      p[POSE_IDX.L_SHOULDER] = [0, 0, 0, 1]
      p[POSE_IDX.L_ELBOW] = [0, -1, 0, 1]
    })
    const up = withJoints((p) => {
      p[POSE_IDX.L_SHOULDER] = [0, 0, 0, 1]
      p[POSE_IDX.L_ELBOW] = [0, 1, 0, 1]
    })
    const qDown = proxyCapsuleTransforms(down).find((x) => x.name === 'upperarm_L')!.quat
    const qUp = proxyCapsuleTransforms(up).find((x) => x.name === 'upperarm_L')!.quat
    const dot = Math.abs(qDown[0] * qUp[0] + qDown[1] * qUp[1] + qDown[2] * qUp[2] + qDown[3] * qUp[3])
    expect(dot).toBeLessThan(0.99)
  })

  it('ориентация торса берётся из landmarks (наклон вперёд → z-компонента), НЕ force-face-camera', () => {
    // плечи смещены по +z относительно бёдер → торс-сегмент несёт z (наклон вперёд).
    // (yaw одной капсулой-торсом не представить — сегмент вертикали инвариантен к yaw;
    //  проверяем, что ориентация сегмента честно идёт из landmarks, а не обнулена фронтально.)
    const leaned = withJoints((p) => {
      p[POSE_IDX.L_SHOULDER] = [0.2, 0, 0.15, 1]
      p[POSE_IDX.R_SHOULDER] = [-0.2, 0, 0.15, 1]
      p[POSE_IDX.L_HIP] = [0.1, -1, 0, 1]
      p[POSE_IDX.R_HIP] = [-0.1, -1, 0, 1]
    })
    const torso = proxyCapsuleTransforms(leaned).find((x) => x.name === 'torso')!
    const q = new THREE.Quaternion(torso.quat[0], torso.quat[1], torso.quat[2], torso.quat[3])
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    expect(Math.abs(axis.z)).toBeGreaterThan(0.001)
  })

  it('сегмент с низкой visibility (joint не виден) пропускается', () => {
    const p = withJoints((p) => {
      p[POSE_IDX.L_ELBOW] = [0, 0, 0, 0.1]
      p[POSE_IDX.L_WRIST] = [0, 1, 0, 0.1]
    })
    const xfs = proxyCapsuleTransforms(p)
    expect(xfs.find((x) => x.name === 'forearm_L')).toBeUndefined()
  })

  it('голова — сфера (length≈0) у nose', () => {
    const p = withJoints((p) => {
      p[POSE_IDX.NOSE] = [0, 1.7, 0, 1]
    })
    const head = proxyCapsuleTransforms(p).find((x) => x.name === 'head')!
    expect(head).toBeDefined()
    expect(head.center[1]).toBeCloseTo(1.7, 5)
  })
})
