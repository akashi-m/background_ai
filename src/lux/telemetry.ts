// Парсер телеметрии capture-сервиса. Контракт: capture/CONTRACT.md (15 Гц).
// Толерантен к мусору: битое сообщение → null, поток не рвём (спека §8).

export interface Telemetry {
  present: boolean
  distanceCm: number | null
  coverage: number
  bbox: [number, number, number, number] | null
  errors: number
  fps: number
  pose?: { world: number[][]; norm: number[][]; healthy: number }
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null
}

// landmark-матрица: массив строк по 4 конечных числа [x,y,z,visibility].
function isLandmarkArray(v: unknown): v is number[][] {
  return (
    Array.isArray(v) &&
    v.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 4 &&
        row.every((n) => typeof n === 'number' && isFinite(n)),
    )
  )
}

export function parseTelemetry(json: unknown): Telemetry | null {
  if (typeof json !== 'object' || json === null) return null
  const j = json as Record<string, unknown>
  if (j.type !== 'presence' || typeof j.present !== 'boolean') return null

  let bbox: Telemetry['bbox'] = null
  if (
    Array.isArray(j.bbox) && j.bbox.length === 4 &&
    j.bbox.every((v) => typeof v === 'number' && isFinite(v))
  ) {
    bbox = j.bbox as [number, number, number, number]
  }

  const result: Telemetry = {
    present: j.present,
    distanceCm: finiteOrNull(j.distanceCm),
    coverage: finiteOrNull(j.coverage) ?? 0,
    bbox,
    errors: finiteOrNull(j.errors) ?? 0,
    fps: finiteOrNull(j.fps) ?? 0,
  }

  // pose парсится НЕЗАВИСИМО (реконсиляция §A / D2.1): битый/отсутствующий pose
  // оставляет result.pose undefined, но презенс-пакет всё равно валиден (поток жив).
  if (typeof j.pose === 'object' && j.pose !== null) {
    const p = j.pose as Record<string, unknown>
    if (isLandmarkArray(p.world) && isLandmarkArray(p.norm) && finiteOrNull(p.healthy) !== null) {
      result.pose = { world: p.world, norm: p.norm, healthy: p.healthy as number }
    }
  }

  return result
}
