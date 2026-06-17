// Геометрия физической тени (Task2): телеметрия вебкамеры (дистанция + bbox)
// → позиция ног посетителя на полу и его рост в мировых координатах комнаты
// (Blender-мир). Чистая геометрия — без three.js и рендера.

import * as THREE from 'three'

export type Vec3 = [number, number, number]

export interface ShadowCamera {
  pos: Vec3
  target: Vec3
  fovY: number   // радианы (вертикальный угол)
  aspect: number // resX/resY
}

export interface PersonTelemetry {
  distanceCm: number // дистанция камера→человек
  bboxCx: number     // центр bbox по X, доля кадра 0..1
  bboxH: number      // высота bbox, доля кадра 0..1
}

export interface PersonOnFloor { F: Vec3; H: number }

function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

// Перенесено из main.ts: сэмпл мировой позиции из worldPos-EXR (CPU).
// Как шейдер: texture(tWorld, (u,v)) с flipY=false → row = v*(h-1).
export function sampleWorldXYZ(
  wp: { data: Float32Array; width: number; height: number }, u: number, v: number,
): Vec3 {
  const px = Math.min(wp.width - 1, Math.max(0, Math.round(u * (wp.width - 1))))
  const py = Math.min(wp.height - 1, Math.max(0, Math.round(v * (wp.height - 1))))
  const i = (py * wp.width + px) * 4
  return [wp.data[i], wp.data[i + 1], wp.data[i + 2]]
}

// F sanity-gate (спека §5): если ступни попали на дальнюю стену / разрыв EXR,
// |F.z - floorZ| вылетит за порог → отвергаем F и падаем на fallback v1 этот кадр.
// Без гейта монокулярный шум даёт дёрганые телепорты тени на метры.
export const Z_THR = 0.15

export function passesFloorGate(F: Vec3, floorZ: number): boolean {
  if (!isFinite(F[2])) return false
  return Math.abs(F[2] - floorZ) <= Z_THR
}

export type ShadowMode = 'proxy' | 'crossfade' | 'room' | 'silhouette'

// Выбор пути тени (§5/§6). В Phase C — бинарный по факту позы + F sanity-gate;
// crossfade/гистерезис (POSE_ENTER/POSE_DROP) добавит D2 поверх ('crossfade' пока не возвращается).
export function selectShadowMode(s: {
  hasPose: boolean
  F: Vec3 | null
  floorZ: number
  hasShadowData: boolean
}): ShadowMode {
  if (!s.hasShadowData) return 'silhouette'
  if (s.hasPose && s.F !== null && passesFloorGate(s.F, s.floorZ)) return 'proxy'
  return 'room'
}

export function personFloorWorld(t: PersonTelemetry, cam: ShadowCamera, floorZ: number): PersonOnFloor {
  const fwd = norm(sub(cam.target, cam.pos))
  // правый вектор (горизонталь): fwd × up(0,0,1)
  const right = norm([fwd[1] * 1 - 0, 0 - fwd[0] * 1, 0])
  const d = Math.min(6, Math.max(0.5, t.distanceCm / 100)) // м; кламп от runaway bbox (1/bboxH)
  // боковое смещение из центра bbox: доля кадра → метры по полю зрения на дистанции d
  const halfW = Math.tan(cam.fovY / 2) * cam.aspect * d
  const lateral = (t.bboxCx - 0.5) * 2 * halfW
  const px = cam.pos[0] + fwd[0] * d + right[0] * lateral
  const py = cam.pos[1] + fwd[1] * d + right[1] * lateral
  const F: Vec3 = [px, py, floorZ]
  // рост: высота bbox (доля) × видимая высота кадра на дистанции d
  const frameH = 2 * Math.tan(cam.fovY / 2) * d
  const H = Math.min(2.0, Math.max(1.4, t.bboxH * frameH))
  return { F, H }
}

// Временное сглаживание позы (спека §5/§8). exp-smooth как F/H в main.ts (k=1-exp(-dt*RATE)),
// плюс ДОП. демпф z-оси: монокулярная глубина pose.world.z шумная и грубо откалибрована,
// давим её сильнее xy (множитель Z_DAMP). Это убирает дрожь и маскирует транспортный
// рассинхрон pose↔силуэт; НЕ даёт точной глубины — прокси схлопывается к фронто-параллели.
const POSE_SMOOTH_RATE = 8   // как F/H (main.ts: k = 1-exp(-dt*8))
const Z_DAMP = 0.35          // z-канал тянется к цели медленнее xy (0..1, меньше = жёстче демпф)

export class PoseSmoother {
  private prev: number[][] | null = null

  push(target: number[][], dt: number): number[][] {
    const k = 1 - Math.exp(-dt * POSE_SMOOTH_RATE)
    if (this.prev === null) {
      this.prev = target.map((lm) => [lm[0], lm[1], lm[2], lm[3]])
      return this.prev.map((lm) => [lm[0], lm[1], lm[2], lm[3]])
    }
    const out: number[][] = []
    for (let i = 0; i < target.length; i++) {
      const p = this.prev[i] ?? target[i]
      const t = target[i]
      const x = p[0] + (t[0] - p[0]) * k
      const y = p[1] + (t[1] - p[1]) * k
      const z = p[2] + (t[2] - p[2]) * k * Z_DAMP // z тянется медленнее → демпф глубины
      out.push([x, y, z, t[3]])                    // visibility — из цели, без сглаживания
    }
    this.prev = out.map((lm) => [lm[0], lm[1], lm[2], lm[3]])
    return out
  }
}

