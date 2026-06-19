# Staged Mirror — Phase 2: explicit Stage pipeline (restructure `render()`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Превратить процедурный `LuxCompositor.render()` (≈240 строк) в явный упорядоченный конвейер стадий, **не изменив ни одного пикселя**: чистый GL-free модуль контроля порядка (`stages.ts`) + переписанный `render()`, который итерирует активные стадии. Плюс удаление мёртвого `roomShadowMat`-блока.

**Architecture:** `src/lux/stages.ts` экспортирует `StageId`, `StageInputs`/`StageFrame`, упорядоченный `STAGE_ORDER`, чистый предикат `stageEnabled(id, f)` и `activeStages(f)` — **без импорта three.js**, поэтому порядок/условия тестируются в vitest без GPU. `render()` строит `StageFrame` и делает `for (const id of activeStages(f)) this.runStage(id, f)`, где `runStage` — switch с **дословно перенесёнными** блоками текущего `render()`. GL-код (материалы, RT, `pass()`) остаётся на `LuxCompositor` как есть.

**Tech Stack:** TypeScript, three.js (только в compositor.ts; stages.ts чист), vitest.

---

## Verification note (карта сверена adversarial-проверкой)

Карта `render()`→стадии прошла независимую проверку против исходника. Внесённые ПОПРАВКИ (критичны для «без смены пикселей»):
- **`fallbackSilhouette`** включается при `mirrorVisible && toggles.shadow && person && !(shadowData && personFloor)` — НЕ `!shadowData`. (Иначе пропадает фолбэк-тень при `shadowData!=null, personFloor==null`.)
- **`bakedShadow` и `proxyShadow` независимы** (оба могут идти в одном кадре) — каждый со своим предикатом, НЕ `else-if`.
- **bloom НЕ гейтим на `mirrorVisible`** (спека P2 это упоминала, но проверка показала: это сменило бы IDLE-картинку, а хазард `wrapRT_A` уже безвреден — `grainMat` сэмплит `tBloom` только при `uBloomOn=1`). `grainMat.uBloomOn` присваивается **безусловно каждый кадр** (как сейчас, строка 781) — сохранить.
- **`personA/personB` RT НЕ добавляем** (спека P2 предлагала «unused» — YAGNI: добавим в фазе де-шэдоу P6, когда реально нужны).
- **`shadowRT2`-дисциплина:** каждая теневая стадия пишет `shadowRT2`, затем блит обратно в `compositeRT` до следующей — сохранить дословно.

## File Structure

- **Create `src/lux/stages.ts`** — чистый контроль конвейера: `StageId`, `StageInputs`, `StageFrame`, `STAGE_ORDER`, `PROXY_SHADOW_ENABLED`, `stageEnabled`, `activeStages`. БЕЗ `import * as THREE`.
- **Create `src/lux/stages.test.ts`** — тест порядка по сверенной таблице сценариев.
- **Modify `src/lux/compositor.ts`** — `render()` → `buildFrame` + `runStage` switch (дословный перенос блоков); удалить `roomShadowMat` (поле, ctor-инициализацию, `if(false)`-блок); импортировать `PROXY_SHADOW_ENABLED` из `./stages` (убрать локальную копию).

---

### Task 1: Чистый модуль контроля конвейера `stages.ts` + тест порядка (GL-free)

**Files:**
- Create: `src/lux/stages.ts`
- Test: `src/lux/stages.test.ts`

- [ ] **Step 1: Написать падающий тест порядка**

