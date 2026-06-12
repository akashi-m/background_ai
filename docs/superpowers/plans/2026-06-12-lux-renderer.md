# Lux-рендерер — план реализации (подпроект №2 Stellar Mirror Lux)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Веб-рендерер принимает RGBA-поток и телеметрию capture-сервиса (по `capture/CONTRACT.md`), компонует фигуру в интерьер-мир с гармонизацией (LUT, light wrap, контактная тень, зерно) и ведёт опыт через IDLE → APPROACH → MIRROR. Спека: `docs/superpowers/specs/2026-06-12-lux-renderer-design.md`.

**Architecture:** Строимся ПОВЕРХ Stellar Window 2.0: миры = интерьеры, WorldSwitcher = переключатель стилей, HeadTracker-параллакс фона остаётся. Новое: `src/lux/*` — чистая логика (телеметрия/backoff/experience/lut/shadow — TDD) + интеграция (PersonStream WebRTC/WS, LuxCompositor с рендер-таргетом, блюром для wrap и шейдером фигуры, idle-слайдшоу). Главное изменение цикла: мир рендерится в RT, не на экран.

**Tech Stack:** существующий стек (three 0.180, Vite, Vitest, TS strict); WebRTC/WebSocket браузерные API.

**Ветка:** `git checkout -b lux/renderer` от `lux/capture-service`.

## Структура файлов

```
src/lux/
├── config.ts        все тайминги/пороги/URL capture (числа в одном месте)
├── telemetry.ts     typed-парсер WS-сообщений по CONTRACT.md (TDD)
├── backoff.ts       расписание реконнекта 1с→8с (TDD)
├── experience.ts    стейт-машина IDLE/APPROACH/MIRROR + mirrorOpacity (TDD)
├── lut.ts           парсер .cube → Data3DTexture, identity-фолбэк (TDD)
├── shadow.ts        bbox → эллипс тени + сглаживание (TDD)
├── personStream.ts  WebRTC+WS клиент, статус, реконнект (интеграция)
├── compositor.ts    RT-конвейер: мир→RT, блюр, блит, тень, фигура, фейд (интеграция)
└── idle.ts          слайдшоу бэкплейтов с кроссфейдом (интеграция)
Modify: src/app/worldMeta.ts (+lut, +shadowStrength), src/main.ts (wiring),
        src/debug/panel.ts (строка статуса потока, F-клавиши в подсказке)
Delete после wiring: src/render/compositor.ts (его фейд переезжает в LuxCompositor)
```

Сейчас в веб-части 48 тестов — они остаются зелёными.

---

### Task 1: Парсер телеметрии

**Files:**
- Create: `src/lux/telemetry.ts`
- Test: `src/lux/telemetry.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { describe, it, expect } from 'vitest'
import { parseTelemetry } from './telemetry'

const VALID = {
  type: 'presence', present: true, distanceCm: 150.5, coverage: 0.21,
  bbox: [0.1, 0.2, 0.6, 1.0], errors: 0, fps: 29.7,
}

describe('parseTelemetry', () => {
  it('валидное сообщение разбирается', () => {
    const t = parseTelemetry(VALID)!
    expect(t.present).toBe(true)
    expect(t.distanceCm).toBeCloseTo(150.5)
    expect(t.bbox).toEqual([0.1, 0.2, 0.6, 1.0])
    expect(t.errors).toBe(0)
  })

  it('чужой type → null', () => {
    expect(parseTelemetry({ ...VALID, type: 'joints' })).toBeNull()
  })

  it('не-объект и мусор → null', () => {
    expect(parseTelemetry(null)).toBeNull()
    expect(parseTelemetry('hi')).toBeNull()
    expect(parseTelemetry({ type: 'presence' })).toBeNull() // нет present
  })

  it('distanceCm null/NaN → null-дистанция, сообщение валидно', () => {
    expect(parseTelemetry({ ...VALID, distanceCm: null })!.distanceCm).toBeNull()
    expect(parseTelemetry({ ...VALID, distanceCm: NaN })!.distanceCm).toBeNull()
  })

  it('кривой bbox → bbox null, сообщение валидно', () => {
    expect(parseTelemetry({ ...VALID, bbox: [1, 2] })!.bbox).toBeNull()
    expect(parseTelemetry({ ...VALID, bbox: null })!.bbox).toBeNull()
    expect(parseTelemetry({ ...VALID, bbox: [0, 0, 'x', 1] })!.bbox).toBeNull()
  })

  it('лишние ключи игнорируются (вперёд-совместимость)', () => {
    expect(parseTelemetry({ ...VALID, joints: [1, 2, 3] })).not.toBeNull()
  })
})
```

- [ ] **Step 2:** `npx vitest run src/lux/telemetry.test.ts` → FAIL (модуля нет)

- [ ] **Step 3: Реализация**

```ts
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
```

- [ ] **Step 4:** `npx vitest run` → 54 passed (48 + 6); `npx tsc --noEmit` чисто
- [ ] **Step 5:** Commit: `git add src/lux/ && git commit -m "feat(lux): typed-парсер телеметрии по CONTRACT.md"`

---

### Task 2: Backoff реконнекта

**Files:**
- Create: `src/lux/backoff.ts`
- Test: `src/lux/backoff.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { describe, it, expect } from 'vitest'
import { nextBackoffMs } from './backoff'

describe('nextBackoffMs', () => {
  it('экспонента 1с → 8с с потолком', () => {
    expect(nextBackoffMs(0)).toBe(1000)
    expect(nextBackoffMs(1)).toBe(2000)
    expect(nextBackoffMs(2)).toBe(4000)
    expect(nextBackoffMs(3)).toBe(8000)
    expect(nextBackoffMs(10)).toBe(8000) // бесконечные ретраи, потолок 8с
  })

  it('отрицательная попытка → как нулевая', () => {
    expect(nextBackoffMs(-1)).toBe(1000)
  })
})
```

- [ ] **Step 2:** `npx vitest run src/lux/backoff.test.ts` → FAIL

- [ ] **Step 3: Реализация**

```ts
// Расписание реконнекта к capture: 1с → 2с → 4с → 8с → 8с… (бесконечно, спека §3 модуль personStream)
export function nextBackoffMs(attempt: number): number {
  return Math.min(8000, 1000 * 2 ** Math.max(0, attempt))
}
```

- [ ] **Step 4:** `npx vitest run` → 56 passed
- [ ] **Step 5:** Commit: `git add src/lux/ && git commit -m "feat(lux): backoff-расписание реконнекта"`

---

### Task 3: Конфиг и стейт-машина опыта

**Files:**
- Create: `src/lux/config.ts`, `src/lux/experience.ts`
- Test: `src/lux/experience.test.ts`