// Индексы MediaPipe Pose (33 landmark'а). Только используемые ProxyRig (§4.2).
export const POSE_IDX = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
} as const

// Трансформ одной капсулы (или сферы головы): центр сегмента, кватернион
// (ось капсулы +Y → вектор сустав→сустав), длина сегмента. Радиусы — у ProxyRig.
export interface CapsuleXf {
  name: string
  center: Vec3
  quat: [number, number, number, number] // x,y,z,w
  length: number
}

const VIS_MIN = 0.5 // joint видим (зеркально POSE_VIS_THRESH в capture)
// Только руки. Ноги НЕ две отдельные капсулы (давали «/\»-базу у двух стоп — юзер
// убрал), а единая центральная масса hipMid→ankleMid (строится ниже как 'leg').
const SEGMENTS: [string, number, number][] = [
  ['upperarm_L', POSE_IDX.L_SHOULDER, POSE_IDX.L_ELBOW],
  ['forearm_L', POSE_IDX.L_ELBOW, POSE_IDX.L_WRIST],
  ['upperarm_R', POSE_IDX.R_SHOULDER, POSE_IDX.R_ELBOW],
  ['forearm_R', POSE_IDX.R_ELBOW, POSE_IDX.R_WRIST],
]

const _yAxis = new THREE.Vector3(0, 1, 0)
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _q = new THREE.Quaternion()

function visible(lm: number[] | undefined): boolean {
  return !!lm && (lm[3] ?? 0) >= VIS_MIN
}

function segmentXf(name: string, a: number[], b: number[]): CapsuleXf {
  _a.set(a[0], a[1], a[2])
  _b.set(b[0], b[1], b[2])
  _dir.subVectors(_b, _a)
  const length = _dir.length()
  if (length > 1e-6) _q.setFromUnitVectors(_yAxis, _dir.clone().normalize())
  else _q.identity()
  return {
    name,
    center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    quat: [_q.x, _q.y, _q.z, _q.w],
    length,
  }
}

// Чистая математика: 33 world-landmark'а → трансформы капсул (центр/кватернион/длина).
// Ориентация — из самих landmarks (никакого force-face-camera, §4.2). Невидимые
// суставы пропускаются. Корень/скейл (F,H) применяет ProxyRig поверх (C.5).
export function proxyCapsuleTransforms(poseWorld: number[][]): CapsuleXf[] {
  const out: CapsuleXf[] = []

  const ls = poseWorld[POSE_IDX.L_SHOULDER], rs = poseWorld[POSE_IDX.R_SHOULDER]
  const lh = poseWorld[POSE_IDX.L_HIP], rh = poseWorld[POSE_IDX.R_HIP]
  const hipsVisible = visible(lh) && visible(rh)
  const hipMid = hipsVisible
    ? [(lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2, (lh[2] + rh[2]) / 2]
    : null
  const shoulderMid = visible(ls) && visible(rs)
    ? [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2, (ls[2] + rs[2]) / 2]
    : null
  if (shoulderMid && hipMid) {
    out.push(segmentXf('torso', hipMid, shoulderMid))
  }

  // Шея = короткий пенёк над плечами. Голову (всё выше шеи) убрали — силуэт
  // заканчивается на шее (юзер). Высота шеи = 40% пути плечи→нос (естественно, без головы).
  const noseLm = poseWorld[POSE_IDX.NOSE]
  if (shoulderMid && visible(noseLm)) {
    const neckTop = [
      shoulderMid[0] + (noseLm[0] - shoulderMid[0]) * 0.4,
      shoulderMid[1] + (noseLm[1] - shoulderMid[1]) * 0.4,
      shoulderMid[2] + (noseLm[2] - shoulderMid[2]) * 0.4,
    ]
    out.push(segmentXf('neck', shoulderMid, neckTop))
  }

  // Единая нога: hipMid → ankleMid (средняя точка видимых лодыжек). Одна центральная
  // масса вместо двух ног — низ тени НЕ расходится в «/\» (юзер убрал базу у ног).
  const la = poseWorld[POSE_IDX.L_ANKLE], ra = poseWorld[POSE_IDX.R_ANKLE]
  if (hipMid) {
    const ankles = [la, ra].filter(visible)
    if (ankles.length > 0) {
      const ankleMid = [
        ankles.reduce((s, a) => s + a[0], 0) / ankles.length,
        ankles.reduce((s, a) => s + a[1], 0) / ankles.length,
        ankles.reduce((s, a) => s + a[2], 0) / ankles.length,
      ]
      out.push(segmentXf('leg', ankleMid, hipMid))
    }
  }

  for (const [name, ai, bi] of SEGMENTS) {
    const a = poseWorld[ai], b = poseWorld[bi]
    if (visible(a) && visible(b)) out.push(segmentXf(name, a, b))
  }

  // Головы НЕТ (юзер: «убрать всё выше шеи») — силуэт оканчивается шеей-пеньком.

  return out
}
