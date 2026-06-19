# Staged Mirror — Phase 1 (foundation): look-config externalization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ввести чистый, аддитивный слой пер-интерьерного look-конфига (`src/lux/look.ts`: типы, байт-равные дефолты, рекурсивный мёрж, загрузчик) как единый источник правды для всех ручек грейда/тона тени — под тестами, привязывающими дефолты к сегодняшним константам. **Рендер не меняется** (ничто ещё не потребляет look).

**Architecture:** Новый `src/lux/look.ts` определяет `ResolvedLook` (полный merged-look), `LOOK_DEFAULTS` (глобальные дефолты, **байт-равные** текущим `LUX_CONFIG` + дефолтам шейдер-материалов), `resolveLook(defaults, override)` (рекурсивный per-leaf deep-merge; массивы/скаляры заменяются целиком, мир побеждает) и `loadLook(world, fetchFn)` (fetch+parse `look.json` мира, толерантно к отсутствию/мусору → чистые дефолты). Потребитель отсутствует → вывод рендера не меняется by construction; миграция `render()` на чтение `ResolvedLook` — в следующих фазах за пиксельным golden-харнессом.

**Tech Stack:** TypeScript, three.js (только для конструирования дефолт-материалов в тестах-привязках), vitest.

---

## Re-sequencing note (relative to spec §8)