- [ ] **Step 1: src/lux/config.ts**

```ts
// Все тайминги/пороги Lux-опыта. Меняются здесь, без правок логики (спека §5).
export const LUX_CONFIG = {
  captureUrl: 'http://localhost:8765', // capture-сервис (offer/ws)
  approachCm: 250,    // ближе — начинается APPROACH
  approachSec: 1.2,   // длительность проявления зеркала
  exitSec: 10,        // отсутствие в MIRROR до возврата в IDLE
  staleSec: 2,        // телеметрия старше — поток считается протухшим
  fadeSec: 1.0,       // плавный уход в IDLE при штатном выходе
  fastFadeSec: 0.3,   // быстрый уход при сбое потока (зависший кадр не показываем)
  slideSec: 8,        // период кроссфейда слайдшоу IDLE
  wrapStrength: 0.6,  // сила light wrap 0..1
  grainAmount: 0.04,  // сила зерна 0..1
  shadowStrength: 0.5,// дефолтная плотность контактной тени
  feather: [0.05, 0.95] as [number, number], // smoothstep краёв альфы
}
```

- [ ] **Step 2: Падающий тест experience**

```ts
import { describe, it, expect } from 'vitest'
import { Experience } from './experience'

const CFG = { approachCm: 250, approachSec: 1.0, exitSec: 2.0, fadeSec: 0.5, fastFadeSec: 0.1 }

const NEAR = { present: true, distanceCm: 150, healthy: true }
const FAR = { present: true, distanceCm: 400, healthy: true }
const GONE = { present: false, distanceCm: null, healthy: true }
const BROKEN = { present: true, distanceCm: 150, healthy: false }

function run(e: Experience, input: typeof NEAR, sec: number, dt = 0.1): void {
  for (let t = 0; t < sec - 1e-9; t += dt) e.update(dt, input)
}

describe('Experience', () => {
  it('старт: IDLE, зеркало прозрачно', () => {
    const e = new Experience(CFG)
    expect(e.phase).toBe('IDLE')
    expect(e.mirrorOpacity).toBe(0)
  })

  it('подошёл близко → APPROACH → MIRROR за approachSec', () => {
    const e = new Experience(CFG)
    e.update(0.1, NEAR)
    expect(e.phase).toBe('APPROACH')
    expect(e.mirrorOpacity).toBeGreaterThan(0)
    run(e, NEAR, 1.0)
    expect(e.phase).toBe('MIRROR')
    expect(e.mirrorOpacity).toBe(1)
  })

  it('далеко (present, но > approachCm) — остаёмся в IDLE', () => {
    const e = new Experience(CFG)
    run(e, FAR, 1.0)
    expect(e.phase).toBe('IDLE')
  })

  it('ушёл из APPROACH → сразу IDLE (без exit-таймера)', () => {
    const e = new Experience(CFG)
    e.update(0.1, NEAR)
    e.update(0.1, GONE)
    expect(e.phase).toBe('IDLE')
  })

  it('ушёл из MIRROR → IDLE только после exitSec, зеркало гаснет за fadeSec', () => {
    const e = new Experience(CFG)
    run(e, NEAR, 1.2)
    expect(e.phase).toBe('MIRROR')
    run(e, GONE, 1.9)
    expect(e.phase).toBe('MIRROR')      // ещё ждём
    run(e, GONE, 0.2)
    expect(e.phase).toBe('IDLE')
    expect(e.mirrorOpacity).toBeGreaterThan(0) // гаснет плавно
    run(e, GONE, 0.6)
    expect(e.mirrorOpacity).toBe(0)
  })

  it('вернулся в MIRROR до exitSec — таймер сбрасывается', () => {
    const e = new Experience(CFG)
    run(e, NEAR, 1.2)
    run(e, GONE, 1.5)
    run(e, NEAR, 0.2)   // вернулся
    run(e, GONE, 1.5)
    expect(e.phase).toBe('MIRROR')      // таймер шёл заново
  })

  it('сбой потока в MIRROR → немедленно IDLE, быстрый фейд', () => {
    const e = new Experience(CFG)
    run(e, NEAR, 1.2)
    e.update(0.05, BROKEN)
    expect(e.phase).toBe('IDLE')
    run(e, BROKEN, 0.1)
    expect(e.mirrorOpacity).toBe(0)     // fastFadeSec=0.1
  })

  it('сбой потока — в APPROACH не входим', () => {
    const e = new Experience(CFG)
    run(e, BROKEN, 0.5)
    expect(e.phase).toBe('IDLE')
  })

  it('forceNext: IDLE→APPROACH→MIRROR→IDLE по кругу (F5)', () => {
    const e = new Experience(CFG)
    e.forceNext()
    expect(e.phase).toBe('APPROACH')
    e.forceNext()
    expect(e.phase).toBe('MIRROR')
    e.forceNext()
    expect(e.phase).toBe('IDLE')
  })
})
```

- [ ] **Step 3:** `npx vitest run src/lux/experience.test.ts` → FAIL

- [ ] **Step 4: src/lux/experience.ts**

```ts
// Стейт-машина опыта (спека §5). Вход каждый кадр: присутствие/дистанция из
// телеметрии + здоровье потока. Выход: фаза + mirrorOpacity (0..1) для рендера.
// Сломанный композит не показывается никогда: !healthy → IDLE с быстрым фейдом.

export type Phase = 'IDLE' | 'APPROACH' | 'MIRROR'

export interface ExperienceInput {
  present: boolean
  distanceCm: number | null
  healthy: boolean // поток live и телеметрия свежа (считает вызывающий)
}

export interface ExperienceConfig {
  approachCm: number
  approachSec: number
  exitSec: number
  fadeSec: number
  fastFadeSec: number
}

export class Experience {
  phase: Phase = 'IDLE'
  mirrorOpacity = 0
  private approachT = 0
  private absentT = 0
  private fastFade = false
  private forced = false

  constructor(private cfg: ExperienceConfig) {}

  /** F5: принудительный цикл фаз для разработки без телеметрии. */
  forceNext(): void {
    this.forced = true
    if (this.phase === 'IDLE') {
      this.phase = 'APPROACH'
      this.approachT = 0
    } else if (this.phase === 'APPROACH') {
      this.phase = 'MIRROR'
    } else {
      this.phase = 'IDLE'
      this.forced = false
    }
    this.fastFade = false
    this.absentT = 0
  }

  update(dt: number, input: ExperienceInput): void {
    const near =
      input.present && input.distanceCm !== null && input.distanceCm < this.cfg.approachCm

    if (!this.forced) {
      if (!input.healthy) {
        if (this.phase !== 'IDLE') this.fastFade = true
        this.phase = 'IDLE'
      } else if (this.phase === 'IDLE') {
        if (near) {
          this.phase = 'APPROACH'
          this.approachT = 0
          this.fastFade = false
        }
      } else if (this.phase === 'APPROACH') {
        if (!near) {
          this.phase = 'IDLE'
        } else {
          this.approachT += dt
          if (this.approachT >= this.cfg.approachSec) this.phase = 'MIRROR'
        }
      } else {
        // MIRROR: уходим только по накопленному отсутствию
        if (input.present) {
          this.absentT = 0
        } else {
          this.absentT += dt
          if (this.absentT >= this.cfg.exitSec) {
            this.phase = 'IDLE'
            this.absentT = 0
          }
        }
      }
    } else if (this.phase === 'APPROACH') {
      this.approachT += dt // в форс-режиме APPROACH не завершается сам
    }

    // mirrorOpacity тянется к цели со скоростью фазы
    const target = this.phase === 'IDLE' ? 0 : 1
    const riseSec = this.cfg.approachSec
    const fallSec = this.fastFade ? this.cfg.fastFadeSec : this.cfg.fadeSec
    const rate = target > this.mirrorOpacity ? dt / riseSec : dt / fallSec
    this.mirrorOpacity =
      target > this.mirrorOpacity
        ? Math.min(target, this.mirrorOpacity + rate)
        : Math.max(target, this.mirrorOpacity - rate)
    if (this.mirrorOpacity === 0) this.fastFade = false
  }
}
```

