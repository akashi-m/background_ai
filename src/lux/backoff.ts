// Расписание реконнекта к capture: 1с → 2с → 4с → 8с → 8с… (бесконечно, спека §3 модуль personStream)
export function nextBackoffMs(attempt: number): number {
  return Math.min(8000, 1000 * 2 ** Math.max(0, attempt))
}
