# Зеркало качественно (этап 1 подпроекта №3) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Люксовый UI-оверлей зеркала (логотип, idle-приглашение, тач-кнопки интерьеров) синхронный с mirrorOpacity + дев-флаги `?noTracker`/`?forcePhase=` для запуска без вебки и визуальной самоприёмки. Спека: `2026-06-12-lux-ui-leads-design.md`, этап 1 (§3).

**Architecture:** HTML-оверлей поверх канваса (pointer-events только на кнопках), палитра/шрифты — CSS-переменные в `lux-theme.css`. `LuxUI` — тонкий класс DOM-управления (кнопки из заголовков миров, активная подсветка, opacity из mirrorOpacity). Дев-флаги парсятся чистой функцией (TDD) и позволяют рендереру жить без камеры — это открывает самопроверку скриншотами.

**Tech Stack:** существующий (Vite/TS/Vitest); ноль новых зависимостей.

**Ветка:** продолжаем на `lux/renderer`.

## Структура файлов

```
src/lux/devFlags.ts     парсер query-флагов (TDD)
src/lux/lux-theme.css   палитра, типографика, стили оверлея
src/lux/ui.ts           LuxUI: кнопки, активная, opacity
index.html              разметка оверлея (контейнеры)
src/main.ts             wiring: флаги, noTracker-путь, UI
README.md               приёмка этапа
```

---

### Task 1: Дев-флаги (TDD)

**Files:**
- Create: `src/lux/devFlags.ts`
- Test: `src/lux/devFlags.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { describe, it, expect } from 'vitest'
import { parseDevFlags } from './devFlags'

describe('parseDevFlags', () => {
  it('пустая строка → всё выключено', () => {
    expect(parseDevFlags('')).toEqual({ noTracker: false, forcePhase: null })
  })

  it('?noTracker включает работу без камеры', () => {
    expect(parseDevFlags('?noTracker').noTracker).toBe(true)
  })

  it('?forcePhase=MIRROR парсится, мусор — нет', () => {
    expect(parseDevFlags('?forcePhase=MIRROR').forcePhase).toBe('MIRROR')
    expect(parseDevFlags('?forcePhase=APPROACH').forcePhase).toBe('APPROACH')
    expect(parseDevFlags('?forcePhase=banana').forcePhase).toBeNull()
  })

  it('комбинация', () => {
    const f = parseDevFlags('?noTracker&forcePhase=MIRROR')
    expect(f).toEqual({ noTracker: true, forcePhase: 'MIRROR' })
  })
})
```

- [ ] **Step 2:** `npx vitest run src/lux/devFlags.test.ts` → FAIL

- [ ] **Step 3: Реализация**

```ts
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
```

- [ ] **Step 4:** `npx vitest run` → 79 passed; `npx tsc --noEmit` чисто
- [ ] **Step 5:** `git add src/lux/ && git commit -m "feat(lux): дев-флаги ?noTracker и ?forcePhase (TDD)"`

---

### Task 2: Тема и разметка оверлея

**Files:**
- Create: `src/lux/lux-theme.css`
- Modify: `index.html`

- [ ] **Step 1: src/lux/lux-theme.css (write exactly)**

```css
/* Люкс-тема Stellar Mirror: палитра/типографика в переменных —
   брендбук заказчика вставляется заменой этого блока. */
:root {
  --lux-gold: #d9b878;
  --lux-gold-dim: #a8905e;
  --lux-ink: #0b0a08;
  --lux-text: #f4ede0;
  --lux-font: 'Avenir Next', 'Futura', system-ui, sans-serif;
}

#lux-ui {
  position: fixed;
  inset: 0;
  z-index: 5; /* над канвасом, под debug-панелью (z=10) */
  pointer-events: none; /* кликает только то, что включит себя само */
  font-family: var(--lux-font);
  color: var(--lux-text);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 4vh 4vw;
  text-align: center;
}

.lux-logo {
  font-size: clamp(22px, 3.2vw, 44px);
  letter-spacing: 0.42em;
  text-indent: 0.42em; /* компенсация трекинга последней буквы */
  color: var(--lux-text);
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.55);
}
.lux-logo span { color: var(--lux-gold); }
.lux-tagline {
  margin-top: 1.2vh;
  font-size: clamp(11px, 1.1vw, 15px);
  letter-spacing: 0.34em;
  text-indent: 0.34em;
  color: var(--lux-gold-dim);
  text-transform: uppercase;
}

/* Слои состояний: видимость управляется из ui.ts через style.opacity */
[data-idle], [data-mirror] {
  transition: none; /* opacity ведёт рендер-цикл, без CSS-анимаций */
}

.lux-invite {
  font-size: clamp(14px, 1.6vw, 22px);
  letter-spacing: 0.28em;
  text-indent: 0.28em;
  text-transform: uppercase;
  color: var(--lux-text);
  text-shadow: 0 1px 10px rgba(0, 0, 0, 0.6);
}

.lux-choose {
  font-size: clamp(12px, 1.2vw, 16px);
  letter-spacing: 0.3em;
  text-indent: 0.3em;
  text-transform: uppercase;
  color: var(--lux-gold-dim);
  margin-bottom: 1.6vh;
}

.lux-interiors {
  display: flex;
  gap: 1.2vw;
  justify-content: center;
  flex-wrap: wrap;
}

.lux-btn {
  pointer-events: auto;
  cursor: pointer;
  font-family: var(--lux-font);
  font-size: clamp(13px, 1.3vw, 18px);
  letter-spacing: 0.22em;
  text-indent: 0.22em;
  text-transform: uppercase;
  color: var(--lux-text);
  background: rgba(11, 10, 8, 0.55);
  border: 1px solid rgba(217, 184, 120, 0.45);
  border-radius: 2px;
  padding: 1.4vh 2.6vw;
  backdrop-filter: blur(10px);
  transition: border-color 0.25s, background 0.25s, color 0.25s;
}
.lux-btn:hover { border-color: var(--lux-gold); }
.lux-btn.active {
  border-color: var(--lux-gold);
  background: rgba(217, 184, 120, 0.16);
  color: var(--lux-gold);
}
```