- [ ] **Step 5:** `npx vitest run` → 65 passed (56 + 9); `npx tsc --noEmit` чисто
- [ ] **Step 6:** Commit: `git add src/lux/ && git commit -m "feat(lux): стейт-машина опыта IDLE/APPROACH/MIRROR + конфиг"`

---

### Task 4: Парсер .cube и LUT-текстура

**Files:**
- Create: `src/lux/lut.ts`
- Test: `src/lux/lut.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { describe, it, expect } from 'vitest'
import { parseCube, identityLut } from './lut'

const CUBE_2 = `# комментарий
TITLE "test"
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`

describe('parseCube', () => {
  it('валидный .cube 2×2×2', () => {
    const lut = parseCube(CUBE_2)!
    expect(lut.size).toBe(2)
    expect(lut.data.length).toBe(2 * 2 * 2 * 3)
    expect(Array.from(lut.data.slice(0, 3))).toEqual([0, 0, 0])
    expect(Array.from(lut.data.slice(21, 24))).toEqual([1, 1, 1])
  })

  it('нет LUT_3D_SIZE → null', () => {
    expect(parseCube('1 2 3\n4 5 6')).toBeNull()
  })

  it('обрезанные данные → null', () => {
    expect(parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1')).toBeNull()
  })

  it('мусорные значения → null', () => {
    expect(parseCube('LUT_3D_SIZE 2\n' + 'a b c\n'.repeat(8))).toBeNull()
  })
})

describe('identityLut', () => {
  it('identity: углы куба соответствуют цветам', () => {
    const lut = identityLut(4)
    expect(lut.size).toBe(4)
    expect(Array.from(lut.data.slice(0, 3))).toEqual([0, 0, 0])
    const last = lut.data.length - 3
    expect(Array.from(lut.data.slice(last))).toEqual([1, 1, 1])
  })
})
```

- [ ] **Step 2:** `npx vitest run src/lux/lut.test.ts` → FAIL

- [ ] **Step 3: Реализация**

```ts
// Парсер .cube (Adobe/Resolve 3D LUT) и identity-фолбэк (спека §3, §8).
// Битый файл → null; вызывающий подставляет identity и пишет console.warn.

import * as THREE from 'three'

export interface ParsedLut {
  size: number
  data: Float32Array // r,g,b подряд, red быстрее всех (стандарт .cube)
}

export function parseCube(text: string): ParsedLut | null {
  let size = 0
  const values: number[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const mSize = /^LUT_3D_SIZE\s+(\d+)$/i.exec(line)
    if (mSize) {
      size = Number(mSize[1])
      continue
    }
    if (/^[A-Z_]/i.test(line)) continue // TITLE, DOMAIN_MIN и прочие ключи
    const parts = line.split(/\s+/).map(Number)
    if (parts.length === 3 && parts.every((v) => isFinite(v))) {
      values.push(...parts)
    } else {
      return null
    }
  }
  if (size < 2 || values.length !== size * size * size * 3) return null
  return { size, data: new Float32Array(values) }
}

export function identityLut(size = 16): ParsedLut {
  const data = new Float32Array(size * size * size * 3)
  let i = 0
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        data[i++] = r / (size - 1)
        data[i++] = g / (size - 1)
        data[i++] = b / (size - 1)
      }
  return { size, data }
}

export function makeLutTexture(lut: ParsedLut): THREE.Data3DTexture {
  const n = lut.size
  const rgba = new Uint8Array(n * n * n * 4)
  for (let i = 0, j = 0; i < lut.data.length; i += 3, j += 4) {
    rgba[j] = Math.round(lut.data[i] * 255)
    rgba[j + 1] = Math.round(lut.data[i + 1] * 255)
    rgba[j + 2] = Math.round(lut.data[i + 2] * 255)
    rgba[j + 3] = 255
  }
  const tex = new THREE.Data3DTexture(rgba, n, n, n)
  tex.format = THREE.RGBAFormat
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

/** Загрузка LUT мира: нет файла/битый → identity + warn. */
export async function loadLutTexture(url: string | null): Promise<THREE.Data3DTexture> {
  if (url) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const parsed = parseCube(await res.text())
        if (parsed) return makeLutTexture(parsed)
      }
      console.warn(`битый или недоступный LUT ${url} — использую identity`)
    } catch {
      console.warn(`не удалось загрузить LUT ${url} — использую identity`)
    }
  }
  return makeLutTexture(identityLut())
}
```

- [ ] **Step 4:** `npx vitest run` → 70 passed; `npx tsc --noEmit` чисто
- [ ] **Step 5:** Commit: `git add src/lux/ && git commit -m "feat(lux): .cube-парсер, identity-LUT, Data3DTexture"`

---

### Task 5: Математика контактной тени