Создать `src/lux/stages.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { activeStages, STAGE_ORDER, type StageFrame, type StageInputs } from './stages'

// Базовый StageInputs; точечно переопределяем под сценарий.
function inputs(over: Partial<StageInputs>): StageInputs {
  return {
    toggles: { shadow: true, bloom: false },
    person: null, shadowData: null, personFloor: null, pose: null, feetUV: null,
    slides: { visible: 0, a: null }, fade: 0,
    ...over,
  }
}
function frame(mirrorVisible: boolean, over: Partial<StageInputs>): StageFrame {
  return { opts: inputs(over), mirrorVisible, sx: 1, sy: 1 }
}

const PERSON = {} // непустой маркер текстуры
const SHADOW_BAKED = { bakedShadow: {} }
const SHADOW_NOBAKE = { bakedShadow: null }
const FLOOR = { F: [0, 0, 0], H: 1.7 }
const POSE = { world: [], healthy: 1 }
const FEET = { u: 0.5, v: 0.1, halfW: 0.1 }

describe('activeStages — порядок и предикаты (сверено с render())', () => {
  it('STAGE_ORDER — канонический порядок из 11 стадий', () => {
    expect(STAGE_ORDER).toEqual([
      'sceneBackground', 'compositeBase', 'idleSlides', 'bakedShadow', 'proxyShadow',
      'fallbackSilhouette', 'blobContact', 'person', 'bloom', 'grainPresent', 'fadeCurtain',
    ])
  })

  it('MIRROR + baked + floor + pose + feetUV + bloom on', () => {
    expect(activeStages(frame(true, {
      toggles: { shadow: true, bloom: true }, person: PERSON,
      shadowData: SHADOW_BAKED, personFloor: FLOOR, pose: POSE, feetUV: FEET,
    }))).toEqual(['sceneBackground', 'compositeBase', 'bakedShadow', 'proxyShadow', 'blobContact', 'person', 'bloom', 'grainPresent'])
  })

  it('MIRROR + shadowData present но personFloor null → фолбэк-силуэт + фигура', () => {
    // person рисуется ВСЕГДА при mirrorVisible+person (compositor.ts:751, независимо от теней)
    expect(activeStages(frame(true, {
      person: PERSON, shadowData: SHADOW_BAKED, personFloor: null,
    }))).toEqual(['sceneBackground', 'compositeBase', 'fallbackSilhouette', 'person', 'grainPresent'])
  })

  it('MIRROR + нет shadowData + feetUV → фолбэк-силуэт + блоб + фигура', () => {
    expect(activeStages(frame(true, {
      person: PERSON, shadowData: null, feetUV: FEET,
    }))).toEqual(['sceneBackground', 'compositeBase', 'fallbackSilhouette', 'blobContact', 'person', 'grainPresent'])
  })

  it('IDLE (mirror invisible) + slides + bloom on', () => {
    expect(activeStages(frame(false, {
      toggles: { shadow: true, bloom: true }, slides: { visible: 1, a: {} },
    }))).toEqual(['compositeBase', 'idleSlides', 'bloom', 'grainPresent'])
  })

  it('MIRROR + shadowData без baked + floor + pose → только proxy (без baked)', () => {
    expect(activeStages(frame(true, {
      person: PERSON, shadowData: SHADOW_NOBAKE, personFloor: FLOOR, pose: POSE,
    }))).toEqual(['sceneBackground', 'compositeBase', 'proxyShadow', 'person', 'grainPresent'])
  })

  it('MIRROR + baked + floor, pose null, feetUV → baked + блоб (без proxy)', () => {
    expect(activeStages(frame(true, {
      person: PERSON, shadowData: SHADOW_BAKED, personFloor: FLOOR, pose: null, feetUV: FEET,
    }))).toEqual(['sceneBackground', 'compositeBase', 'bakedShadow', 'blobContact', 'person', 'grainPresent'])
  })

  it('MIRROR + shadow OFF + feetUV + bloom on + fade>0 → без теней, со шторкой', () => {
    expect(activeStages(frame(true, {
      toggles: { shadow: false, bloom: true }, person: PERSON, feetUV: FEET, fade: 0.5,
    }))).toEqual(['sceneBackground', 'compositeBase', 'person', 'bloom', 'grainPresent', 'fadeCurtain'])
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run src/lux/stages.test.ts`
Expected: FAIL — `Cannot find module './stages'`.

- [ ] **Step 3: Создать `src/lux/stages.ts`**

