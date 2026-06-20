# Staged Mirror — Phase 5: new lobby background + 1:1 height-lock geometry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Внести реальный продакшн-фон — 3ds-Max/Corona лобби `docs/50` (50мм-плейт + baked контактная тень) — как мир `lobby`. (2) Дать аватару **рост 1:1** (life-size) на этом фоне через `mirrorGeom.ts`, под флагом `geom.anchorMode` (legacy cover-fit по умолчанию → golden сохраняется; `height` → 1:1).

**Architecture:** Новый мир `public/assets/worlds/lobby/` (плейт `photo.png`, `shadow_baked.png`, `lights.json` с камерой 50мм + 3 лампами, `meta.json` flat). `worldScene` делает worldPos-EXR **опциональным** (грузит камеру/лампы/baked всегда; `worldPosData=null` если EXR нет). Новый чистый `mirrorGeom.ts`: аналитический floor-point (луч из камеры → плоскость Z=0) — заменяет EXR-сэмпл F для lobby; и `getScale` (height-lock 1:1). `main.ts` берёт F аналитически когда нет `worldPosData`, и при `anchorMode='height'` считает общий масштаб фигуры+тени. Компоновщик принимает `scaleOverride`.

**Tech Stack:** TypeScript, three.js, vitest, Vite.

**Guards:** `look.test`/`stages.test`/`mirrorGeom.test` (новый) + golden `?golden`. **Golden ре-бейзлайнится** на этой фазе (новый фон lobby = `worlds[0]`); при `anchorMode='coverfit'` (дефолт) масштаб фигуры тот же (cover-fit), меняется только плейт. Новый baseline фиксируется в Task 6.

## Camera spec (docs/50, канон — все числа отсюда)
50мм, сенсор 36мм → hFOV 39.60°, **vFOV 65.24° = 1.1386 рад**; камера LOCAL (м) `pos [6.445, 8.128, 1.60]`, `target [2.642, 6.058, 1.30]`, наклон ~4°, крен 0; `floorZ=0`; 1080×1920 (aspect 0.5625). Лампы LOCAL (м): key `L_Spot_B_001 [2.5373,3.0028,2.7401] w1.0`, fill1 `L_Wall_001 [2.5286,3.0529,1.3575] w0.5`, fill2 `Corona Light011 [2.5738,3.5551,2.2621] w0.6`. Стойка/ноги LOCAL `[3.191, 6.357, 0]` → экран ≈ `feetUV [0.500, 0.774]`.

---

### Task 1: Мир `lobby` (контент + конфиг)

**Files:** Create `public/assets/worlds/lobby/{meta.json,lights.json,look.json}`; copy plate+shadow; Modify `src/scenes/config.ts`

- [ ] **Step 1: Папка мира из docs/50**
```bash
cd /Users/iman/Projects/background_ar
mkdir -p public/assets/worlds/lobby
cp docs/50/lobby_50mm.png  public/assets/worlds/lobby/photo.png
cp docs/50/shadow_baked.png public/assets/worlds/lobby/shadow_baked.png
```
(depth.png НЕ нужен — `flat:true`, `depthAmountCm:0`; `worldScene.ts` игнорит глубину при flat.)

- [ ] **Step 2: `meta.json`** (НЕТ `worldPosFile` — EXR нет; см. Task 2):
```json
{
  "title": "Лобби",
  "format": "photo25d",
  "file": "photo.png",
  "aspect": 0.5625,
  "flat": true,
  "dollyMaxCm": 0,
  "depthAmountCm": 0,
  "shadowStrength": 0.6,
  "lightDirX": 0,
  "shadow": { "lightsFile": "lights.json" },
  "source": "3ds Max Corona 50mm"
}
```