**Files:**
- Create: `src/lux/shadow.ts`
- Test: `src/lux/shadow.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { describe, it, expect } from 'vitest'
import { shadowFromBbox, SmoothedShadow } from './shadow'

describe('shadowFromBbox', () => {
  it('эллипс у ног, по центру bbox, зеркально отражён по x', () => {
    // bbox: x 0.2..0.6 (центр 0.4), низ y=0.9
    const s = shadowFromBbox([0.2, 0.1, 0.6, 0.9])!
    expect(s.cx).toBeCloseTo(1 - 0.4) // зеркальный флип как у фигуры
    expect(s.cy).toBeCloseTo(0.9)
    expect(s.rx).toBeCloseTo(((0.6 - 0.2) / 2) * 1.15) // чуть шире ступней
    expect(s.ry).toBeCloseTo(s.rx * 0.22)              // плоский эллипс
  })

  it('bbox null → null', () => {
    expect(shadowFromBbox(null)).toBeNull()
  })
})

describe('SmoothedShadow', () => {
  it('плавно тянется к цели, исчезает при null', () => {
    const sm = new SmoothedShadow()
    const a = sm.update(shadowFromBbox([0.2, 0.1, 0.6, 0.9]), 0.016)!
    expect(a.opacity).toBeGreaterThan(0)
    // много кадров — сходится к цели
    let cur = a
    for (let i = 0; i < 200; i++) cur = sm.update(shadowFromBbox([0.2, 0.1, 0.6, 0.9]), 0.016)!
    expect(cur.cx).toBeCloseTo(0.6, 1)
    expect(cur.opacity).toBeCloseTo(1, 1)
    // цель пропала — затухает, потом null
    let faded = sm.update(null, 0.016)
    for (let i = 0; i < 300 && faded !== null; i++) faded = sm.update(null, 0.016)
    expect(faded).toBeNull()
  })
})
```

- [ ] **Step 2:** `npx vitest run src/lux/shadow.test.ts` → FAIL

- [ ] **Step 3: Реализация**

```ts
// Контактная тень под ногами: позиция из bbox телеметрии (низ bbox = ступни),
// сглаживание экспоненциальное (дрожь bbox не дёргает тень), исчезновение при
// потере фигуры (спека §3 модуль shadow).

export interface ShadowEllipse {
  cx: number // нормированный экран, 0..1 (уже с зеркальным флипом)
  cy: number
  rx: number
  ry: number
  opacity: number // 0..1, множитель к shadowStrength мира
}

const WIDEN = 1.15  // тень чуть шире ступней
const FLAT = 0.22   // отношение высоты эллипса к ширине

export function shadowFromBbox(
  bbox: [number, number, number, number] | null,
): Omit<ShadowEllipse, 'opacity'> | null {
  if (!bbox) return null
  const [x0, , x1, y1] = bbox
  const rx = ((x1 - x0) / 2) * WIDEN
  return { cx: 1 - (x0 + x1) / 2, cy: y1, rx, ry: rx * FLAT }
}

export class SmoothedShadow {
  private cur: ShadowEllipse | null = null

  update(target: Omit<ShadowEllipse, 'opacity'> | null, dt: number): ShadowEllipse | null {
    const k = 1 - Math.exp(-dt * 10)
    if (target === null) {
      if (this.cur === null) return null
      this.cur = { ...this.cur, opacity: this.cur.opacity - dt / 0.3 }
      if (this.cur.opacity <= 0.01) this.cur = null
      return this.cur
    }
    if (this.cur === null) {
      this.cur = { ...target, opacity: k }
      return this.cur
    }
    this.cur = {
      cx: this.cur.cx + (target.cx - this.cur.cx) * k,
      cy: this.cur.cy + (target.cy - this.cur.cy) * k,
      rx: this.cur.rx + (target.rx - this.cur.rx) * k,
      ry: this.cur.ry + (target.ry - this.cur.ry) * k,
      opacity: Math.min(1, this.cur.opacity + dt / 0.3),
    }
    return this.cur
  }
}
```

- [ ] **Step 4:** `npx vitest run` → 74 passed; tsc чисто
- [ ] **Step 5:** Commit: `git add src/lux/ && git commit -m "feat(lux): контактная тень — эллипс из bbox со сглаживанием"`

---

### Task 6: Расширение meta.json мира (lut, shadowStrength)

**Files:**
- Modify: `src/app/worldMeta.ts`
- Test: `src/app/worldMeta.test.ts` (дополнить)

- [ ] **Step 1: Падающий тест — добавить в worldMeta.test.ts**

```ts
  it('lux-поля: lut и shadowStrength валидируются и опциональны', () => {
    const m = parseWorldMeta({ ...VALID_PHOTO, lut: 'interior.cube', shadowStrength: 0.7 }, 'b')
    expect(m.lut).toBe('interior.cube')
    expect(m.shadowStrength).toBeCloseTo(0.7)
    const d = parseWorldMeta(VALID_PHOTO, 'b')
    expect(d.lut).toBeUndefined()
    expect(d.shadowStrength).toBe(0.5)
    expect(() => parseWorldMeta({ ...VALID_PHOTO, shadowStrength: 2 }, 'b')).toThrow(/b/)
    expect(() => parseWorldMeta({ ...VALID_PHOTO, lut: 7 }, 'b')).toThrow(/b/)
  })
```

- [ ] **Step 2:** `npx vitest run src/app/worldMeta.test.ts` → FAIL

- [ ] **Step 3: Реализация — в worldMeta.ts**

В `WorldMeta` добавить:
```ts
  lut?: string           // .cube гармонизации интерьера (Lux)
  shadowStrength: number // плотность контактной тени 0..1 (Lux, дефолт 0.5)
```

В `parseWorldMeta` перед `return` добавить:
```ts
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
```
и в возвращаемый объект: `lut,` и `shadowStrength,`.

- [ ] **Step 4:** `npx vitest run` → 75 passed; tsc чисто
- [ ] **Step 5:** Commit: `git add src/app/ && git commit -m "feat(lux): meta.json мира — опциональные lut и shadowStrength"`

---

### Task 7: PersonStream — WebRTC + WS клиент

**Files:**
- Create: `src/lux/personStream.ts`

Интеграция с браузерными API — юнитов нет (парсер и backoff уже покрыты);
проверка типов + ручная в Task 9.

- [ ] **Step 1: src/lux/personStream.ts**