```ts
// Контроль конвейера компоновщика (спека §2). ЧИСТЫЙ модуль — без three.js,
// чтобы порядок/условия стадий тестировались без GPU. GL-исполнение — в compositor.ts.

export type StageId =
  | 'sceneBackground' | 'compositeBase' | 'idleSlides'
  | 'bakedShadow' | 'proxyShadow' | 'fallbackSilhouette' | 'blobContact'
  | 'person' | 'bloom' | 'grainPresent' | 'fadeCurtain'

// Канонический порядок исполнения (строгий). fadeCurtain — опц. эпилог.
export const STAGE_ORDER: StageId[] = [
  'sceneBackground', 'compositeBase', 'idleSlides',
  'bakedShadow', 'proxyShadow', 'fallbackSilhouette', 'blobContact',
  'person', 'bloom', 'grainPresent', 'fadeCurtain',
]

// Фича-флаг прокси-тени (перенесён сюда из compositor.ts как pipeline-config).
export const PROXY_SHADOW_ENABLED = true

// Только поля, от которых зависят предикаты (textures — как unknown|null, проверяем !!).
export interface StageInputs {
  toggles: { shadow: boolean; bloom: boolean }
  person: unknown | null
  shadowData: { bakedShadow?: unknown | null } | null
  personFloor: unknown | null
  pose: unknown | null
  feetUV: unknown | null
  slides: { visible: number; a: unknown | null }
  fade: number
}

export interface StageFrame {
  opts: StageInputs
  mirrorVisible: boolean   // = mirrorOpacity > 0.001 (вычисляет compositor)
  sx: number               // cover-fit фигуры/тени
  sy: number
}

export function stageEnabled(id: StageId, f: StageFrame): boolean {
  const o = f.opts
  const shadowBase = f.mirrorVisible && o.toggles.shadow && !!o.person
  switch (id) {
    case 'sceneBackground': return f.mirrorVisible
    case 'compositeBase': return true
    case 'idleSlides': return o.slides.visible > 0.001 && !!o.slides.a
    case 'bakedShadow': return shadowBase && !!o.shadowData && !!o.personFloor && !!o.shadowData.bakedShadow
    case 'proxyShadow': return shadowBase && !!o.shadowData && !!o.personFloor && PROXY_SHADOW_ENABLED && !!o.pose
    case 'fallbackSilhouette': return shadowBase && !(o.shadowData && o.personFloor)
    case 'blobContact': return shadowBase && !!o.feetUV
    case 'person': return f.mirrorVisible && !!o.person
    case 'bloom': return o.toggles.bloom
    case 'grainPresent': return true
    case 'fadeCurtain': return o.fade > 0.001
  }
}

export function activeStages(f: StageFrame): StageId[] {
  return STAGE_ORDER.filter((id) => stageEnabled(id, f))
}
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `npx vitest run src/lux/stages.test.ts`
Expected: PASS (8 тестов).

- [ ] **Step 5: Commit**

```bash
git add src/lux/stages.ts src/lux/stages.test.ts
git commit -m "feat(stages): чистый контроль конвейера (STAGE_ORDER/stageEnabled/activeStages) + тест порядка

GL-free; предикаты сверены с render() (вкл. исправленный fallbackSilhouette). Потребителя нет.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Переписать `render()` на стадии + удалить мёртвый `roomShadowMat`

**Files:**
- Modify: `src/lux/compositor.ts`

**Цель:** дословный перенос блоков `render()` в `runStage(id, f)`-switch, исполнение через `activeStages(f)`. Поведение идентично. Сверять каждый перенос с оригиналом построчно.

- [ ] **Step 1: Импорт + удалить локальный `PROXY_SHADOW_ENABLED`**

В шапке `compositor.ts` добавить:
```ts
import { activeStages, type StageFrame, type StageInputs, type StageId } from './stages'
```
Удалить локальную строку `const PROXY_SHADOW_ENABLED = true` (строка ~19) — теперь импортируется из `./stages` (используется только в `proxyShadow`-стадии; чтобы не плодить импорт, в `runStage` для proxy-предиката он уже учтён в `activeStages`, так что внутри блока повторная проверка `PROXY_SHADOW_ENABLED` не нужна — убрать её из перенесённого условия). Оставить `BAKED_FEET_U/V`, `BAKED_RAISE`.

- [ ] **Step 2: Удалить мёртвый `roomShadowMat`**

Удалить (сверено картой):
- поле `private roomShadowMat: THREE.ShaderMaterial` (объявление, ~строка 76);
- его конструирование в конструкторе (`this.roomShadowMat = new THREE.ShaderMaterial({...})`, блок ~388-457);
- весь `if (false as boolean) { ... }`-блок в `render()` (~699-722).
Больше `roomShadowMat` нигде не используется (нет `setSize`/публичных методов) — проверить `grep -n roomShadowMat src/lux/compositor.ts` → после удаления 0 совпадений.