- [ ] **Step 3: `lights.json`** (камера: `fovY` в РАДИАНАХ = vFOV 65.24°):
```json
{
  "lamps": [
    { "name": "L_Spot_B_001", "pos": [2.5373, 3.0028, 2.7401], "weight": 1.0 },
    { "name": "L_Wall_001", "pos": [2.5286, 3.0529, 1.3575], "weight": 0.5 },
    { "name": "Corona Light011", "pos": [2.5738, 3.5551, 2.2621], "weight": 0.6 }
  ],
  "camera": { "pos": [6.445, 8.128, 1.60], "target": [2.642, 6.058, 1.30], "fovY": 1.1386275, "aspect": 0.5625 },
  "floorZ": 0.0
}
```

- [ ] **Step 4: `look.json`** — якорь baked-тени под стойку (экранные ступни `[0.5, 0.774]`):
```json
{ "shadow": { "baked": { "feetUV": [0.5, 0.774], "raise": 0.05 } } }
```

- [ ] **Step 5: SCENE_CONFIG — lobby первым** (golden рендерит `worlds[0]`):
`src/scenes/config.ts`: `worlds: ['lobby', 'living', 'bedroom', 'balcony', 'demo-splat']`.

- [ ] **Step 6: Commit**
```bash
git add public/assets/worlds/lobby src/scenes/config.ts
git commit -m "feat(world): мир lobby из docs/50 (50мм плейт + baked-тень + камера/лампы)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
(После Task 2 lobby загрузится с камерой/лампами/baked без EXR. Сейчас, до Task 2, `worldScene` упадёт на отсутствии worldPosFile — поэтому Task 2 идёт сразу следом, до прогона.)

---

### Task 2: worldPos-EXR — опционален в `worldScene`

**Files:** Modify `src/scenes/worldScene.ts`

- [ ] **Step 1: Грузить камеру/лампы/baked без EXR**
В блоке shadow (worldScene.ts ~114-143): сейчас `await new EXRLoader().loadAsync(baseUrl + meta.shadow.worldPosFile)` — падает если `worldPosFile` нет. Сделать так: если `meta.shadow.worldPosFile` задан — грузить EXR (как сейчас), `worldPos`/`worldPosData` заполнены. Если НЕ задан — пропустить EXR, `worldPos=null`, `worldPosData=null`, но **lamps/camera/floorZ/bakedShadow собрать как обычно** (из lights.json + shadow_baked.png). `shadowData` строится в обоих случаях (с `worldPos:null` когда EXR нет).
Тип `shadowData.worldPos`/`worldPosData` → допускают `null` (обновить интерфейс BuiltWorld/shadowData). Потребители (`sampleWorldXYZ` в main.ts) уже будут гейтиться на `worldPosData != null` (Task 4).

- [ ] **Step 2: tsc + тесты + ручная загрузка lobby**
`npx tsc --noEmit`; `npx vitest run`. Поднять preview, выбрать lobby (клавиша `1` — lobby первый) в живом режиме ИЛИ через golden (Task 6): мир грузится, плейт виден, нет исключения в консоли (worldPos отсутствует, но shadowData есть с camera/lamps/baked).

- [ ] **Step 3: Commit**
```bash
git add src/scenes/worldScene.ts
git commit -m "feat(world): worldPos-EXR опционален (камера/лампы/baked грузятся без него)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `mirrorGeom.ts` — аналитический floor-point + height-lock (TDD)

**Files:** Create `src/lux/mirrorGeom.ts`, `src/lux/mirrorGeom.test.ts`