Спека ставит P0 (пиксельный golden) первым. Эта первая фаза — **look-config фундамент**, который **чисто аддитивен** (компоновщик его не читает) → «без смены картинки» гарантировано конструкцией, пиксельный гард не нужен. Самая опасная ловушка миграции (спека §9 риск #2 — тон тени по проходам и двойной `shadowStrength × 0.5`) закрывается здесь **числовыми** тестами-привязками, без GPU. Тяжёлый пиксельный golden-харнесс (spec P0) подключается прямо перед первой правкой `render()` (фаза P2), где он впервые нужен.

**Spec gap fixed here:** `wrapStrength` (light wrap, 0.85) отсутствовал в схеме `look.json` (спека §3). Добавлен под `grade.wrapStrength`; спека §3 обновлена в тон.

## File Structure

- **Create `src/lux/look.ts`** — единственная ответственность: типы look, `LOOK_DEFAULTS`, `resolveLook`, `loadLook`. Чистая логика + один fetch-обёртка. Не импортирует `compositor.ts` (во избежание подтягивания GPU-кода в тесты).
- **Create `src/lux/look.test.ts`** — тесты мёржа + тесты-привязки к источникам + тесты загрузчика.
- **Modify (только в Task 4) `docs/superpowers/specs/2026-06-19-staged-mirror-pipeline-design.md`** — добавить `grade.wrapStrength` в схему §3 (синхронизация спеки).

Ничего в `src/` больше не трогаем — фаза аддитивна.

---

### Task 1: Типы look, `LOOK_DEFAULTS`, `resolveLook` (deep-merge)

**Files:**
- Create: `src/lux/look.ts`
- Test: `src/lux/look.test.ts`

- [ ] **Step 1: Написать падающий тест мёржа**

Создать `src/lux/look.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { LOOK_DEFAULTS, resolveLook, type ResolvedLook } from './look'

describe('resolveLook (deep-merge)', () => {
  it('пустой/нулевой оверрайд → глубоко равно дефолтам', () => {
    expect(resolveLook(LOOK_DEFAULTS, null)).toEqual(LOOK_DEFAULTS)
    expect(resolveLook(LOOK_DEFAULTS, undefined)).toEqual(LOOK_DEFAULTS)
    expect(resolveLook(LOOK_DEFAULTS, {})).toEqual(LOOK_DEFAULTS)
  })

  it('скалярный оверрайд листа меняет только его, соседей не трогает', () => {
    const r = resolveLook(LOOK_DEFAULTS, { grade: { contrast: 1.2 } })
    expect(r.grade.contrast).toBe(1.2)
    expect(r.grade.temp).toBe(LOOK_DEFAULTS.grade.temp)
    expect(r.unify.bloom).toBe(LOOK_DEFAULTS.unify.bloom)
  })

  it('вложенный объект мёржится по листам', () => {
    const r = resolveLook(LOOK_DEFAULTS, { grade: { colorMatch: { cast: 0.9 } } })
    expect(r.grade.colorMatch.cast).toBe(0.9)
    expect(r.grade.colorMatch.exposure).toBe(LOOK_DEFAULTS.grade.colorMatch.exposure)
  })

  it('массив заменяется целиком (не мёржится поэлементно)', () => {
    const r = resolveLook(LOOK_DEFAULTS, { matte: { feather: [0.5, 0.9] } })
    expect(r.matte.feather).toEqual([0.5, 0.9])
    expect(r.matte.erode).toBe(LOOK_DEFAULTS.matte.erode)
  })

  it('не мутирует дефолты', () => {
    const before = JSON.stringify(LOOK_DEFAULTS)
    resolveLook(LOOK_DEFAULTS, { grade: { contrast: 99 } })
    expect(JSON.stringify(LOOK_DEFAULTS)).toBe(before)
  })

  it('результат — валидный ResolvedLook со всеми ветками', () => {
    const r: ResolvedLook = resolveLook(LOOK_DEFAULTS, { shadow: { strength: 0.7 } })
    expect(r.shadow.strength).toBe(0.7)
    expect(r.shadow.multiply.centerDark).toBe(LOOK_DEFAULTS.shadow.multiply.centerDark)
  })
})
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npx vitest run src/lux/look.test.ts`
Expected: FAIL — `Cannot find module './look'` (файл ещё не создан).

- [ ] **Step 3: Создать `src/lux/look.ts`**

```ts
// Пер-интерьерный look-конфиг (спека §3). Чистая логика: типы, дефолты, мёрж, загрузчик.
// НЕ импортирует compositor.ts (чтобы тесты не тянули GPU-код). Потребитель — позже (P2+).

export interface ColorMatchLook { cast: number; exposure: number }
export interface MatteLook { erode: number; feather: [number, number] }
export interface DeShadowLook {
  mode: 'off' | 'lite' | 'relight'
  strength: number; localLumaRadius: number; highlightKnee: number; shadowLift: number
}
export interface CropLook { edgeFade: number; sbsSeamGuard: number }
export interface GeomLook {
  anchorMode: 'coverfit' | 'height'
  mirrorMag: number; photo25dHeightFudge: number; footAnchorRaise: number; heightTrust: number
}
export interface GradeLook {
  colorMatch: ColorMatchLook
  contrast: number; temp: number; saturation: number; shade: number; wrapStrength: number
}
export interface ShadowBakedLook { feetUV: [number, number]; raise: number }
export interface ShadowProxyLook {
  centerDark: number; edgeDark: number; blur: number; shrinkK: number; feetCutR: number
}
export interface ShadowBlobLook { opacity: number; raise: number; ratioY: number }
export interface ShadowContactLook {
  enabled: boolean
  footLenCm: number; footWidthCm: number; darkness: number; edgeCm: number
  liftCm: [number, number]; visMin: number
}
export interface ShadowMultiplyLook {
  tint: [number, number, number]
  centerDark: number; edgeDark: number; blur: number; maxShadow: number
}
export interface ShadowLook {
  strength: number
  baked: ShadowBakedLook; proxy: ShadowProxyLook; blob: ShadowBlobLook
  contact: ShadowContactLook; multiply: ShadowMultiplyLook
  softness: number; bias: number
}
export interface UnifyLook {
  lut: string | null; lutStrength: number; grain: number; bloom: number
  bloomThreshold: number; vignette: number
}

export interface ResolvedLook {
  matte: MatteLook
  deshadow: DeShadowLook
  crop: CropLook
  geom: GeomLook
  grade: GradeLook
  shadow: ShadowLook
  unify: UnifyLook
}

export type DeepPartial<T> =
  T extends (infer _U)[] ? T :
  T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } :
  T
export type Look = DeepPartial<ResolvedLook>

// Дефолты БАЙТ-РАВНЫ текущим источникам (config.ts LUX_CONFIG + дефолты шейдер-материалов).
// Новые ветки (deshadow/contact/geom/unify.lut/saturation) — в NO-OP значениях, чтобы при
// будущей проводке (P2+) поведение не изменилось: deshadow.mode='off', contact.enabled=false,
// geom.anchorMode='coverfit', saturation=1.0, unify.lut=null.
export const LOOK_DEFAULTS: ResolvedLook = {
  matte: { erode: 0.0025, feather: [0.4, 0.8] },
  deshadow: { mode: 'off', strength: 0.5, localLumaRadius: 0.04, highlightKnee: 0.8, shadowLift: 0.1 },
  crop: { edgeFade: 0.03, sbsSeamGuard: 0.0015 },
  geom: { anchorMode: 'coverfit', mirrorMag: 1.0, photo25dHeightFudge: 1.0, footAnchorRaise: 0.04, heightTrust: 1.0 },
  grade: {
    colorMatch: { cast: 0.35, exposure: 0.15 },
    contrast: 1.08, temp: 0.02, saturation: 1.0, shade: 0.18, wrapStrength: 0.85,
  },
  shadow: {
    strength: 0.5,
    baked: { feetUV: [0.233, 0.161], raise: 0.05 },
    proxy: { centerDark: 0.12, edgeDark: 0.03, blur: 0.014, shrinkK: 0.89, feetCutR: 0.16 },
    blob: { opacity: 0.36, raise: 0.04, ratioY: 0.3 },
    contact: { enabled: false, footLenCm: 26, footWidthCm: 10, darkness: 0.85, edgeCm: 1.0, liftCm: [4, 12], visMin: 0.5 },
    multiply: { tint: [0.40, 0.35, 0.28], centerDark: 0.36, edgeDark: 0.072, blur: 0.009, maxShadow: 0.5 },
    softness: 1.6, bias: 0.005,
  },
  unify: { lut: null, lutStrength: 1.0, grain: 0.07, bloom: 0.5, bloomThreshold: 0.72, vignette: 0.0 },
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Рекурсивный per-leaf мёрж: объекты сливаются, массивы/скаляры заменяются целиком,
// override побеждает. Не мутирует входы (свежий объект на каждом уровне-объекте).
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const key of Object.keys(override)) {
    const o = (override as Record<string, unknown>)[key]
    if (o === undefined) continue
    const b = (base as Record<string, unknown>)[key]
    out[key] = isPlainObject(b) && isPlainObject(o) ? deepMerge(b, o) : o
  }
  return out as T
}

export function resolveLook(defaults: ResolvedLook, override: Look | null | undefined): ResolvedLook {
  return deepMerge(defaults, override ?? {})
}
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `npx vitest run src/lux/look.test.ts`
Expected: PASS (6 тестов в блоке `resolveLook (deep-merge)`).

- [ ] **Step 5: Commit**

```bash
git add src/lux/look.ts src/lux/look.test.ts
git commit -m "feat(look): типы look + LOOK_DEFAULTS + resolveLook (deep-merge), без потребителя

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Тесты-привязки — `LOOK_DEFAULTS` равны сегодняшним источникам (гард миграции)

Цель: связать дефолты с **живыми** текущими константами, чтобы при будущей проводке (P2+) рассинхрон
ловился тестом. Прямо закрывает ловушки спеки §9 #2: двойной `shadowStrength × 0.5` и `centerDark` ×3.

**Files:**
- Test: `src/lux/look.test.ts` (дописать второй `describe`)

- [ ] **Step 1: Дописать тесты-привязки в `src/lux/look.test.ts`**

Добавить в конец файла:

```ts
import { LUX_CONFIG } from './config'
import { makeMultiplyBlitMat, makeBakedShadowMat } from './multiplyBlit'

describe('LOOK_DEFAULTS привязаны к текущим источникам (гард миграции)', () => {
  it('grade ← LUX_CONFIG (config.ts)', () => {
    expect(LOOK_DEFAULTS.grade.contrast).toBe(LUX_CONFIG.contrast)
    expect(LOOK_DEFAULTS.grade.temp).toBe(LUX_CONFIG.temp)
    expect(LOOK_DEFAULTS.grade.shade).toBe(LUX_CONFIG.shadeAmount)
    expect(LOOK_DEFAULTS.grade.wrapStrength).toBe(LUX_CONFIG.wrapStrength)
    expect(LOOK_DEFAULTS.grade.colorMatch.cast).toBe(LUX_CONFIG.colorMatch.cast)
    expect(LOOK_DEFAULTS.grade.colorMatch.exposure).toBe(LUX_CONFIG.colorMatch.exposure)
  })

  it('matte / unify ← LUX_CONFIG (config.ts)', () => {
    expect(LOOK_DEFAULTS.matte.erode).toBe(LUX_CONFIG.erode)
    expect(LOOK_DEFAULTS.matte.feather).toEqual(LUX_CONFIG.feather)
    expect(LOOK_DEFAULTS.unify.grain).toBe(LUX_CONFIG.grainAmount)
    expect(LOOK_DEFAULTS.unify.bloom).toBe(LUX_CONFIG.bloom)
  })

  it('shadow strength/softness/bias ← LUX_CONFIG.shadow (config.ts)', () => {
    expect(LOOK_DEFAULTS.shadow.strength).toBe(LUX_CONFIG.shadow.strength)
    expect(LOOK_DEFAULTS.shadow.softness).toBe(LUX_CONFIG.shadow.softness)
    expect(LOOK_DEFAULTS.shadow.bias).toBe(LUX_CONFIG.shadow.bias)
  })

  it('shadow.multiply ← дефолты makeMultiplyBlitMat (multiplyBlit.ts)', () => {
    const u = makeMultiplyBlitMat().uniforms
    expect(LOOK_DEFAULTS.shadow.multiply.centerDark).toBe(u.uCenterDark.value)
    expect(LOOK_DEFAULTS.shadow.multiply.edgeDark).toBe(u.uEdgeDark.value)
    expect(LOOK_DEFAULTS.shadow.multiply.blur).toBe(u.uBlur.value)
    const tint = u.uShadowTint.value as { r: number; g: number; b: number }
    expect(LOOK_DEFAULTS.shadow.multiply.tint).toEqual([tint.r, tint.g, tint.b])
    // ловушка двойного множителя: per-world strength = единственная сила (config), материал тоже 0.5
    expect(u.uShadowStrength.value).toBe(LUX_CONFIG.shadow.strength)
  })

  it('shadow.baked.feetUV + multiply.maxShadow ← дефолты makeBakedShadowMat (multiplyBlit.ts)', () => {
    const u = makeBakedShadowMat().uniforms
    const feet = u.uFeetMask.value as { x: number; y: number }
    expect(LOOK_DEFAULTS.shadow.baked.feetUV).toEqual([feet.x, feet.y])
    expect(LOOK_DEFAULTS.shadow.multiply.maxShadow).toBe(u.uMaxShadow.value)
  })

  it('shadow.proxy ≠ shadow.multiply (ловушка centerDark ×3: 0.12 прокси против 0.36 материала)', () => {
    // прокси-оверрайды захардкожены в compositor.ts:677-679 (не экспортированы) — пиним литералами
    expect(LOOK_DEFAULTS.shadow.proxy.centerDark).toBe(0.12)
    expect(LOOK_DEFAULTS.shadow.proxy.edgeDark).toBe(0.03)
    expect(LOOK_DEFAULTS.shadow.proxy.blur).toBe(0.014)
    expect(LOOK_DEFAULTS.shadow.proxy.feetCutR).toBe(0.16)
    // ключ: это ДРУГИЕ поля, чем multiply.* — слияние в одно утроило бы тьму прокси
    expect(LOOK_DEFAULTS.shadow.proxy.centerDark).not.toBe(LOOK_DEFAULTS.shadow.multiply.centerDark)
  })

  it('хардкоды compositor.ts пинятся литералами (проводятся в P2/контакт-фазе)', () => {
    // источники: compositor.ts BAKED_RAISE=0.05; blob opacity 0.36 (:743), ratioY 0.3 (:741),
    // raise 0.04 (:739); bloomThreshold 0.72 (:194); shrinkK 0.89 (shadowScene3D.ts:127)
    expect(LOOK_DEFAULTS.shadow.baked.raise).toBe(0.05)
    expect(LOOK_DEFAULTS.shadow.blob.opacity).toBe(0.36)
    expect(LOOK_DEFAULTS.shadow.blob.ratioY).toBe(0.3)
    expect(LOOK_DEFAULTS.shadow.blob.raise).toBe(0.04)
    expect(LOOK_DEFAULTS.unify.bloomThreshold).toBe(0.72)
    expect(LOOK_DEFAULTS.shadow.proxy.shrinkK).toBe(0.89)
    expect(LOOK_DEFAULTS.crop.edgeFade).toBe(0.03)
    expect(LOOK_DEFAULTS.crop.sbsSeamGuard).toBe(0.0015)
  })

  it('новые ветки в NO-OP (поведение при проводке не изменится)', () => {
    expect(LOOK_DEFAULTS.deshadow.mode).toBe('off')
    expect(LOOK_DEFAULTS.shadow.contact.enabled).toBe(false)
    expect(LOOK_DEFAULTS.geom.anchorMode).toBe('coverfit')
    expect(LOOK_DEFAULTS.grade.saturation).toBe(1.0)
    expect(LOOK_DEFAULTS.unify.lut).toBeNull()
    expect(LOOK_DEFAULTS.unify.lutStrength).toBe(1.0)
    expect(LOOK_DEFAULTS.unify.vignette).toBe(0.0)
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что проходит (или поймать опечатку значения)**

Run: `npx vitest run src/lux/look.test.ts`
Expected: PASS. Если какой-то `toBe` упал — значение в `LOOK_DEFAULTS` (Task 1) расходится с источником: **исправить значение в `look.ts`** на то, что показывает источник, и перезапустить до PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lux/look.test.ts
git commit -m "test(look): гард миграции — LOOK_DEFAULTS привязаны к LUX_CONFIG и шейдер-материалам

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Загрузчик `loadLook` (fetch + толерантный парс)

**Files:**
- Modify: `src/lux/look.ts` (добавить `FetchLike` + `loadLook`)
- Test: `src/lux/look.test.ts` (дописать `describe`)

- [ ] **Step 1: Написать падающие тесты загрузчика**

Добавить в конец `src/lux/look.test.ts`:

```ts
import { loadLook } from './look'

const okFetch = (body: unknown) =>
  (async () => ({ ok: true, json: async () => body })) as unknown as
    (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

describe('loadLook', () => {
  it('валидный look.json → мёрж над дефолтами', async () => {
    const r = await loadLook('living', okFetch({ grade: { contrast: 1.3 } }))
    expect(r.grade.contrast).toBe(1.3)
    expect(r.grade.temp).toBe(LOOK_DEFAULTS.grade.temp)
  })

  it('файла нет (ok:false) → чистые дефолты', async () => {
    const f = (async () => ({ ok: false, json: async () => ({}) })) as unknown as
      (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
    expect(await loadLook('x', f)).toEqual(LOOK_DEFAULTS)
  })

  it('сеть упала (throw) → чистые дефолты', async () => {
    const f = (async () => { throw new Error('net') }) as unknown as
      (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
    expect(await loadLook('x', f)).toEqual(LOOK_DEFAULTS)
  })

  it('мусор вместо объекта → чистые дефолты', async () => {
    expect(await loadLook('x', okFetch('не объект'))).toEqual(LOOK_DEFAULTS)
    expect(await loadLook('x', okFetch(null))).toEqual(LOOK_DEFAULTS)
  })

  it('запрашивает правильный URL мира', async () => {
    let seen = ''
    const f = (async (u: string) => { seen = u; return { ok: true, json: async () => ({}) } }) as unknown as
      (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
    await loadLook('bedroom', f)
    expect(seen).toBe('/assets/worlds/bedroom/look.json')
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run src/lux/look.test.ts`
Expected: FAIL — `loadLook` не экспортирован (`loadLook is not a function` / import error).

- [ ] **Step 3: Добавить `loadLook` в `src/lux/look.ts`**

Дописать в конец `src/lux/look.ts`:

```ts
export type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

// Загрузка пер-мирового look.json. Толерантна: нет файла / сеть упала / мусор → чистые дефолты.
export async function loadLook(
  worldName: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<ResolvedLook> {
  try {
    const res = await fetchFn(`/assets/worlds/${worldName}/look.json`)
    if (!res.ok) return resolveLook(LOOK_DEFAULTS, null)
    const json = (await res.json()) as unknown
    return resolveLook(LOOK_DEFAULTS, isPlainObject(json) ? (json as Look) : null)
  } catch {
    return resolveLook(LOOK_DEFAULTS, null)
  }
}
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `npx vitest run src/lux/look.test.ts`
Expected: PASS (все три блока: deep-merge, гард миграции, loadLook).

- [ ] **Step 5: Прогнать весь сьют (ничего не сломали)**

Run: `npx vitest run`
Expected: PASS — все существующие тесты зелёные + новый `look.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lux/look.ts src/lux/look.test.ts
git commit -m "feat(look): loadLook — fetch + толерантный парс look.json (нет/мусор → дефолты)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Синхронизировать спеку (`wrapStrength` в схему §3)

**Files:**
- Modify: `docs/superpowers/specs/2026-06-19-staged-mirror-pipeline-design.md` (§3 jsonc `grade`)

- [ ] **Step 1: Добавить `wrapStrength` в схему look.json в спеке**

В блоке `"grade": { ... }` (§3) заменить строку:

```jsonc
  "grade":   { "colorMatch": { "cast": 0.35, "exposure": 0.15 },
               "contrast": 1.08, "temp": 0.02, "saturation": 1.0, "shade": 0.18 },
```

на:

```jsonc
  "grade":   { "colorMatch": { "cast": 0.35, "exposure": 0.15 },
               "contrast": 1.08, "temp": 0.02, "saturation": 1.0, "shade": 0.18, "wrapStrength": 0.85 },
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-06-19-staged-mirror-pipeline-design.md
git commit -m "docs(spec): добавить grade.wrapStrength в схему look.json (§3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (выполнено автором)

**1. Покрытие спеки (для ЭТОЙ фазы):** схема `look.json` (§3) — покрыта `ResolvedLook` + `LOOK_DEFAULTS` (все ветки matte/deshadow/crop/geom/grade/shadow/unify); мёрж «глубокий per-leaf, мир побеждает» (§3.2) — Task 1; байт-равенство дефолтов (§3.2, §9 #2) — Task 2; загрузчик «нет файла → дефолты» (§3.2) — Task 3. Проводка в компоновщик и dev-save — НЕ в этой фазе (P2/P3), отмечено.

**2. Плейсхолдеры:** нет TBD/«добавить обработку» — весь код приведён целиком, команды и ожидаемый вывод заданы.

**3. Согласованность типов/имён:** `ResolvedLook`/`Look`/`LOOK_DEFAULTS`/`resolveLook`/`loadLook`/`FetchLike` — единые во всех задачах; поля совпадают со схемой §3 (+ `grade.wrapStrength`, `shadow.contact.enabled`). `deepMerge` приватная, `resolveLook`/`loadLook` экспортируются.

**Риск-нюанс для исполнителя:** значения в Task 2 — это «истина по состоянию чтения исходников 2026-06-19». Если какой-то `toBe` упал — источник изменился; синхронизируй `LOOK_DEFAULTS` под фактический источник (не наоборот) и зафиксируй в коммите.
