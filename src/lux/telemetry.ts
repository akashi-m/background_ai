// Парсер телеметрии capture-сервиса. Контракт: capture/CONTRACT.md (15 Гц).
// Толерантен к мусору: битое сообщение → null, поток не рвём (спека §8).

export interface Telemetry {
  present: boolean
  distanceCm: number | null
  coverage: number
  bbox: [number, number, number, number] | null
  errors: number
  fps: number
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null
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

  return {
    present: j.present,
    distanceCm: finiteOrNull(j.distanceCm),
    coverage: finiteOrNull(j.coverage) ?? 0,
    bbox,
    errors: finiteOrNull(j.errors) ?? 0,
    fps: finiteOrNull(j.fps) ?? 0,
  }
}