- [ ] **Step 2: index.html — подключить тему и добавить оверлей перед `</body>`-скриптом**

В `<head>` после существующего `<style>`:
```html
  <link rel="stylesheet" href="/src/lux/lux-theme.css">
```

В `<body>` перед строкой со `<script type="module" src="/src/main.ts">`:
```html
  <div id="lux-ui">
    <header>
      <div class="lux-logo">STELLAR <span>RESIDENCE</span></div>
      <div class="lux-tagline">Увидь свою новую реальность</div>
    </header>
    <footer>
      <div class="lux-invite" data-idle>Подойдите ближе</div>
      <div data-mirror style="opacity:0">
        <div class="lux-choose">Выберите интерьер</div>
        <nav class="lux-interiors" id="lux-interiors"></nav>
      </div>
    </footer>
  </div>
```

- [ ] **Step 3:** `npx vitest run && npm run build` → 79 passed, сборка чистая (Vite подхватит CSS-импорт из html)
- [ ] **Step 4:** `git add index.html src/lux/ && git commit -m "feat(lux): люкс-тема и разметка оверлея зеркала"`

---

### Task 3: LuxUI — управление оверлеем

**Files:**
- Create: `src/lux/ui.ts`
- Test: `src/lux/ui.test.ts` (DOM-тесты в happy-dom/jsdom не настроены — тестируем чистую часть: формирование подписей; DOM-класс покрывается визуальной приёмкой Task 5)

- [ ] **Step 1: Падающий тест (чистая часть)**

```ts
import { describe, it, expect } from 'vitest'
import { interiorLabels } from './ui'

describe('interiorLabels', () => {
  it('строит подписи из заголовков миров', () => {
    expect(interiorLabels([{ title: 'Спальня' }, { title: 'Балкон' }]))
      .toEqual(['Спальня', 'Балкон'])
  })

  it('пустой заголовок → нумерованный фолбэк', () => {
    expect(interiorLabels([{ title: '' }, { title: 'Лофт' }]))
      .toEqual(['Интерьер 1', 'Лофт'])
  })
})
```

- [ ] **Step 2:** `npx vitest run src/lux/ui.test.ts` → FAIL

- [ ] **Step 3: Реализация src/lux/ui.ts**

```ts
// UI-оверлей зеркала: кнопки интерьеров из миров, opacity-синхронизация
// с mirrorOpacity (UI «проявляется» вместе с зеркалом, спека №3 §3).

export function interiorLabels(metas: { title: string }[]): string[] {
  return metas.map((m, i) => m.title || `Интерьер ${i + 1}`)
}

export class LuxUI {
  private idleEls: HTMLElement[]
  private mirrorEls: HTMLElement[]
  private buttons: HTMLButtonElement[] = []

  constructor(private onInterior: (index: number) => void) {
    this.idleEls = Array.from(document.querySelectorAll<HTMLElement>('[data-idle]'))
    this.mirrorEls = Array.from(document.querySelectorAll<HTMLElement>('[data-mirror]'))
  }

  setWorlds(titles: string[]): void {
    const nav = document.getElementById('lux-interiors')
    if (!nav) return
    nav.innerHTML = ''
    this.buttons = titles.map((title, i) => {
      const b = document.createElement('button')
      b.className = 'lux-btn'
      b.textContent = title
      b.addEventListener('click', () => this.onInterior(i))
      nav.appendChild(b)
      return b
    })
  }

  setActive(index: number): void {
    this.buttons.forEach((b, i) => b.classList.toggle('active', i === index))
  }

  /** Звать каждый кадр: 0 = IDLE-вид, 1 = MIRROR-вид. */
  update(mirrorOpacity: number): void {
    const mo = String(mirrorOpacity)
    const io = String(1 - mirrorOpacity)
    for (const el of this.mirrorEls) {
      el.style.opacity = mo
      el.style.pointerEvents = mirrorOpacity > 0.5 ? 'auto' : 'none'
    }
    for (const el of this.idleEls) el.style.opacity = io
  }
}
```