- [ ] **Step 3: Ввести `buildFrame` + `runStage`, переписать `render()`-хвост**

Внутри `render(opts)` оставить вычисление производных в начале, затем заменить процедурный хвост на цикл. Структура:

```ts
render(opts: { /* ...без изменений тип... */ }): void {
  const mirrorVisible = opts.mirrorOpacity > 0.001

  // cover-fit фигуры/тени (как сейчас, строки ~614-620)
  let sx = 1, sy = 1
  if (opts.personAspect) {
    const va = opts.personAspect, ca = opts.canvasAspect
    if (ca > va) sy = va / ca; else sx = ca / va
  }

  const f: StageFrame = {
    opts: {
      toggles: { shadow: opts.toggles.shadow, bloom: opts.toggles.bloom },
      person: opts.person, shadowData: opts.shadowData, personFloor: opts.personFloor,
      pose: opts.pose, feetUV: opts.feetUV, slides: opts.slides, fade: opts.fade,
    } as StageInputs,
    mirrorVisible, sx, sy,
  }

  this._opts = opts // полные opts для runStage (см. ниже)
  for (const id of activeStages(f)) this.runStage(id, f)
}
```

Хранение полных `opts` для блоков: добавить приватное поле `private _opts!: typeof renderOptsType` — НО проще передавать `opts` через замыкание. Реализация: вынести `runStage` как метод, принимающий `(id, f, opts)`:

```ts
for (const id of activeStages(f)) this.runStage(id, f, opts)
```
и сигнатура `private runStage(id: StageId, f: StageFrame, opts: RenderOpts): void` — где `RenderOpts` это тип параметра `render` (вынести инлайн-тип `render(opts: {...})` в именованный `export interface RenderOpts {...}` над классом, чтобы переиспользовать в сигнатуре `runStage`).

- [ ] **Step 4: Реализовать `runStage` — дословный перенос блоков**

```ts
private runStage(id: StageId, f: StageFrame, opts: RenderOpts): void {
  const { sx, sy } = f
  switch (id) {
    case 'sceneBackground': { /* перенести compositor.ts:560-593 ВЕРБАТИМ */ break }
    case 'compositeBase':   { /* перенести :595-602 (clear + blit если mirrorVisible) */ break }
    case 'idleSlides':      { /* перенести :605-611 (без внешнего if — он в предикате) */ break }
    case 'bakedShadow':     { /* перенести :631-646 (без внешних if — в предикате) */ break }
    case 'proxyShadow':     { /* перенести :648-695, УБРАВ внешние if (mirrorVisible/shadow/person/shadowData/personFloor/PROXY/pose) — они в предикате; ВНУТРЕННЮЮ логику (lazy shadowScene3D, proxyRig.update, рендер shadowRT, multiplyBlit, feetCut) сохранить дословно */ break }
    case 'fallbackSilhouette': { /* перенести :724-730 (тело else-ветки groundShadowMat) */ break }
    case 'blobContact':     { /* перенести :732-747 (без внешнего if feetUV — в предикате) */ break }
    case 'person':          { /* перенести :751-765 */ break }
    case 'bloom':           { /* перенести :769-780 (bright-pass+blur). uBloomOn НЕ здесь */ break }
    case 'grainPresent':    {
      // ВАЖНО: uBloomOn присваивается ВСЕГДА (как строка 781), затем grain→экран (:783-788)
      this.grainMat.uniforms.uBloomOn.value = opts.toggles.bloom ? 1 : 0
      /* перенести :784-788 (renderer.clear + grainMat → null target) */
      break
    }
    case 'fadeCurtain':     { /* перенести :792-794 */ break }
  }
}
```

Правила переноса (соблюдать строго):
- Перенести код **дословно**, меняя только: внешние `if (...)`-обёртки, ставшие предикатами стадий, — УБРАТЬ (условие уже в `activeStages`). Внутренние условия (`if (opts.feetUV)` внутри baked/blob/proxy для смещения/выреза) — **СОХРАНИТЬ**.
- Все `this.<material>`, `this.<RT>`, `this.pass(...)`, `this.renderer.*`, `this.coverMat.uniforms.uUvScale` — без изменений. `coverMat.uUvScale` ставится в `sceneBackground` и читается baked/proxy позже в том же кадре (порядок сохранён).
- `bloom` пишет `wrapRT_A/B`; `person` читает `wrapRT_A`/`meanRT` и идёт ДО `bloom` — порядок в `STAGE_ORDER` это гарантирует.
- `grainMat.uBloomOn` — присваивать в `grainPresent` **безусловно** (см. выше), НЕ внутри `bloom`-блока.
- НЕ переносить `uBloomOn`-присвоение из старой строки 781 в `bloom`-стадию (оно жило вне bloom-условия и должно идти каждый кадр).

