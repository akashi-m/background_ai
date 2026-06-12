// Расписание реконнекта к capture: 1с → 2с → 4с → 4с… (бесконечно, спека §3 модуль personStream)
// потолок 4с: критерий приёмки — авто-возврат ≤5с (спека рендерера §10.4)
export function nextBackoffMs(attempt: number): number {
  return Math.min(4000, 1000 * 2 ** Math.max(0, attempt))
}