- [ ] **Step 4:** `npx vitest run` → 81 passed; tsc чисто
- [ ] **Step 5:** `git add src/lux/ && git commit -m "feat(lux): LuxUI — кнопки интерьеров и синхронизация с mirrorOpacity"`

---

### Task 4: Wiring в main.ts (флаги + UI)

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Импорты**

```ts
import { parseDevFlags } from './lux/devFlags'
import { LuxUI, interiorLabels } from './lux/ui'
```

- [ ] **Step 2: В начале start() — флаги и noTracker-путь.** Заменить блок открытия камеры:

```ts
  const flags = parseDevFlags(location.search)
  const calibration = loadCalibration()
  let tracker: HeadTracker | null = null
  if (!flags.noTracker) {
    const video = await openCamera() // HeadTracker-параллакс фона (v2)
    tracker = new HeadTracker(video, calibration)
    await tracker.init()
    let lastVideoFrameAt = performance.now()
    const onVideoFrame = () => {
      lastVideoFrameAt = performance.now()
      ;(video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void }).requestVideoFrameCallback(onVideoFrame)
    }
    ;(video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void }).requestVideoFrameCallback(onVideoFrame)
    videoLag = () => performance.now() - lastVideoFrameAt
  }
```

Выше start() (или внутри, до использования): `let videoLag: () => number = () => 0`.
Старый блок `let lastVideoFrameAt...` (ниже по файлу) удалить; в debug.frame
использовать `videoLag()`.

- [ ] **Step 3: После создания experience — форс фазы:**

```ts
  if (flags.forcePhase) {
    // форс через публичный механизм F5: крутим цикл до нужной фазы
    while (experience.phase !== flags.forcePhase) experience.forceNext()
  }
```

- [ ] **Step 4: UI после загрузки миров:**

```ts
  const ui = new LuxUI((i) => switcher.switchTo(i))
  ui.setWorlds(interiorLabels(worlds.map((w) => w.meta)))
```

- [ ] **Step 5: В рендер-цикле:** замена `tracker.update(...)`:

```ts
    const eye = tracker ? tracker.update(now, dt) : { x: 0, y: 0, z: 60 }
```
строку faceVisible в debug.frame → `tracker?.faceVisible ?? false`, lag → `videoLag()`.
И после switcher.update добавить:
```ts
    ui.setActive(switcher.index)
    ui.update(experience.mirrorOpacity)
```

- [ ] **Step 6:** `npx vitest run && npx tsc --noEmit && npm run build` → 81, чисто.
Smoke: `npm run dev` фоном, `curl -s "http://localhost:5173/?noTracker&forcePhase=MIRROR" | grep lux-ui` → разметка есть; остановить.

- [ ] **Step 7:** `git add src/ && git commit -m "feat(lux): wiring UI и дев-флаги — рендерер живёт без камеры"`

---

### Task 5: Визуальная самоприёмка (выполняет КОНТРОЛЛЕР с MCP, не сабагент)

- [ ] Запустить `npm run dev` фоном; через Claude_Preview/Playwright открыть
  `http://localhost:5173/?noTracker` (IDLE: слайдшоу+логотип+приглашение) и
  `...?noTracker&forcePhase=MIRROR` (мир+кнопки) — скриншоты обоих состояний.
- [ ] Оценить против референс-рендера заказчика: типографика, трекинг букв,
  выравнивания, читаемость на светлом/тёмном мире, активная кнопка.
- [ ] Найденные визуальные дефекты исправить правками lux-theme.css (коммиты
  `fix(lux): …` по каждому циклу скриншот→правка).

### Task 6: README — приёмка этапа

- [ ] В раздел Lux-режима README добавить:

```markdown
### Дев-флаги (запуск без камеры)

    http://localhost:5173/?noTracker                    # без вебки, нейтральный взгляд
    http://localhost:5173/?noTracker&forcePhase=MIRROR  # сразу зеркало (для вёрстки)

### Приёмка этапа «Зеркало» (№3.1)

- [ ] IDLE: слайдшоу + логотип + «Подойдите ближе», кнопок нет
- [ ] MIRROR: кнопки интерьеров проявляются вместе с зеркалом, тач работает
- [ ] Выбор интерьера кнопкой = выбор клавишей (подсветка синхронна)
- [ ] UI читается на светлом и тёмном интерьере
```

- [ ] `npx vitest run && npm run build` → зелёное; `git add README.md && git commit -m "docs: приёмка этапа «Зеркало» и дев-флаги"`