```ts
// Клиент capture-сервиса: WebRTC-видео (SBS-кадр) + WS-телеметрия.
// Реконнект с backoff БЕСКОНЕЧНО (capture может перезапускаться). Статус наружу:
// connecting → live → (stale считает потребитель по age) → down → connecting…

import * as THREE from 'three'

import { nextBackoffMs } from './backoff'
import { parseTelemetry, type Telemetry } from './telemetry'

export type StreamStatus = 'connecting' | 'live' | 'down'

export class PersonStream {
  status: StreamStatus = 'connecting'
  telemetry: Telemetry | null = null
  badMessages = 0
  texture: THREE.VideoTexture | null = null
  /** Аспект SBS-кадра (ширина/2 / высота); null до первого кадра. */
  videoAspect: number | null = null

  private video = document.createElement('video')
  private pc: RTCPeerConnection | null = null
  private ws: WebSocket | null = null
  private lastTelemetryAt = 0
  private attempt = 0
  private stopped = false

  constructor(private baseUrl: string) {
    this.video.autoplay = true
    this.video.muted = true
    this.video.playsInline = true
  }

  start(): void {
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.teardown()
  }

  /** Секунды с последнего телеметрия-сообщения (для stale-логики опыта). */
  telemetryAgeSec(nowMs: number): number {
    return this.lastTelemetryAt === 0 ? Infinity : (nowMs - this.lastTelemetryAt) / 1000
  }

  /** Обновить производные поля видео (звать раз в кадр рендера). */
  tick(): void {
    if (this.texture && this.video.videoWidth > 0) {
      this.videoAspect = this.video.videoWidth / 2 / this.video.videoHeight
    }
  }

  private teardown(): void {
    this.pc?.close()
    this.pc = null
    this.ws?.close()
    this.ws = null
    this.texture?.dispose()
    this.texture = null
    this.videoAspect = null
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.status = 'down'
    this.teardown()
    const delay = nextBackoffMs(this.attempt++)
    setTimeout(() => void this.connect(), delay)
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    this.status = 'connecting'
    try {
      // --- WebRTC ---
      const pc = new RTCPeerConnection()
      this.pc = pc
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.ontrack = (e) => {
        this.video.srcObject = new MediaStream([e.track])
        this.texture = new THREE.VideoTexture(this.video)
        // colorSpace не задаём: сырой sRGB камеры — то, что нужно (см. v1)
      }
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          this.scheduleReconnect()
        }
      }
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const resp = await fetch(`${this.baseUrl}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: pc.localDescription!.sdp, type: pc.localDescription!.type }),
      })
      if (!resp.ok) throw new Error(`offer: HTTP ${resp.status}`)
      await pc.setRemoteDescription(await resp.json())

      // --- WS-телеметрия ---
      const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws'
      const ws = new WebSocket(wsUrl)
      this.ws = ws
      ws.onmessage = (e) => {
        try {
          const t = parseTelemetry(JSON.parse(e.data as string))
          if (t) {
            this.telemetry = t
            this.lastTelemetryAt = performance.now()
            this.status = 'live'
            this.attempt = 0 // успешная связь — сбрасываем backoff
          } else {
            this.badMessages++
          }
        } catch {
          this.badMessages++
        }
      }
      ws.onclose = () => this.scheduleReconnect()
      ws.onerror = () => { /* за ошибкой следует close — реконнект там */ }
    } catch {
      this.scheduleReconnect()
    }
  }
}
```

- [ ] **Step 2:** `npx vitest run && npx tsc --noEmit` → 75 passed, типы чисто
- [ ] **Step 3:** Commit: `git add src/lux/ && git commit -m "feat(lux): PersonStream — WebRTC+WS клиент с бесконечным реконнектом"`

---

### Task 8: LuxCompositor — RT-конвейер и шейдер гармонизации

**Files:**
- Create: `src/lux/compositor.ts`

GL-интеграция: проверка типов и сборки; визуально — в Task 9.

- [ ] **Step 1: src/lux/compositor.ts (write exactly this)**

```ts
// Композитор Lux (спека §4): мир → RT → экран; затем тень, фигура
// (SBS-распаковка + LUT + light wrap + зерно), фейд смены миров.
// Light wrap берёт уменьшенную размытую копию RT фона.

import * as THREE from 'three'

import type { ShadowEllipse } from './shadow'

export interface HarmonizeToggles {
  lut: boolean
  wrap: boolean
  shadow: boolean
  grain: boolean
}

export interface SlideState {
  a: THREE.Texture | null
  b: THREE.Texture | null
  mix: number
  visible: number // 0..1 — альфа слайдшоу (кроссфейд с зеркалом)
}

const FSQ = new THREE.PlaneGeometry(2, 2)
const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

function fsqMesh(mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(FSQ, mat)
  m.frustumCulled = false
  return m
}

export class LuxCompositor {
  private sceneRT: THREE.WebGLRenderTarget
  private wrapRT_A: THREE.WebGLRenderTarget
  private wrapRT_B: THREE.WebGLRenderTarget
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private passScene = new THREE.Scene()
  private passMeshes = new Map<THREE.Material, THREE.Mesh>() // кэш — без аллокаций в кадре

  private blitMat: THREE.ShaderMaterial
  private blurMat: THREE.ShaderMaterial
  private slideMat: THREE.ShaderMaterial
  private shadowMat: THREE.ShaderMaterial
  private personMat: THREE.ShaderMaterial
  private fadeMat: THREE.MeshBasicMaterial