- [ ] **Step 5: Typecheck + сборка**

Run: `cd /Users/iman/Projects/background_ar && npx tsc --noEmit`
Expected: clean (0 ошибок). Если `RenderOpts` не вынесён — вынести инлайн-тип `render(opts:{...})` в `export interface RenderOpts {...}` и использовать в `render`/`runStage`.

- [ ] **Step 6: Прогнать весь тест-сьют**

Run: `npx vitest run`
Expected: PASS — все тесты зелёные (stages.test + существующие). Рендер юнит-тестами не покрыт (визуальную проверку делает контроллер интерактивно), поэтому зелёный сьют ≠ пиксельная идентичность — это нормально для этого шага.

- [ ] **Step 7: Самопроверка переноса (обязательно)**

`git diff` против предыдущего коммита: для КАЖДОЙ стадии открыть оригинальный блок (по номерам строк выше) и перенесённый в `runStage`, сверить построчно. Подтвердить: (1) ни одна внутренняя строка не изменена/потеряна; (2) убраны только внешние `if`-обёртки, ставшие предикатами; (3) `uBloomOn` присваивается безусловно в `grainPresent`; (4) `grep -n roomShadowMat src/lux/compositor.ts` → пусто; (5) порядок `STAGE_ORDER` совпадает с порядком в старом `render()`.

- [ ] **Step 8: Commit**

```bash
git add src/lux/compositor.ts
git commit -m "refactor(compositor): render() → явные стадии (activeStages + runStage), удалён мёртвый roomShadowMat

Дословный перенос блоков, порядок/условия сохранены (предикаты в ./stages). Без смены поведения:
bloom не гейтится (хазард wrapRT_A безвреден через uBloomOn); personA/B отложены (YAGNI). roomShadowMat
(поле+ctor+if(false)) удалён. Пиксельная идентичность подтверждается визуально контроллером.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (выполнено автором)

**1. Покрытие спеки (для этой фазы):** §2 «явный Stage[] поверх существующих FBO» — Task 2 (`activeStages`+`runStage`, RT-проводка дословна); §2.1 «порядок проходов уже корректен, делаем читаемым» — да; удаление мёртвого блока — Task 2 Step 2; тест порядка — Task 1. Отклонения от спеки P2 (bloom-гейт, personA/B) — обоснованы в Verification note (сохранение поведения / YAGNI), сверены проверкой карты.

**2. Плейсхолдеры:** Task 2 — рецепт переноса со ССЫЛКАМИ на конкретные блоки `compositor.ts` (это рефактор: «код» = существующие блоки, перемещаемые по карте), плюс полные скелеты `runStage`/`buildFrame`/`stages.ts` и полный тест. Это не плейсхолдеры — это точная инструкция перемещения; исполнитель читает текущий `compositor.ts` и переносит дословно.

**3. Согласованность типов/имён:** `StageId`/`StageInputs`/`StageFrame`/`STAGE_ORDER`/`stageEnabled`/`activeStages`/`PROXY_SHADOW_ENABLED` — едины в `stages.ts`, тесте и `compositor.ts`. `RenderOpts` выносится в именованный экспорт и используется в `render`/`runStage`. Предикаты в `stageEnabled` ↔ внешние `if` старого `render()` (1:1, с исправленным `fallbackSilhouette`).

**Риск-нюанс для исполнителя:** это поведение-сохраняющий рефактор GPU-кода без юнит-покрытия рендера. Главный риск — обронить/изменить строку при переносе. Step 7 (построчная сверка) обязателен. Контроллер дополнительно делает интерактивную визуальную проверку (приложение всё ещё рендерит человека в интерьере, нет чёрного экрана/краша) перед тем, как считать фазу закрытой.