- [ ] **Step 1: Падающие тесты** (`mirrorGeom.test.ts`):
```ts
import { describe, expect, it } from 'vitest'
import { floorPointAnalytic, heightLockScale } from './mirrorGeom'

describe('floorPointAnalytic (луч камеры → пол Z=0)', () => {
  const cam = { pos: [6.445, 8.128, 1.60] as [number,number,number], target: [2.642, 6.058, 1.30] as [number,number,number], fovY: 1.1386275, aspect: 0.5625 }
  it('центр кадра падает на пол перед камерой (Z≈0, ближе target по XY)', () => {
    const P = floorPointAnalytic(cam, 0.5, 0.5, 0)
    expect(P[2]).toBeCloseTo(0, 3)               // на полу
    // точка пола дальше target (target Z=1.3 > 0): луч центра идёт ниже до Z=0
    expect(Number.isFinite(P[0]) && Number.isFinite(P[1])).toBe(true)
  })
  it('ниже по экрану (v больше) → ближе к камере по горизонтали', () => {
    const near = floorPointAnalytic(cam, 0.5, 0.9, 0)
    const far  = floorPointAnalytic(cam, 0.5, 0.55, 0)
    const dNear = Math.hypot(near[0]-6.445, near[1]-8.128)
    const dFar  = Math.hypot(far[0]-6.445, far[1]-8.128)
    expect(dNear).toBeLessThan(dFar)
  })
})

describe('heightLockScale (1:1)', () => {
  it('sy делает фигуру H_px высотой: sy = bboxHfrac·canvasH / H_px', () => {
    // H=1.72м, экран 19.74см физ высота, 960px канвас, bbox 0.8 кадра, mirrorMag 1
    const r = heightLockScale({ H_m: 1.72, bboxHfrac: 0.8, canvasHeightPx: 960, screenHcm: 19.74, mirrorMag: 1, personAspect: 1, canvasAspect: 0.5625 })
    const pxPerCm = 960 / 19.74
    const H_px = 1.72 * 100 * pxPerCm * 1
    expect(r.sy).toBeCloseTo(0.8 * 960 / H_px, 4)
    expect(r.sx).toBeGreaterThan(0)              // un-stretched (см. реализацию)
  })
  it('mirrorMag масштабирует линейно', () => {
    const base = heightLockScale({ H_m: 1.7, bboxHfrac: 0.8, canvasHeightPx: 960, screenHcm: 20, mirrorMag: 1, personAspect: 1, canvasAspect: 0.5625 })
    const big  = heightLockScale({ H_m: 1.7, bboxHfrac: 0.8, canvasHeightPx: 960, screenHcm: 20, mirrorMag: 1.2, personAspect: 1, canvasAspect: 0.5625 })
    expect(big.sy).toBeCloseTo(base.sy / 1.2, 5) // больше mirrorMag → меньше sy (крупнее фигура)
  })
})
```

- [ ] **Step 2: Запустить — падает** (`npx vitest run src/lux/mirrorGeom.test.ts` → нет модуля).

- [ ] **Step 3: `mirrorGeom.ts`** (чистый, без three.js):
```ts
export type Vec3 = [number, number, number]
export interface CamSpec { pos: Vec3; target: Vec3; fovY: number; aspect: number }

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]]
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0],a[1],a[2])||1; return [a[0]/l,a[1]/l,a[2]/l] }
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]

// Луч из камеры через экранный пиксель (u,v ∈ [0,1], v сверху-вниз) → пересечение с полом Z=floorZ.
// up = +Z мира. Возвращает мировую точку пола.
export function floorPointAnalytic(cam: CamSpec, u: number, v: number, floorZ: number): Vec3 {
  const fwd = norm(sub(cam.target, cam.pos))
  const worldUp: Vec3 = [0, 0, 1]
  const right = norm(cross(fwd, worldUp))
  const up = norm(cross(right, fwd))
  const t2 = Math.tan(cam.fovY / 2)
  const xN = (2*u - 1) * t2 * cam.aspect
  const yN = (1 - 2*v) * t2            // v сверху→низ: верх кадра = +up
  const dir: Vec3 = norm([
    fwd[0] + xN*right[0] + yN*up[0],
    fwd[1] + xN*right[1] + yN*up[1],
    fwd[2] + xN*right[2] + yN*up[2],
  ])
  const denom = dir[2] || 1e-6
  const tHit = (floorZ - cam.pos[2]) / denom
  return [cam.pos[0] + dir[0]*tHit, cam.pos[1] + dir[1]*tHit, cam.pos[2] + dir[2]*tHit]
}

// Height-lock: масштаб uUvScale, делающий ФИГУРУ ростом H_px на экране (life-size 1:1).
// person-проход сэмплит видео как uv=(vUv-0.5)*scale+0.5 → меньше sy = крупнее фигура.
// Фигура занимает bboxHfrac кадра видео; её экранная доля = bboxHfrac/sy. Нужна = H_px/canvasH.
export function heightLockScale(p: {
  H_m: number; bboxHfrac: number; canvasHeightPx: number; screenHcm: number
  mirrorMag: number; personAspect: number; canvasAspect: number
}): { sx: number; sy: number } {
  const pxPerCm = p.canvasHeightPx / p.screenHcm
  const H_px = p.H_m * 100 * pxPerCm * p.mirrorMag
  const sy = (p.bboxHfrac * p.canvasHeightPx) / Math.max(H_px, 1)
  // без растяжения: сохранить пиксельный аспект фигуры (как cover-fit).
  // person-видео аспект personAspect; канвас canvasAspect → sx = sy * (personAspect / canvasAspect)
  const sx = sy * (p.personAspect / p.canvasAspect)
  return { sx, sy }
}
```
*(Реализация sx/sy сверяется тестом Step 1; при расхождении — поправить формулу, не тест, чтобы цель «фигура = H_px» держалась.)*