  constructor(private renderer: THREE.WebGLRenderer, width: number, height: number) {
    this.sceneRT = new THREE.WebGLRenderTarget(width, height)
    this.wrapRT_A = new THREE.WebGLRenderTarget(width >> 2, height >> 2)
    this.wrapRT_B = new THREE.WebGLRenderTarget(width >> 2, height >> 2)

    this.blitMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tSrc;
        void main() { gl_FragColor = texture2D(tSrc, vUv); }
      `,
      depthTest: false,
    })

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2(1, 0) } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uDir;
        void main() {
          vec4 acc = vec4(0.0);
          float w[5]; w[0]=0.227; w[1]=0.194; w[2]=0.121; w[3]=0.054; w[4]=0.016;
          acc += texture2D(tSrc, vUv) * w[0];
          for (int i = 1; i < 5; i++) {
            vec2 off = uDir * float(i);
            acc += texture2D(tSrc, vUv + off) * w[i];
            acc += texture2D(tSrc, vUv - off) * w[i];
          }
          gl_FragColor = acc;
        }
      `,
      depthTest: false,
    })

    this.slideMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      uniforms: {
        tA: { value: null }, tB: { value: null },
        uMix: { value: 0 }, uVisible: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tA; uniform sampler2D tB;
        uniform float uMix; uniform float uVisible;
        void main() {
          vec3 a = texture2D(tA, vUv).rgb;
          vec3 b = texture2D(tB, vUv).rgb;
          gl_FragColor = vec4(mix(a, b, uMix), uVisible);
        }
      `,
    })

    this.shadowMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      uniforms: {
        uC: { value: new THREE.Vector2(0.5, 0.9) },
        uR: { value: new THREE.Vector2(0.2, 0.05) },
        uOpacity: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform vec2 uC; uniform vec2 uR; uniform float uOpacity;
        void main() {
          // vUv.y инвертируем: bbox в видео-координатах (y вниз)
          vec2 p = vec2(vUv.x, 1.0 - vUv.y);
          float d = length((p - uC) / uR);
          float a = smoothstep(1.0, 0.35, d) * uOpacity;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }
      `,
    })

    this.personMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      uniforms: {
        tVideo: { value: null },
        tLut: { value: null },
        uLutSize: { value: 16 },
        tWrap: { value: null },
        uOpacity: { value: 0 },
        uUvScale: { value: new THREE.Vector2(1, 1) },
        uUvOffset: { value: new THREE.Vector2(0, 0) },
        uFeather: { value: new THREE.Vector2(0.05, 0.95) },
        uWrapStrength: { value: 0.6 },
        uGrain: { value: 0.04 },
        uTime: { value: 0 },
        uLutOn: { value: 1 },
        uWrapOn: { value: 1 },
        uGrainOn: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler3D;
        varying vec2 vUv;
        uniform sampler2D tVideo; uniform sampler3D tLut; uniform float uLutSize;
        uniform sampler2D tWrap;
        uniform float uOpacity; uniform vec2 uUvScale; uniform vec2 uUvOffset;
        uniform vec2 uFeather; uniform float uWrapStrength; uniform float uGrain;
        uniform float uTime; uniform float uLutOn; uniform float uWrapOn; uniform float uGrainOn;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7)) + uTime) * 43758.5453);
        }

        void main() {
          // cover-fit видео + зеркальный флип
          vec2 uv = (vUv - 0.5) * uUvScale + 0.5 + uUvOffset;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          vec2 uvm = vec2(1.0 - uv.x, uv.y);
          vec3 rgb = texture2D(tVideo, vec2(uvm.x * 0.5, uvm.y)).rgb;
          float a = texture2D(tVideo, vec2(0.5 + uvm.x * 0.5, uvm.y)).r;
          a = smoothstep(uFeather.x, uFeather.y, a);

          // LUT интерьера
          if (uLutOn > 0.5) {
            vec3 c = clamp(rgb, 0.0, 1.0);
            vec3 lutUv = c * (uLutSize - 1.0) / uLutSize + 0.5 / uLutSize;
            rgb = texture(tLut, lutUv).rgb;
          }

          // light wrap: фон «обнимает» контур (максимум на полупрозрачном крае)
          if (uWrapOn > 0.5) {
            vec3 wrapC = texture2D(tWrap, vUv).rgb;
            float edge = a * (1.0 - a) * 4.0;
            rgb = mix(rgb, wrapC, uWrapStrength * edge);
          }

          // зерно
          if (uGrainOn > 0.5) {
            rgb += (hash(gl_FragCoord.xy) - 0.5) * uGrain;
          }

          gl_FragColor = vec4(rgb, a * uOpacity);
        }
      `,
    })

    this.fadeMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0, depthTest: false,
    })
  }

  setSize(width: number, height: number): void {
    this.sceneRT.setSize(width, height)
    this.wrapRT_A.setSize(width >> 2, height >> 2)
    this.wrapRT_B.setSize(width >> 2, height >> 2)
  }

  private pass(mat: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    let mesh = this.passMeshes.get(mat)
    if (!mesh) {
      mesh = fsqMesh(mat)
      this.passMeshes.set(mat, mesh)
    }
    this.passScene.children.length = 0
    this.passScene.add(mesh)
    const prev = this.renderer.autoClear
    this.renderer.autoClear = false
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.passScene, this.ortho)
    this.renderer.setRenderTarget(null)
    this.renderer.autoClear = prev
  }

  render(opts: {
    scene: THREE.Scene
    camera: THREE.Camera
    person: THREE.Texture | null
    personAspect: number | null
    mirrorOpacity: number
    shadow: ShadowEllipse | null
    shadowStrength: number
    lut: THREE.Data3DTexture
    lutSize: number
    toggles: HarmonizeToggles
    fade: number
    slides: SlideState
    timeSec: number
    canvasAspect: number
  }): void {
    const mirrorVisible = opts.mirrorOpacity > 0.001

    // 1. мир → RT (только когда зеркало видно)
    if (mirrorVisible) {
      this.renderer.setRenderTarget(this.sceneRT)
      this.renderer.render(opts.scene, opts.camera)
      this.renderer.setRenderTarget(null)

      // блюр для light wrap: RT → A (даунскейл блитом) → B (гориз.) → A (верт.)
      this.blitMat.uniforms.tSrc.value = this.sceneRT.texture
      this.pass(this.blitMat, this.wrapRT_A)
      const texel = new THREE.Vector2(1 / this.wrapRT_A.width, 1 / this.wrapRT_A.height)
      this.blurMat.uniforms.tSrc.value = this.wrapRT_A.texture
      this.blurMat.uniforms.uDir.value.set(texel.x, 0)
      this.pass(this.blurMat, this.wrapRT_B)
      this.blurMat.uniforms.tSrc.value = this.wrapRT_B.texture
      this.blurMat.uniforms.uDir.value.set(0, texel.y)
      this.pass(this.blurMat, this.wrapRT_A)
    }

    // 2. на экран: мир-блит
    this.renderer.clear()
    if (mirrorVisible) {
      this.blitMat.uniforms.tSrc.value = this.sceneRT.texture
      this.pass(this.blitMat, null)
    }

    // 3. слайдшоу IDLE (кроссфейдится с зеркалом через visible)
    if (opts.slides.visible > 0.001 && opts.slides.a) {
      this.slideMat.uniforms.tA.value = opts.slides.a
      this.slideMat.uniforms.tB.value = opts.slides.b ?? opts.slides.a
      this.slideMat.uniforms.uMix.value = opts.slides.mix
      this.slideMat.uniforms.uVisible.value = opts.slides.visible
      this.pass(this.slideMat, null)
    }

    // 4. контактная тень
    if (mirrorVisible && opts.toggles.shadow && opts.shadow) {
      this.shadowMat.uniforms.uC.value.set(opts.shadow.cx, opts.shadow.cy)
      this.shadowMat.uniforms.uR.value.set(opts.shadow.rx, opts.shadow.ry)
      this.shadowMat.uniforms.uOpacity.value =
        opts.shadow.opacity * opts.shadowStrength * opts.mirrorOpacity
      this.pass(this.shadowMat, null)
    }

    // 5. фигура
    if (mirrorVisible && opts.person) {
      const u = this.personMat.uniforms
      u.tVideo.value = opts.person
      u.tLut.value = opts.lut
      u.uLutSize.value = opts.lutSize
      u.tWrap.value = this.wrapRT_A.texture
      u.uOpacity.value = opts.mirrorOpacity
      u.uTime.value = opts.timeSec
      u.uLutOn.value = opts.toggles.lut ? 1 : 0
      u.uWrapOn.value = opts.toggles.wrap ? 1 : 0
      u.uGrainOn.value = opts.toggles.grain ? 1 : 0
      // cover-fit: видео заполняет экран без искажений
      if (opts.personAspect) {
        const va = opts.personAspect
        const ca = opts.canvasAspect
        if (ca > va) u.uUvScale.value.set(1, va / ca)
        else u.uUvScale.value.set(ca / va, 1)
      } else {
        u.uUvScale.value.set(1, 1)
      }
      this.pass(this.personMat, null)
    }

    // 6. шторка смены миров
    if (opts.fade > 0.001) {
      this.fadeMat.opacity = opts.fade
      this.pass(this.fadeMat, null)
    }
  }
}
```

