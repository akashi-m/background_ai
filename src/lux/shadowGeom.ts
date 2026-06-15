// Геометрия физической тени (Task2): телеметрия вебкамеры (дистанция + bbox)
// → позиция ног посетителя на полу и его рост в мировых координатах комнаты
// (Blender-мир). Чистая геометрия — без three.js и рендера.

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

export function personFloorWorld(t: PersonTelemetry, cam: ShadowCamera, floorZ: number): PersonOnFloor {
  const fwd = norm(sub(cam.target, cam.pos))
  // правый вектор (горизонталь): fwd × up(0,0,1)
  const right = norm([fwd[1] * 1 - 0, 0 - fwd[0] * 1, 0])
  const d = t.distanceCm / 100 // м
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
