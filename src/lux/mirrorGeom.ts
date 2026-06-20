export type Vec3 = [number, number, number]
export interface CamSpec { pos: Vec3; target: Vec3; fovY: number; aspect: number }

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]]
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0],a[1],a[2])||1; return [a[0]/l,a[1]/l,a[2]/l] }
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]

// Луч из камеры через экранный пиксель (u,v ∈ [0,1], v сверху-вниз) → пересечение с полом Z=floorZ.
// up = +Z мира. Возвращает мировую точку пола.
export function floorPointAnalytic(cam: CamSpec, u: number, v: number, floorZ: number): Vec3 {
  const fwd = norm(sub(cam.target, cam.pos))
  const worldUp: Vec3 = [0, 0, 1]
  const right = norm(cross(fwd, worldUp))
  const up = norm(cross(right, fwd))
  const t2 = Math.tan(cam.fovY / 2)
  const xN = (2*u - 1) * t2 * cam.aspect
  const yN = (1 - 2*v) * t2            // v сверху→низ: верх кадра = +up
  const dir: Vec3 = norm([
    fwd[0] + xN*right[0] + yN*up[0],
    fwd[1] + xN*right[1] + yN*up[1],
    fwd[2] + xN*right[2] + yN*up[2],
  ])
  const denom = dir[2] || 1e-6
  const tHit = (floorZ - cam.pos[2]) / denom
  return [cam.pos[0] + dir[0]*tHit, cam.pos[1] + dir[1]*tHit, cam.pos[2] + dir[2]*tHit]
}

// Height-lock: масштаб uUvScale, делающий ФИГУРУ ростом H_px на экране (life-size 1:1).
// person-проход сэмплит видео как uv=(vUv-0.5)*scale+0.5 → меньше sy = крупнее фигура.
// Фигура занимает bboxHfrac кадра видео; её экранная доля = bboxHfrac/sy. Нужна = H_px/canvasH.
export function heightLockScale(p: {
  H_m: number; bboxHfrac: number; canvasHeightPx: number; screenHcm: number
  mirrorMag: number; personAspect: number; canvasAspect: number
}): { sx: number; sy: number } {
  const pxPerCm = p.canvasHeightPx / p.screenHcm
  const H_px = p.H_m * 100 * pxPerCm * p.mirrorMag
  const sy = (p.bboxHfrac * p.canvasHeightPx) / Math.max(H_px, 1)
  // без растяжения: сохранить пиксельный аспект фигуры (как cover-fit).
  // person-видео аспект personAspect; канвас canvasAspect → sx = sy * (personAspect / canvasAspect)
  const sx = sy * (p.personAspect / p.canvasAspect)
  return { sx, sy }
}