- [ ] **Step 2:** `npx vitest run && npx tsc --noEmit && npm run build` → 75 passed, чисто
- [ ] **Step 3:** Commit: `git add src/lux/ && git commit -m "feat(lux): LuxCompositor — RT-конвейер, блюр wrap, шейдер гармонизации"`

---

### Task 9: Idle-слайдшоу и wiring в main.ts

**Files:**
- Create: `src/lux/idle.ts`
- Modify: `src/main.ts`, `src/debug/panel.ts`
- Delete: `src/render/compositor.ts` (фейд переехал в LuxCompositor; Compositor больше никем не используется)

- [ ] **Step 1: src/lux/idle.ts**

```ts
// Слайдшоу IDLE: кроссфейд бэкплейтов активных миров (спека §3 модуль idle).

import * as THREE from 'three'

import type { SlideState } from './compositor'

export class IdleSlides {
  private textures: THREE.Texture[] = []
  private index = 0
  private t = 0

  constructor(private slideSec: number) {}

  async load(urls: string[]): Promise<void> {
    const loader = new THREE.TextureLoader()
    const loaded = await Promise.allSettled(urls.map((u) => loader.loadAsync(u)))
    this.textures = loaded
      .filter((r): r is PromiseFulfilledResult<THREE.Texture> => r.status === 'fulfilled')
      .map((r) => {
        r.value.colorSpace = THREE.SRGBColorSpace
        return r.value
      })
    if (this.textures.length === 0) console.warn('слайдшоу: ни один бэкплейт не загрузился')
  }

  update(dt: number, visible: number): SlideState {
    if (this.textures.length === 0) return { a: null, b: null, mix: 0, visible }
    this.t += dt
    const period = this.slideSec
    if (this.t >= period) {
      this.t -= period
      this.index = (this.index + 1) % this.textures.length
    }
    const next = (this.index + 1) % this.textures.length
    // последние 25% периода — кроссфейд к следующему
    const fadePart = 0.25
    const mix = Math.max(0, (this.t / period - (1 - fadePart)) / fadePart)
    return {
      a: this.textures[this.index],
      b: this.textures[next],
      mix,
      visible,
    }
  }
}
```

- [ ] **Step 2: src/main.ts — переписать рендер-часть (полный файл)**

```ts
import * as THREE from 'three'
import { openCamera, showFatalError } from './tracking/camera'
import { HeadTracker } from './tracking/headTracker'
import { loadCalibration } from './app/calibration'
import { applyOffAxis } from './render/offAxis'
import { WorldSwitcher } from './app/worldSwitcher'
import { parseWorldMeta } from './app/worldMeta'
import { buildWorld, saveDepthOverride, type BuiltWorld } from './scenes/worldScene'
import { dollyFromEyeZ } from './app/dolly'
import { DebugPanel } from './debug/panel'
import { AlignController } from './debug/align'
import { SCENE_CONFIG } from './scenes/config'
import { LUX_CONFIG } from './lux/config'
import { PersonStream } from './lux/personStream'
import { Experience } from './lux/experience'
import { LuxCompositor, type HarmonizeToggles } from './lux/compositor'
import { IdleSlides } from './lux/idle'
import { loadLutTexture } from './lux/lut'
import { shadowFromBbox, SmoothedShadow } from './lux/shadow'

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Не загрузился ассет: ${url} (HTTP ${res.status})`)
  return res.json()
}