- [ ] **Step 4: Запустить — проходит** + весь сьют (`npx vitest run`).

- [ ] **Step 5: Commit**
```bash
git add src/lux/mirrorGeom.ts src/lux/mirrorGeom.test.ts
git commit -m "feat(geom): mirrorGeom — аналитический floor-point + height-lock 1:1 (чистый, TDD)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `main.ts` — аналитический F (без EXR) + общий масштаб при anchorMode='height'

**Files:** Modify `src/main.ts`

- [ ] **Step 1: F аналитически когда нет worldPosData**
В цикле, где сейчас `F = sampleWorldXYZ(sd.worldPosData, u, v)` (main.ts ~272): если `sd.worldPosData` есть — как сейчас; иначе `F = floorPointAnalytic(sd.camera, 1-(x0+x1)/2, 1-y1, sd.floorZ)` (тот же mirror-U / низ-bbox-V, что у feetUV/sampleWorldXYZ). Импортировать `floorPointAnalytic` из `./lux/mirrorGeom`. Это включает baked/proxy тени для lobby (personFloor становится не-null).

- [ ] **Step 2: Общий масштаб при height-lock**
Перед `compositor.render({...})`: `const look0 = worldLooks[switcher.index]`. Если `look0.geom.anchorMode === 'height'` И есть `personFloor` (H) И `t?.bbox` → вычислить `scaleOverride = heightLockScale({ H_m: smoothH, bboxHfrac: (y1-y0), canvasHeightPx: innerHeight*pixelRatio?, screenHcm: calibration.screenHcm, mirrorMag: look0.geom.mirrorMag, personAspect: person.videoAspect ?? 1, canvasAspect: innerWidth/innerHeight })`. Применить EWMA-сглаживание к scaleOverride (k=1-exp(-dt·4)) во избежание дрожи. Иначе `scaleOverride = undefined` (cover-fit). Передать `scaleOverride` в `compositor.render`.
*(Если `!sd` / нет H → height-lock невозможен → cover-fit fallback. См. compositor Task 5.)*

- [ ] **Step 3: tsc + тесты**
`npx tsc --noEmit`; `npx vitest run` (зелёные).

- [ ] **Step 4: Commit**
```bash
git add src/main.ts
git commit -m "feat(geom): F аналитически без EXR (lobby) + scaleOverride при anchorMode=height (EWMA)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Компоновщик принимает `scaleOverride` (общий масштаб фигуры+тени)

**Files:** Modify `src/lux/compositor.ts`

- [ ] **Step 1: `RenderOpts.scaleOverride`**
Добавить `scaleOverride?: { sx: number; sy: number }` в `RenderOpts`.

