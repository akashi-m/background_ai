// Контракт между контент-пайплайном и рантаймом: meta.json в папке мира.
export interface WorldTransform {
  position: [number, number, number] // см
  rotationYDeg: number
  scale: number
}

export interface WorldMeta {
  title: string
  format: 'splat' | 'photo25d'
  file: string        // world.spz | photo.png
  depthFile?: string  // только photo25d
  aspect?: number     // только photo25d (ширина/высота фото)
  transform: WorldTransform
  dollyMaxCm: number
  depthAmountCm?: number // photo25d: сила 2.5D-объёма (дефолт 60)
  source?: string     // происхождение (marble:<id>, съёмка, ...)
  lut?: string           // .cube гармонизации интерьера (Lux)
  shadowStrength: number // плотность контактной тени 0..1 (Lux, дефолт 0.5)
  flat?: boolean         // плоский плейт-фон зеркала: фото целиком, без параллакс-кропа
  lightDirX?: number     // направление ключевого света интерьера по X экрана: -1 слева, +1 справа, 0 сверху
}

const DEFAULT_TRANSFORM: WorldTransform = { position: [0, 0, 0], rotationYDeg: 0, scale: 1 }

function fail(world: string, why: string): never {
  throw new Error(`Битый meta.json мира «${world}»: ${why}`)
}

export function parseWorldMeta(json: unknown, worldName: string): WorldMeta {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) fail(worldName, 'не объект')
  const j = json as Record<string, unknown>

  if (typeof j.title !== 'string' || !j.title) fail(worldName, 'нет title')
  if (j.format !== 'splat' && j.format !== 'photo25d') fail(worldName, `неизвестный format: ${String(j.format)}`)
  if (typeof j.file !== 'string' || !j.file) fail(worldName, 'нет file')

  if (j.format === 'photo25d') {
    if (typeof j.depthFile !== 'string' || !j.depthFile) fail(worldName, 'photo25d требует depthFile')
    if (typeof j.aspect !== 'number' || !isFinite(j.aspect) || j.aspect <= 0) fail(worldName, 'photo25d требует aspect > 0')
  }

  let transform = DEFAULT_TRANSFORM
  if (j.transform !== undefined) {
    if (typeof j.transform !== 'object' || j.transform === null || Array.isArray(j.transform)) fail(worldName, 'кривой transform')
    const t = j.transform as Record<string, unknown>
    const pos = t.position
    const okPos = Array.isArray(pos) && pos.length === 3 && pos.every((v) => typeof v === 'number' && isFinite(v))
    const okRot = typeof t.rotationYDeg === 'number' && isFinite(t.rotationYDeg)
    const okScale = typeof t.scale === 'number' && isFinite(t.scale) && t.scale > 0
    if (!okPos || !okRot || !okScale) fail(worldName, 'кривой transform')
    transform = { position: pos as [number, number, number], rotationYDeg: t.rotationYDeg as number, scale: t.scale as number }
  }

  let dollyMaxCm = 150
  if (j.dollyMaxCm !== undefined) {
    if (typeof j.dollyMaxCm !== 'number' || !isFinite(j.dollyMaxCm) || j.dollyMaxCm < 0) fail(worldName, 'кривой dollyMaxCm')
    dollyMaxCm = j.dollyMaxCm
  }

  let depthAmountCm: number | undefined
  if (j.depthAmountCm !== undefined) {
    if (typeof j.depthAmountCm !== 'number' || !isFinite(j.depthAmountCm) || j.depthAmountCm < 0) fail(worldName, 'кривой depthAmountCm')
    depthAmountCm = j.depthAmountCm
  }

  let lut: string | undefined
  if (j.lut !== undefined) {
    if (typeof j.lut !== 'string' || !j.lut) fail(worldName, 'кривой lut')
    lut = j.lut
  }

  let shadowStrength = 0.5
  if (j.shadowStrength !== undefined) {
    if (
      typeof j.shadowStrength !== 'number' || !isFinite(j.shadowStrength) ||
      j.shadowStrength < 0 || j.shadowStrength > 1
    ) fail(worldName, 'кривой shadowStrength')
    shadowStrength = j.shadowStrength
  }

  return {
    title: j.title,
    format: j.format,
    file: j.file,
    depthFile: typeof j.depthFile === 'string' ? j.depthFile : undefined,
    aspect: typeof j.aspect === 'number' ? j.aspect : undefined,
    transform,
    dollyMaxCm,
    depthAmountCm,
    source: typeof j.source === 'string' ? j.source : undefined,
    lut,
    shadowStrength,
    flat: j.flat === true,
    lightDirX: typeof j.lightDirX === 'number' && isFinite(j.lightDirX) ? j.lightDirX : 0,
  }
}