async function start() {
  const video = await openCamera() // HeadTracker-параллакс фона (v2) остаётся
  const calibration = loadCalibration()
  const tracker = new HeadTracker(video, calibration)
  await tracker.init()

  const renderer = new THREE.WebGLRenderer({ antialias: false })
  renderer.setSize(innerWidth, innerHeight)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.autoClear = false
  document.body.appendChild(renderer.domElement)

  const compositor = new LuxCompositor(
    renderer, innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio(),
  )
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight)
    compositor.setSize(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio())
  })

  // Миры-интерьеры + их LUT
  const worlds: BuiltWorld[] = await Promise.all(
    SCENE_CONFIG.worlds.map(async (name) => {
      const meta = parseWorldMeta(await fetchJson(`/assets/worlds/${name}/meta.json`), name)
      return buildWorld(`/assets/worlds/${name}/`, meta, calibration.screenWcm, calibration.screenHcm, renderer)
    }),
  )
  const luts = await Promise.all(
    worlds.map((w) =>
      loadLutTexture(w.meta.lut ? `/assets/worlds/${w.name}/${w.meta.lut}` : null),
    ),
  )
  const switcher = new WorldSwitcher(worlds.length)

  // Lux: поток фигуры, опыт, слайдшоу, тень
  const person = new PersonStream(LUX_CONFIG.captureUrl)
  person.start()
  const experience = new Experience(LUX_CONFIG)
  const slides = new IdleSlides(LUX_CONFIG.slideSec)
  await slides.load(
    worlds.filter((w) => w.meta.format === 'photo25d').map((w) => `/assets/worlds/${w.name}/${w.meta.file}`),
  )
  const shadowSmooth = new SmoothedShadow()
  const toggles: HarmonizeToggles = { lut: true, wrap: true, shadow: true, grain: true }

  new AlignController(() => worlds[switcher.index], () => SCENE_CONFIG.worlds[switcher.index])

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return
    if (e.code === 'KeyW') switcher.next()
    if (e.code === 'KeyM') switcher.prev()
    const digit = /^Digit([1-9])$/.exec(e.code)
    if (digit) switcher.switchTo(Number(digit[1]) - 1)
    if (e.code === 'F1') toggles.lut = !toggles.lut
    if (e.code === 'F2') toggles.wrap = !toggles.wrap
    if (e.code === 'F3') toggles.shadow = !toggles.shadow
    if (e.code === 'F4') toggles.grain = !toggles.grain
    if (e.code === 'F5') experience.forceNext()
    if (e.code === 'Comma' || e.code === 'Period') {
      parallaxGain = Math.round(Math.min(2, Math.max(0.1, parallaxGain + (e.code === 'Period' ? 0.05 : -0.05))) * 100) / 100
      localStorage.setItem('stellar-mirror.parallaxGain', String(parallaxGain))
      console.log(`параллакс-гейн: ${parallaxGain}`)
    }
    if (e.code === 'Semicolon' || e.code === 'Quote') {
      const w = worlds[switcher.index]
      if (!w.setDepthAmount || w.depthAmountCm === undefined) return
      const cm = Math.min(200, Math.max(0, w.depthAmountCm + (e.code === 'Quote' ? 5 : -5)))
      w.setDepthAmount(cm)
      saveDepthOverride(w.name, cm)
      console.log(`глубина 2.5D «${w.name}»: ${cm} см`)
    }
  })

  const debug = new DebugPanel(calibration, () => { /* подхватится в следующем кадре */ })

  let lastVideoFrameAt = performance.now()
  const onVideoFrame = () => {
    lastVideoFrameAt = performance.now()
    ;(video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void }).requestVideoFrameCallback(onVideoFrame)
  }
  ;(video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void }).requestVideoFrameCallback(onVideoFrame)

  const PRODUCTION_SCREEN_W_CM = 120
  const savedGain = Number(localStorage.getItem('stellar-mirror.parallaxGain'))
  let parallaxGain = Number.isFinite(savedGain) && savedGain > 0 && savedGain <= 2
    ? savedGain
    : Math.min(1, Math.max(0.5, calibration.screenWcm / PRODUCTION_SCREEN_W_CM))

  const camera = new THREE.PerspectiveCamera()

  let last = performance.now()
  renderer.setAnimationLoop((now) => {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    switcher.update(dt)
    person.tick()

    // здоровье потока для опыта: live + телеметрия свежа
    const healthy = person.status === 'live' && person.telemetryAgeSec(now) < LUX_CONFIG.staleSec
    const t = person.telemetry
    experience.update(dt, {
      present: t?.present ?? false,
      distanceCm: t?.distanceCm ?? null,
      healthy,
    })

    const eye = tracker.update(now, dt)
    const safeZ = Math.min(Math.max(eye.z, 20), 300)
    const safeEye = { x: eye.x * parallaxGain, y: eye.y * parallaxGain, z: safeZ }
    const cmPerPx = calibration.screenWcm / screen.width
    applyOffAxis(camera, safeEye, innerWidth * cmPerPx, innerHeight * cmPerPx)

    const active = worlds[switcher.index]
    active.dolly.position.z = dollyFromEyeZ(safeZ, active.meta.dollyMaxCm)

    const shadowTarget = experience.phase === 'MIRROR' || experience.phase === 'APPROACH'
      ? shadowFromBbox(healthy ? (t?.bbox ?? null) : null)
      : null
    const shadow = shadowSmooth.update(shadowTarget, dt)

    compositor.render({
      scene: active.scene,
      camera,
      person: person.texture,
      personAspect: person.videoAspect,
      mirrorOpacity: experience.mirrorOpacity,
      shadow,
      shadowStrength: active.meta.shadowStrength,
      lut: luts[switcher.index],
      lutSize: luts[switcher.index].image.width,
      toggles,
      fade: switcher.fade,
      slides: slides.update(dt, 1 - experience.mirrorOpacity),
      timeSec: now / 1000,
      canvasAspect: innerWidth / innerHeight,
    })

    debug.frame(safeEye, tracker.faceVisible, 0, performance.now() - lastVideoFrameAt,
      `lux: ${experience.phase} mirror=${experience.mirrorOpacity.toFixed(2)} поток=${person.status} битых=${person.badMessages}`)
  })
}

start().catch(showFatalError)
```

- [ ] **Step 3: src/debug/panel.ts — пятый аргумент frame(…, extra?)**

Сигнатуру метода заменить на:
```ts
  frame(eye: EyeCm, faceVisible: boolean, segFps: number, videoLagMs: number, extra?: string): void {
```
Последние две строки textContent заменить на:
```ts
        `лицо: ${faceVisible ? 'да' : 'нет'}\n` +
        `клавиши: 1..9 мир, W/M миры, A выравнивание, C калибровка, F1..F4 слои, F5 фаза` +
        (extra ? `\n${extra}` : '')
```

- [ ] **Step 4: Удалить src/render/compositor.ts**

```bash
git rm src/render/compositor.ts
```
Проверить: `grep -rn "render/compositor" src/` → пусто.

- [ ] **Step 5:** `npx vitest run && npx tsc --noEmit && npm run build` → 75 passed, чисто
- [ ] **Step 6 (ручная, человеком — SKIP для агента):** capture запущен (`uv run capture --source webcam --engine rvm`) + `npm run dev` → F5 до MIRROR → «я в интерьере», F1–F4 переключают слои.
- [ ] **Step 7:** Commit: `git add -A && git commit -m "feat(lux): wiring — опыт, слайдшоу, композит, F-клавиши; старый компонент-фейд удалён"`

---

### Task 10: README, приёмка, финальная проверка

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README — раздел Lux после «Клавиши»:**

```markdown
## Lux-режим (зеркало с фигурой)

Запусти capture-сервис и рендерер:

    cd capture && uv run capture --source webcam --engine rvm   # терминал 1
    npm run dev                                                  # терминал 2

Сценарий: IDLE-слайдшоу → подойти ближе ~2.5 м (или F5) → APPROACH → MIRROR:
ты в интерьере с гармонизацией. Capture упал → IDLE ≤1 с, поднялся → сам вернёшься.

| Клавиша | Действие |
|---|---|
| `F1`–`F4` | вкл/выкл LUT / light wrap / тень / зерно («тест люкса») |
| `F5` | принудительная смена фазы (разработка без телеметрии) |

## Чек-лист приёмки Lux-рендерера

- [ ] e2e: вебка → capture → рендерер: «я в интерьере», 60 fps рендера (панель D)
- [ ] Фазы от живой телеметрии: подошёл → проявление; ушёл на 10 с → слайдшоу
- [ ] F1–F4: каждый слой включается/выключается на живой картинке
- [ ] kill capture → IDLE ≤ 1 с; старт capture → MIRROR сам ≤ 5 с; ни одного сломанного кадра
- [ ] Тень следует за ногами без дрожи; зеркальность фигуры корректна
```

- [ ] **Step 2:** `npx vitest run && npx tsc --noEmit && npm run build && cd capture && uv run pytest -q && cd ..`
Expected: 75 веб-тестов + 32 python — все зелёные.

- [ ] **Step 3:** Commit: `git add README.md && git commit -m "docs: Lux-режим и чек-лист приёмки рендерера"`