- [ ] **Step 2: render() использует override**
Где считается cover-fit `sx/sy` (~compositor.ts:506-513): `let sx=1, sy=1; if (opts.scaleOverride) { sx = opts.scaleOverride.sx; sy = opts.scaleOverride.sy } else if (opts.personAspect) { /* существующий cover-fit */ }`. Дальше тот же `f.StageFrame.sx/sy` → **и фигура (person), и тени (blob/silhouette/baked uUvScale) берут единый sx/sy** (уже так — они читают из f/coverMat). НИЧЕГО в порядке стадий не менять.

- [ ] **Step 3: golden — anchorMode coverfit (детерминизм)**
`runGolden` (golden.ts): `look=worldLooks[0]` → lobby look (anchorMode 'coverfit' дефолт) → `scaleOverride` НЕ передаётся (golden не считает height-lock; personFloor у golden... сейчас null). Подтвердить: golden рендерит lobby-плейт с cover-fit фигурой. (Golden НЕ включает height-lock — нужен живой H. Достаточно cover-fit для детерминизма; 1:1 валидируется живьём.)

- [ ] **Step 4: tsc + тесты**
`npx tsc --noEmit`; `npx vitest run`.

- [ ] **Step 5: Commit**
```bash
git add src/lux/compositor.ts
git commit -m "feat(geom): compositor scaleOverride (единый масштаб фигуры+тени для height-lock)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Golden ре-бейзлайн (lobby) + визуальная проверка (контроллер)

- [ ] **Step 1: Новый golden-baseline на lobby**
Поднять preview (restart — `worldScene`/config менялись), `?golden=1` → прочитать `window.__goldenHash`. Это **новый baseline** (фон сменился на lobby). Скриншот: фигура (силуэт) в лобби, baked контактная тень под ступнями (сдвинута к feetUV). Консоль чиста. *Контроллер фиксирует новый хэш в памяти/плане.*
- [ ] **Step 2: Визуальная проверка 1:1 (живой режим, опц.)**
В живом режиме (capture запущен), мир lobby, тоггл `geom.anchorMode='height'` (через look/dev-панель) → подойти на ~2.5 м → аватар читается в натуральный рост, ступни на полу, тень следует. (Точная 1:1-валидация — после матча реальной камеры по углу hFOV ~39.6°, метод у стены.)

---

## Self-Review (выполнено автором)
**1. Покрытие спеки:** новый фон lobby (Task 1-2, §3/§4 контент), worldPos-EXR опционален (снимает блокер docs/50), аналитический floor-point (§4.1 floor-метрология, Task 3/4), height-lock 1:1 + общий масштаб фигуры+тени (§4.2/4.3, Task 3/4/5), флаг geom.anchorMode (legacy coverfit → golden сохраняется при off), H-гистерезис (smoothH + EWMA на scaleOverride). Поля look.geom уже объявлены (P1).
**2. Плейсхолдеры:** контент-файлы, mirrorGeom-код + тесты, точечные правки worldScene/main/compositor со ссылками на строки приведены. Math height-lock — формула + цель + TDD-тест.
**3. Согласованность:** `floorPointAnalytic`/`heightLockScale`/`CamSpec` едины; `scaleOverride` сквозной (main→RenderOpts→render→f.sx/sy→все стадии); F аналитический гейтится `!worldPosData`; golden anchorMode=coverfit.
**Риски (из карты):** (а) golden ре-бейзлайнится — записать новый хэш, не путать с регрессом; (б) height-lock требует живой H (bbox+дистанция) — без shadowData/H → cover-fit fallback (Task 4/5); (в) аналитический F предполагает идеальный пол Z=0 (для lobby верно); EXR-сэмпл остаётся для миров с EXR; (г) mirrorMag-дрожь гасится EWMA; (д) точная 1:1 — после матча реальной камеры по углу (физический шаг юзера).
