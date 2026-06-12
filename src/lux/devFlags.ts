// Дев-флаги из query: запуск без вебки и форс фазы — для самопроверки UI
// скриншотами и разработки без телеметрии. В проде не используются.

import type { Phase } from './experience'

export interface DevFlags {
  noTracker: boolean       // не открывать камеру/трекер (нейтральный взгляд)
  forcePhase: Phase | null // принудительная фаза на старте
}

const PHASES: readonly Phase[] = ['IDLE', 'APPROACH', 'MIRROR']

export function parseDevFlags(search: string): DevFlags {
  const q = new URLSearchParams(search)
  const raw = q.get('forcePhase')
  return {
    noTracker: q.has('noTracker'),
    forcePhase: PHASES.includes(raw as Phase) ? (raw as Phase) : null,
  }
}
