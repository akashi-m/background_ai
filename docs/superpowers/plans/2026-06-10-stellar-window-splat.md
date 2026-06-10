# Stellar Window 2.0 (сплаты) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-person опыт на гауссовых сплатах: миры из папок `worlds/<имя>/` (сплат или 2.5D-фото), параллакс + плавный «въезд» при подходе к экрану, генерация мира из одной картинки через Marble World API. Спека: `docs/superpowers/specs/2026-06-10-stellar-window-splat-design.md`.

**Architecture:** Существующий конвейер (MediaPipe-трекинг → One-Euro → off-axis проекция) не меняется. Сцена становится «миром»: папка с meta.json + сплат (рендер через Spark, объект three.js) или photo25d (существующий depthPhoto). Въезд — чистая функция eye.z → сдвиг мира к экрану. Переключение миров — обобщённая стейт-машина с фейдом (1..9, W/M).

**Tech Stack:** three.js ^0.180, @sparkjsdev/spark (3DGS-рендер), MediaPipe tasks-vision (есть), Vitest, Marble World API (генерация миров).

## Структура файлов

```
src/app/dolly.ts                 eye.z → проезд камеры, см (чистая, тесты)   [новый]
src/app/worldMeta.ts             парсинг/валидация meta.json (чистая, тесты) [новый]
src/app/worldSwitcher.ts         стейт-машина миров с фейдом (тесты)         [новый, замена modes.ts]
src/scenes/worldScene.ts         мир из meta: Spark-сплат | photo25d         [новый]
src/scenes/config.ts             список миров                                 [упрощается]
src/debug/align.ts               выравнивание мира клавишами + сохранение     [новый]
src/main.ts                      миры, клавиши 1..9/W/M, dolly               [переписывается]
scripts/gen-world.mjs            картинка → Marble API → папка мира          [новый]
public/assets/worlds/<имя>/      world.spz | photo.png+depth.png, meta.json  [контент]
УДАЛЯЮТСЯ (git хранит историю): src/app/modes.ts(+test), src/scenes/mirrorScene.ts,
windowScene.ts, bedroom.ts, textures.ts. ОСТАЮТСЯ: depthPhoto.ts (формат photo25d),
compositor.ts (фейд), segmenter.ts (выключен, не импортируется из main).
```

---

### Task 1: Апгрейд three.js до 0.180 + установка Spark

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Обновить зависимости**

Run:
```bash
npm i three@^0.180.0 @sparkjsdev/spark && npm i -D @types/three@^0.180.0
```

- [ ] **Step 2: Проверить, что ничего не сломалось**

Run: `npm test && npm run build`
Expected: 33 теста PASS; build чистый. Если tsc ругается на `Matrix4.makePerspective` — в r163+ появился опциональный параметр `coordinateSystem`, наши 6 аргументов остаются валидными; на `@mediapipe` типы не влияет. Любую реальную ошибку чинить по месту (ожидается ноль или тривиальные).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: three 0.180 + @sparkjsdev/spark для 3DGS-рендера"
```

---

### Task 2: Dolly — въезд от расстояния до зрителя

**Files:**
- Create: `src/app/dolly.ts`
- Test: `src/app/dolly.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { describe, it, expect } from 'vitest'
import { dollyFromEyeZ, DEFAULT_DOLLY_RANGE } from './dolly'

const MAX = 150

describe('dollyFromEyeZ', () => {
  it('дальше farCm → проезд 0', () => {
    expect(dollyFromEyeZ(100, MAX)).toBe(0)
    expect(dollyFromEyeZ(DEFAULT_DOLLY_RANGE.farCm, MAX)).toBe(0)
  })

  it('ближе nearCm → полный проезд', () => {
    expect(dollyFromEyeZ(DEFAULT_DOLLY_RANGE.nearCm, MAX)).toBe(MAX)
    expect(dollyFromEyeZ(20, MAX)).toBe(MAX)
  })

  it('середина диапазона → половина проезда (smoothstep симметричен)', () => {
    const mid = (DEFAULT_DOLLY_RANGE.farCm + DEFAULT_DOLLY_RANGE.nearCm) / 2
    expect(dollyFromEyeZ(mid, MAX)).toBeCloseTo(MAX / 2, 6)
  })

  it('монотонно растёт при приближении', () => {
    let prev = -1
    for (let z = DEFAULT_DOLLY_RANGE.farCm; z >= DEFAULT_DOLLY_RANGE.nearCm; z -= 5) {
      const d = dollyFromEyeZ(z, MAX)
      expect(d).toBeGreaterThanOrEqual(prev)
      prev = d
    }
  })

  it('анти-дрожь: у границы зоны скорость ~0 (дрожание z почти не двигает мир)', () => {
    expect(dollyFromEyeZ(DEFAULT_DOLLY_RANGE.farCm - 2, MAX)).toBeLessThan(1)
    expect(dollyFromEyeZ(DEFAULT_DOLLY_RANGE.nearCm + 2, MAX)).toBeGreaterThan(MAX - 1)
  })
})
```

- [ ] **Step 2: Убедиться, что падает**

Run: `npm test`
Expected: FAIL — `Cannot find module './dolly'`

- [ ] **Step 3: Реализация**

```ts
// «Въезд» в мир: подходишь к экрану → мир плавно едет навстречу.
// Smoothstep вместо линейной кривой: нулевая скорость на обоих краях диапазона,
// поэтому дрожание трекинга у границы зоны не дёргает картинку —
// гистерезис из спеки реализован самой формой кривой.
export interface DollyRange {
  farCm: number  // с этого расстояния начинается въезд
  nearCm: number // на этом расстоянии въезд максимален
}

export const DEFAULT_DOLLY_RANGE: DollyRange = { farCm: 80, nearCm: 30 }

export function dollyFromEyeZ(eyeZcm: number, maxCm: number, r: DollyRange = DEFAULT_DOLLY_RANGE): number {
  const t = Math.min(1, Math.max(0, (r.farCm - eyeZcm) / (r.farCm - r.nearCm)))
  const s = t * t * (3 - 2 * t)
  return s * maxCm
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `npm test`
Expected: PASS (38 тестов)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: dolly-въезд от расстояния до зрителя (smoothstep, анти-дрожь)"
```

---

### Task 3: Валидация meta.json мира

**Files:**
- Create: `src/app/worldMeta.ts`
- Test: `src/app/worldMeta.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { describe, it, expect } from 'vitest'
import { parseWorldMeta } from './worldMeta'

const VALID_SPLAT = {
  title: 'Спальня',
  format: 'splat',
  file: 'world.spz',
}

const VALID_PHOTO = {
  title: 'Балкон',
  format: 'photo25d',
  file: 'photo.png',
  depthFile: 'depth.png',
  aspect: 2.357,
}

describe('parseWorldMeta', () => {
  it('валидный splat-мир: дефолты подставляются', () => {
    const m = parseWorldMeta(VALID_SPLAT, 'bedroom')
    expect(m.format).toBe('splat')
    expect(m.transform).toEqual({ position: [0, 0, 0], rotationYDeg: 0, scale: 1 })
    expect(m.dollyMaxCm).toBe(150)
  })

  it('валидный photo25d-мир с aspect', () => {
    const m = parseWorldMeta(VALID_PHOTO, 'balcony')
    expect(m.format).toBe('photo25d')
    expect(m.aspect).toBeCloseTo(2.357)
  })

  it('кастомный transform сохраняется', () => {
    const m = parseWorldMeta(
      { ...VALID_SPLAT, transform: { position: [1, 2, 3], rotationYDeg: 90, scale: 2.5 } },
      'bedroom',
    )
    expect(m.transform.scale).toBe(2.5)
    expect(m.transform.position).toEqual([1, 2, 3])
  })

  it('неизвестный format → ошибка с именем мира', () => {
    expect(() => parseWorldMeta({ ...VALID_SPLAT, format: 'mesh' }, 'bedroom'))
      .toThrow(/bedroom/)
  })

  it('photo25d без depthFile или aspect → ошибка', () => {
    expect(() => parseWorldMeta({ ...VALID_PHOTO, depthFile: undefined }, 'balcony')).toThrow(/balcony/)
    expect(() => parseWorldMeta({ ...VALID_PHOTO, aspect: undefined }, 'balcony')).toThrow(/balcony/)
  })

  it('не-объект → ошибка', () => {
    expect(() => parseWorldMeta(null, 'x')).toThrow(/x/)
    expect(() => parseWorldMeta('hello', 'x')).toThrow(/x/)
  })

  it('кривой transform.scale (0, NaN) → ошибка', () => {
    expect(() => parseWorldMeta({ ...VALID_SPLAT, transform: { position: [0,0,0], rotationYDeg: 0, scale: 0 } }, 'b')).toThrow(/b/)
  })
})
```

- [ ] **Step 2: Убедиться, что падает**

Run: `npm test`
Expected: FAIL — `Cannot find module './worldMeta'`

- [ ] **Step 3: Реализация**

```ts
// Контракт между контент-пайплайном и рантаймом: meta.json в папке мира.
export interface WorldTransform {
  position: [number, number, number] // см
  rotationYDeg: number
  scale: number
}

export interface WorldMeta {
  title: string
  format: 'splat' | 'photo25d'
  file: string        // world.spz | photo.png
  depthFile?: string  // только photo25d
  aspect?: number     // только photo25d (ширина/высота фото)
  transform: WorldTransform
  dollyMaxCm: number
  source?: string     // происхождение (marble:<id>, съёмка, ...)
}

const DEFAULT_TRANSFORM: WorldTransform = { position: [0, 0, 0], rotationYDeg: 0, scale: 1 }

function fail(world: string, why: string): never {
  throw new Error(`Битый meta.json мира «${world}»: ${why}`)
}

export function parseWorldMeta(json: unknown, worldName: string): WorldMeta {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) fail(worldName, 'не объект')
  const j = json as Record<string, unknown>

  if (typeof j.title !== 'string' || !j.title) fail(worldName, 'нет title')
  if (j.format !== 'splat' && j.format !== 'photo25d') fail(worldName, `неизвестный format: ${String(j.format)}`)
  if (typeof j.file !== 'string' || !j.file) fail(worldName, 'нет file')

  if (j.format === 'photo25d') {
    if (typeof j.depthFile !== 'string' || !j.depthFile) fail(worldName, 'photo25d требует depthFile')
    if (typeof j.aspect !== 'number' || !isFinite(j.aspect) || j.aspect <= 0) fail(worldName, 'photo25d требует aspect > 0')
  }

  let transform = DEFAULT_TRANSFORM
  if (j.transform !== undefined) {
    const t = j.transform as Record<string, unknown>
    const pos = t.position
    const okPos = Array.isArray(pos) && pos.length === 3 && pos.every((v) => typeof v === 'number' && isFinite(v))
    const okRot = typeof t.rotationYDeg === 'number' && isFinite(t.rotationYDeg)
    const okScale = typeof t.scale === 'number' && isFinite(t.scale) && t.scale > 0
    if (!okPos || !okRot || !okScale) fail(worldName, 'кривой transform')
    transform = { position: pos as [number, number, number], rotationYDeg: t.rotationYDeg as number, scale: t.scale as number }
  }

  let dollyMaxCm = 150
  if (j.dollyMaxCm !== undefined) {
    if (typeof j.dollyMaxCm !== 'number' || !isFinite(j.dollyMaxCm) || j.dollyMaxCm < 0) fail(worldName, 'кривой dollyMaxCm')
    dollyMaxCm = j.dollyMaxCm
  }

  return {
    title: j.title,
    format: j.format,
    file: j.file,
    depthFile: typeof j.depthFile === 'string' ? j.depthFile : undefined,
    aspect: typeof j.aspect === 'number' ? j.aspect : undefined,
    transform,
    dollyMaxCm,
    source: typeof j.source === 'string' ? j.source : undefined,
  }
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `npm test`
Expected: PASS (45 тестов)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: парсинг и валидация meta.json мира"
```

---

### Task 4: WorldSwitcher — стейт-машина миров

**Files:**
- Create: `src/app/worldSwitcher.ts`
- Test: `src/app/worldSwitcher.test.ts`

В этой задаче только создаём новые файлы. Старые `modes.ts`/`modes.test.ts` удаляются в Task 6 вместе с переписыванием main.ts (иначе main перестанет собираться).

- [ ] **Step 1: Падающий тест (адаптация modes.test.ts на индексы + next/prev)**

```ts
import { describe, it, expect } from 'vitest'
import { WorldSwitcher } from './worldSwitcher'

describe('WorldSwitcher', () => {
  it('старт: мир 0, фейда нет', () => {
    const s = new WorldSwitcher(3, 0.2)
    expect(s.index).toBe(0)
    expect(s.fade).toBe(0)
    expect(s.phase).toBe('IDLE')
  })

  it('переключение: фейд в чёрное, смена мира под шторкой, фейд обратно', () => {
    const s = new WorldSwitcher(3, 0.2)
    s.switchTo(2)
    s.update(0.1)
    expect(s.fade).toBeCloseTo(0.5, 5)
    expect(s.index).toBe(0) // ещё старый
    s.update(0.1)
    expect(s.index).toBe(2) // сменился под шторкой
    s.update(0.2)
    expect(s.fade).toBe(0)
    expect(s.phase).toBe('IDLE')
  })

  it('полный цикл < 0.5 с', () => {
    const s = new WorldSwitcher(2, 0.2)
    s.switchTo(1)
    let t = 0
    while (s.phase !== 'IDLE' && t < 1) { s.update(1 / 60); t += 1 / 60 }
    expect(t).toBeLessThan(0.5)
  })

  it('switchTo в тот же мир / мимо диапазона / во время фейда — игнор', () => {
    const s = new WorldSwitcher(2, 0.2)
    s.switchTo(0)
    expect(s.phase).toBe('IDLE')
    s.switchTo(5)
    expect(s.phase).toBe('IDLE')
    s.switchTo(1)
    s.update(0.1)
    s.switchTo(0) // во время фейда
    s.update(0.1)
    expect(s.index).toBe(1)
  })

  it('next/prev ходят по кругу', () => {
    const s = new WorldSwitcher(3, 0.001)
    const settle = () => { for (let i = 0; i < 10; i++) s.update(0.01) }
    s.next(); settle()
    expect(s.index).toBe(1)
    s.next(); settle()
    s.next(); settle()
    expect(s.index).toBe(0) // 2 → wrap → 0
    s.prev(); settle()
    expect(s.index).toBe(2)
  })
})
```

- [ ] **Step 2: Убедиться, что падает**

Run: `npm test`
Expected: FAIL — `Cannot find module './worldSwitcher'`

- [ ] **Step 3: Реализация**

```ts
export type Phase = 'IDLE' | 'FADE_OUT' | 'FADE_IN'

// Переключение миров через короткую чёрную шторку: FADE_OUT → смена → FADE_IN.
export class WorldSwitcher {
  index = 0
  phase: Phase = 'IDLE'
  fade = 0 // 0 — прозрачно, 1 — чёрный экран
  private target: number | null = null

  constructor(private count: number, private fadeDurationSec = 0.2) {}

  switchTo(index: number): void {
    if (index === this.index || index < 0 || index >= this.count || this.phase !== 'IDLE') return
    this.target = index
    this.phase = 'FADE_OUT'
  }

  next(): void { this.switchTo((this.index + 1) % this.count) }
  prev(): void { this.switchTo((this.index - 1 + this.count) % this.count) }

  update(dt: number): void {
    if (this.phase === 'FADE_OUT') {
      this.fade += dt / this.fadeDurationSec
      if (this.fade >= 1) {
        this.fade = 1
        this.index = this.target!
        this.target = null
        this.phase = 'FADE_IN'
      }
    } else if (this.phase === 'FADE_IN') {
      this.fade -= dt / this.fadeDurationSec
      if (this.fade <= 0) {
        this.fade = 0
        this.phase = 'IDLE'
      }
    }
  }
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `npm test`
Expected: PASS (50 тестов; старые modes-тесты ещё живы и тоже зелёные)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: WorldSwitcher — переключение N миров с фейдом"
```

---

### Task 5: worldScene — мир из meta (Spark-сплат | photo25d) + демо-сплат

**Files:**
- Create: `src/scenes/worldScene.ts`
- Create: `public/assets/worlds/demo-splat/meta.json` (+ скачать world.spz)

- [ ] **Step 1: src/scenes/worldScene.ts**

```ts
import * as THREE from 'three'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import type { WorldMeta } from '../app/worldMeta'
import { makeDepthPhotoMesh, fitCoverCm } from './depthPhoto'

// Мир, собранный из папки worlds/<имя>/.
// scene → dolly (анимируется въездом) → root (выравнивание из meta.transform).
export interface BuiltWorld {
  scene: THREE.Scene
  dolly: THREE.Group
  root: THREE.Group
  meta: WorldMeta
}

async function assertExists(url: string): Promise<void> {
  const res = await fetch(url, { method: 'HEAD' })
  if (!res.ok) throw new Error(`Не загрузился ассет: ${url} (HTTP ${res.status})`)
}

export async function buildWorld(
  baseUrl: string, // '/assets/worlds/bedroom/'
  meta: WorldMeta,
  screenWcm: number,
  screenHcm: number,
  renderer: THREE.WebGLRenderer,
): Promise<BuiltWorld> {
  const scene = new THREE.Scene()
  const dolly = new THREE.Group()
  scene.add(dolly)
  const root = new THREE.Group()
  root.position.set(...meta.transform.position)
  root.rotation.y = (meta.transform.rotationYDeg * Math.PI) / 180
  root.scale.setScalar(meta.transform.scale)
  dolly.add(root)

  if (meta.format === 'splat') {
    const url = baseUrl + meta.file
    await assertExists(url)
    // SparkRenderer должен лежать в той сцене, которую рендерим
    scene.add(new SparkRenderer({ renderer }))
    root.add(new SplatMesh({ url })) // Spark грузит и стримит сам (LOD)
  } else {
    const fit = fitCoverCm(meta.aspect!, -60, screenWcm, screenHcm)
    const mesh = await makeDepthPhotoMesh({
      photoUrl: baseUrl + meta.file,
      depthUrl: baseUrl + meta.depthFile!,
      widthCm: fit.widthCm,
      heightCm: fit.heightCm,
      zCm: -60,
      depthAmountCm: 28,
    })
    root.add(mesh)
  }

  return { scene, dolly, root, meta }
}
```

- [ ] **Step 2: Демо-сплат для проверки рендера (пока нет ключа Marble)**

Run:
```bash
mkdir -p public/assets/worlds/demo-splat && curl -L -o public/assets/worlds/demo-splat/world.spz "https://sparkjs.dev/assets/splats/butterfly.spz" && file public/assets/worlds/demo-splat/world.spz
```
Expected: файл скачан (несколько МБ, тип data/zip). Если URL не отвечает — взять любой .spz/.ply пример со страницы sparkjs.dev или из галереи Marble (worldlabs.ai) и положить как `world.spz`.

- [ ] **Step 3: public/assets/worlds/demo-splat/meta.json**

```json
{
  "title": "Демо-сплат (бабочка Spark)",
  "format": "splat",
  "file": "world.spz",
  "transform": { "position": [0, 0, -100], "rotationYDeg": 0, "scale": 100 },
  "dollyMaxCm": 80,
  "source": "sparkjs.dev sample"
}
```
(Масштаб 100: примеры Spark в метрах, наш мир в сантиметрах; точное значение подберётся выравниванием в Task 7.)

- [ ] **Step 4: Проверка типов**

Run: `npm run build`
Expected: чисто. (Рендер-проверка глазами будет после Task 6, когда main.ts начнёт грузить миры.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: worldScene — мир из meta.json (Spark-сплат | photo25d) + демо-сплат"
```

---

### Task 6: main.ts — миры, клавиши, dolly

**Files:**
- Modify: `src/main.ts` (переписывается), `src/scenes/config.ts` (упрощается)
- Create: `public/assets/worlds/bedroom/`, `public/assets/worlds/balcony/` (из текущих ассетов)
- Delete: `src/app/modes.ts`, `src/app/modes.test.ts`, `src/scenes/mirrorScene.ts`, `src/scenes/windowScene.ts`, `src/scenes/bedroom.ts`, `src/scenes/textures.ts`

- [ ] **Step 1: Папки миров из текущих ассетов**

Run:
```bash
mkdir -p public/assets/worlds/bedroom public/assets/worlds/balcony
git mv public/assets/bedroom_eye.png public/assets/worlds/bedroom/photo.png
git mv public/assets/bedroom_eye_depth.png public/assets/worlds/bedroom/depth.png
git mv public/assets/city_wide.png public/assets/worlds/balcony/photo.png
git mv public/assets/city_wide_depth.png public/assets/worlds/balcony/depth.png
```

`public/assets/worlds/bedroom/meta.json`:
```json
{
  "title": "Спальня",
  "format": "photo25d",
  "file": "photo.png",
  "depthFile": "depth.png",
  "aspect": 1.0665,
  "dollyMaxCm": 25,
  "source": "gemini nano banana, референс заказчика"
}
```

`public/assets/worlds/balcony/meta.json`:
```json
{
  "title": "Балкон",
  "format": "photo25d",
  "file": "photo.png",
  "depthFile": "depth.png",
  "aspect": 2.357,
  "dollyMaxCm": 20,
  "source": "gemini nano banana, референс заказчика"
}
```
(dollyMax у photo25d маленький: «открытка» глубокого въезда не выдержит; у сплатов будет 80–150.)

- [ ] **Step 2: src/scenes/config.ts (заменить целиком)**

```ts
// Список миров = папки public/assets/worlds/<имя>/ с meta.json внутри.
// Клавиши 1..9 — прямой выбор, W — следующий, M — предыдущий.
export const SCENE_CONFIG = {
  worlds: ['bedroom', 'balcony', 'demo-splat'],
}
```

- [ ] **Step 3: src/main.ts (заменить целиком)**

```ts
import * as THREE from 'three'
import { openCamera, showFatalError } from './tracking/camera'
import { HeadTracker } from './tracking/headTracker'
import { loadCalibration } from './app/calibration'
import { applyOffAxis } from './render/offAxis'
import { Compositor } from './render/compositor'
import { WorldSwitcher } from './app/worldSwitcher'
import { parseWorldMeta } from './app/worldMeta'
import { buildWorld, type BuiltWorld } from './scenes/worldScene'
import { dollyFromEyeZ } from './app/dolly'
import { DebugPanel } from './debug/panel'
import { SCENE_CONFIG } from './scenes/config'

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Не загрузился ассет: ${url} (HTTP ${res.status})`)
  return res.json()
}

async function start() {
  const video = await openCamera()
  const calibration = loadCalibration()
  const tracker = new HeadTracker(video, calibration)
  await tracker.init()
  const compositor = new Compositor(video) // только чёрная шторка, фигура выключена

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(innerWidth, innerHeight)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  document.body.appendChild(renderer.domElement)
  addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight))

  // Загружаем все миры (их немного; Spark стримит сплаты с LOD сам)
  const worlds: BuiltWorld[] = await Promise.all(
    SCENE_CONFIG.worlds.map(async (name) => {
      const meta = parseWorldMeta(await fetchJson(`/assets/worlds/${name}/meta.json`), name)
      return buildWorld(`/assets/worlds/${name}/`, meta, calibration.screenWcm, calibration.screenHcm, renderer)
    }),
  )
  const switcher = new WorldSwitcher(worlds.length)

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return
    if (e.code === 'KeyW') switcher.next()
    if (e.code === 'KeyM') switcher.prev()
    const digit = /^Digit([1-9])$/.exec(e.code)
    if (digit) switcher.switchTo(Number(digit[1]) - 1)
  })

  const debug = new DebugPanel(calibration, () => { /* подхватится в следующем кадре */ })

  // возраст последнего кадра камеры — грубая оценка вклада камеры в задержку
  let lastVideoFrameAt = performance.now()
  const onVideoFrame = () => {
    lastVideoFrameAt = performance.now()
    ;(video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void }).requestVideoFrameCallback(onVideoFrame)
  }
  ;(video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void }).requestVideoFrameCallback(onVideoFrame)

  // Усиление параллакса масштабируется под экран: на проде (~120 см) — 1:1,
  // на ноутбуке мягче, иначе движение головы больше самого экрана.
  const PRODUCTION_SCREEN_W_CM = 120
  const parallaxGain = Math.min(1, Math.max(0.25, calibration.screenWcm / PRODUCTION_SCREEN_W_CM))

  const camera = new THREE.PerspectiveCamera()

  let last = performance.now()
  renderer.setAnimationLoop((now) => {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    switcher.update(dt)
    const eye = tracker.update(now, dt)
    const safeZ = Math.min(Math.max(eye.z, 20), 300)
    const safeEye = { x: eye.x * parallaxGain, y: eye.y * parallaxGain, z: safeZ }
    const cmPerPx = calibration.screenWcm / screen.width
    applyOffAxis(camera, safeEye, innerWidth * cmPerPx, innerHeight * cmPerPx)

    const active = worlds[switcher.index]
    // Въезд: подошёл к экрану → мир едет навстречу (сдвиг к плоскости экрана)
    active.dolly.position.z = dollyFromEyeZ(safeZ, active.meta.dollyMaxCm)
    renderer.render(active.scene, camera)
    compositor.render(renderer, null, 0, switcher.fade)
    debug.frame(safeEye, tracker.faceVisible, 0, performance.now() - lastVideoFrameAt)
  })
}

start().catch(showFatalError)
```

- [ ] **Step 4: Удалить устаревшие файлы**

Run:
```bash
git rm src/app/modes.ts src/app/modes.test.ts src/scenes/mirrorScene.ts src/scenes/windowScene.ts src/scenes/bedroom.ts src/scenes/textures.ts
```
(`src/tracking/segmenter.ts` НЕ удалять — выключенный код по спеке остаётся; он самодостаточен и tsc его проходит.)

- [ ] **Step 5: Проверка**

Run: `npm test && npm run build`
Expected: тесты PASS — 45 (было 50 после Task 4, минус 5 удалённых modes-тестов), build чистый.

Run: `npm run dev` + `curl -s http://localhost:5173 | head -3` (сервер отвечает), остановить.

- [ ] **Step 6: Ручная проверка (человеком, позже)**

- `1` спальня (photo25d) / `2` балкон / `3` демо-сплат — переключение с фейдом
- В демо-сплате виден объект-сплат; параллакс от головы работает
- Подход к экрану — мир плавно едет навстречу (на photo25d чуть-чуть, на сплате глубоко)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: рантайм миров — клавиши 1..9/W/M, dolly-въезд, Spark-рендер"
```

---

### Task 7: Выравнивание мира из debug-панели

**Files:**
- Create: `src/debug/align.ts`
- Modify: `src/main.ts` (подключение), `src/scenes/worldScene.ts` (применение сохранённого выравнивания)

- [ ] **Step 1: src/debug/align.ts**

```ts
import type { BuiltWorld } from '../scenes/worldScene'
import type { WorldTransform } from '../app/worldMeta'

// Выравнивание сгенерённого мира: клавиша A — вкл/выкл режим, затем
// стрелки — сдвиг X/Z, PgUp/PgDn — Y, [ ] — поворот, - = — масштаб.
// Каждое изменение пишется в localStorage и печатается готовым JSON
// для вставки в meta.json (выровнял один раз — мир готов).
const KEY_PREFIX = 'stellar-mirror.align.'

export function loadAlignOverride(worldName: string): WorldTransform | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + worldName)
    return raw ? (JSON.parse(raw) as WorldTransform) : null
  } catch {
    return null
  }
}

export class AlignController {
  private active = false
  private hint = document.createElement('div')

  constructor(private getWorld: () => BuiltWorld, private getWorldName: () => string) {
    this.hint.style.cssText =
      'position:fixed;bottom:8px;left:8px;color:#ff0;font:12px monospace;z-index:10;' +
      'background:rgba(0,0,0,.6);padding:6px;display:none;white-space:pre'
    document.body.appendChild(this.hint)

    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'KeyA') {
        this.active = !this.active
        this.hint.style.display = this.active ? 'block' : 'none'
        if (this.active) this.refresh()
        return
      }
      if (!this.active) return

      const root = this.getWorld().root
      const stepCm = e.shiftKey ? 10 : 1
      const stepDeg = e.shiftKey ? 10 : 1
      const stepScale = e.shiftKey ? 1.25 : 1.02
      switch (e.code) {
        case 'ArrowLeft': root.position.x -= stepCm; break
        case 'ArrowRight': root.position.x += stepCm; break
        case 'ArrowUp': root.position.z -= stepCm; break
        case 'ArrowDown': root.position.z += stepCm; break
        case 'PageUp': root.position.y += stepCm; break
        case 'PageDown': root.position.y -= stepCm; break
        case 'BracketLeft': root.rotation.y -= (stepDeg * Math.PI) / 180; break
        case 'BracketRight': root.rotation.y += (stepDeg * Math.PI) / 180; break
        case 'Minus': root.scale.multiplyScalar(1 / stepScale); break
        case 'Equal': root.scale.multiplyScalar(stepScale); break
        default: return
      }
      e.preventDefault()
      this.save()
      this.refresh()
    })
  }

  private currentTransform(): WorldTransform {
    const root = this.getWorld().root
    return {
      position: [
        Math.round(root.position.x * 10) / 10,
        Math.round(root.position.y * 10) / 10,
        Math.round(root.position.z * 10) / 10,
      ],
      rotationYDeg: Math.round((root.rotation.y * 180) / Math.PI * 10) / 10,
      scale: Math.round(root.scale.x * 1000) / 1000,
    }
  }

  private save(): void {
    const t = this.currentTransform()
    localStorage.setItem(KEY_PREFIX + this.getWorldName(), JSON.stringify(t))
    console.log(`meta.json «${this.getWorldName()}» → "transform": ${JSON.stringify(t)}`)
  }

  private refresh(): void {
    const t = this.currentTransform()
    this.hint.textContent =
      `ВЫРАВНИВАНИЕ «${this.getWorldName()}» (A — выйти)\n` +
      `стрелки X/Z, PgUp/PgDn Y, [ ] поворот, - = масштаб, Shift — крупный шаг\n` +
      `transform: ${JSON.stringify(t)}`
  }
}
```

- [ ] **Step 2: Применение сохранённого выравнивания в worldScene.ts**

В `buildWorld`, после создания `root` и применения `meta.transform`, добавить:

```ts
import { loadAlignOverride } from '../debug/align'
```
```ts
  // Незакоммиченное выравнивание из localStorage перекрывает meta.json
  const override = loadAlignOverride(baseUrl.split('/').filter(Boolean).pop()!)
  if (override) {
    root.position.set(...override.position)
    root.rotation.y = (override.rotationYDeg * Math.PI) / 180
    root.scale.setScalar(override.scale)
  }
```

- [ ] **Step 3: Подключение в main.ts**

После создания `switcher`:

```ts
import { AlignController } from './debug/align'
```
```ts
  new AlignController(
    () => worlds[switcher.index],
    () => SCENE_CONFIG.worlds[switcher.index],
  )
```

- [ ] **Step 4: Проверка**

Run: `npm test && npm run build`
Expected: всё зелёное, build чистый.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: выравнивание мира клавишами (A + стрелки), сохранение в localStorage"
```

---

### Task 8: gen-world.mjs — картинка → Marble World API → папка мира

**Files:**
- Create: `scripts/gen-world.mjs`
- Modify: `docs/CONTENT_GUIDE.md` (раздел про миры)

API (по docs.worldlabs.ai/api, июнь 2026): база `https://api.worldlabs.ai`, заголовок `WLT-Api-Key`. Загрузка файла: `POST /marble/v1/media-assets:prepare_upload` → signed URL → PUT байты. Генерация: `POST /marble/v1/worlds:generate` → operation. Поллинг: `GET /marble/v1/operations/{id}` до `done: true` (~5 мин). Мир: `assets.splats.spz_urls` (100k/500k/full_res). Если поле в ответе называется иначе — скрипт печатает весь ответ, имена правятся по докам.

- [ ] **Step 1: scripts/gen-world.mjs**

```js
// Генерация 3D-мира из одной картинки через Marble World API (World Labs).
//   node scripts/gen-world.mjs --image <фото> --name <имя> [--prompt "..."]
// Ключ: WORLDLABS_API_KEY в окружении или .env
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d }
const image = flag('image')
const name = flag('name')
const prompt = flag('prompt', 'photorealistic interior, keep the scene exactly as in the image')
if (!image || !name || !existsSync(image)) {
  console.error('usage: node scripts/gen-world.mjs --image <фото> --name <имя> [--prompt "..."]')
  process.exit(1)
}

let apiKey = process.env.WORLDLABS_API_KEY
if (!apiKey && existsSync('.env')) {
  const m = readFileSync('.env', 'utf8').match(/^WORLDLABS_API_KEY=(.+)$/m)
  if (m) apiKey = m[1].trim().replace(/^["']|["']$/g, '')
}
if (!apiKey) { console.error('Нет ключа: WORLDLABS_API_KEY в окружении или .env'); process.exit(1) }

const BASE = 'https://api.worldlabs.ai'
const HEADERS = { 'WLT-Api-Key': apiKey, 'Content-Type': 'application/json' }

async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}\n${JSON.stringify(json, null, 2).slice(0, 2000)}`)
  return json
}

// 1. Загрузка картинки
console.log('1/4 загружаю картинку...')
const mime = image.endsWith('.png') ? 'image/png' : 'image/jpeg'
const prep = await api('POST', '/marble/v1/media-assets:prepare_upload', { mime_type: mime })
console.log('   prepare_upload →', JSON.stringify(prep).slice(0, 300))
const uploadUri = prep.upload_uri ?? prep.uploadUri ?? prep.signed_url
const assetId = prep.media_asset_id ?? prep.mediaAssetId ?? prep.id
if (!uploadUri || !assetId) throw new Error('Не нашёл upload_uri/media_asset_id в ответе выше — сверь имена полей с docs.worldlabs.ai/api')
const put = await fetch(uploadUri, { method: 'PUT', headers: { 'Content-Type': mime }, body: readFileSync(image) })
if (!put.ok) throw new Error(`PUT upload: HTTP ${put.status}`)

// 2. Генерация мира
console.log('2/4 запускаю генерацию мира (~5 минут)...')
const op = await api('POST', '/marble/v1/worlds:generate', {
  display_name: name,
  world_prompt: {
    type: 'image',
    image_prompt: { source: 'media_asset', media_asset_id: assetId },
    text_prompt: prompt,
  },
})
const opId = op.operation_id ?? op.name ?? op.id
console.log('   operation:', opId)

// 3. Поллинг
let world = null
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 10_000))
  const st = await api('GET', `/marble/v1/operations/${encodeURIComponent(opId)}`)
  process.stdout.write(`   ...${i * 10}с done=${st.done}\r`)
  if (st.error) throw new Error('Генерация упала: ' + JSON.stringify(st.error))
  if (st.done) { world = st.response; break }
}
if (!world) throw new Error('Таймаут 20 минут — проверь операцию ' + opId)

// 4. Скачивание сплата
console.log('\n3/4 скачиваю сплат...')
const splats = world.assets?.splats?.spz_urls ?? {}
const spzUrl = splats.full_res ?? splats['500k'] ?? splats['100k'] ?? Object.values(splats)[0]
if (!spzUrl) throw new Error('Нет spz_urls в ответе:\n' + JSON.stringify(world, null, 2).slice(0, 2000))
const dir = `public/assets/worlds/${name}`
mkdirSync(dir, { recursive: true })
const spz = await fetch(spzUrl)
if (!spz.ok) throw new Error(`скачивание spz: HTTP ${spz.status}`)
writeFileSync(`${dir}/world.spz`, Buffer.from(await spz.arrayBuffer()))

console.log('4/4 пишу meta.json...')
writeFileSync(`${dir}/meta.json`, JSON.stringify({
  title: name,
  format: 'splat',
  file: 'world.spz',
  transform: { position: [0, 0, 0], rotationYDeg: 0, scale: 100 },
  dollyMaxCm: 150,
  source: `marble:${world.id ?? opId}`,
}, null, 2))

console.log(`готово: ${dir}/ — добавь '${name}' в src/scenes/config.ts и выровняй клавишей A`)
```

- [ ] **Step 2: Дополнить docs/CONTENT_GUIDE.md**

Добавить в конец файла раздел:

```markdown
## 5. Миры-сплаты (максимальное качество, Stellar Window 2.0)

Полноценный 3D-мир из одной картинки (Marble World API, ключ WORLDLABS_API_KEY в .env,
платный план для экспорта):

    node scripts/gen-world.mjs --image фото.png --name living

~5 минут генерации → папка public/assets/worlds/living/ готова. Дальше:
1. Добавь 'living' в worlds в src/scenes/config.ts
2. Запусти приложение, переключись на мир, нажми `A` — выровняй стрелками
   (масштаб: - =, поворот: [ ]), transform скопируй из консоли в meta.json
3. Если позже появится съёмка реальной квартиры — Postshot/Luma → world.spz
   в ту же папку, код не меняется
```

- [ ] **Step 3: Проверка без ключа**

Run: `node scripts/gen-world.mjs --image images/bedroom_eye.png --name test-x`
Expected: `Нет ключа: WORLDLABS_API_KEY...` и exit 1 (скрипт честно падает без ключа). С ключом скрипт прогонит человек.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: gen-world.mjs — картинка → Marble World API → папка мира"
```

---

### Task 9: README + финальная уборка

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Обновить README**

Заменить разделы «Клавиши» и «Чек-лист приёмки» на:

```markdown
## Клавиши

| Клавиша | Действие |
|---|---|
| `1`–`9` | выбор мира напрямую |
| `W` / `M` | следующий / предыдущий мир |
| `A` | режим выравнивания мира (стрелки, [ ], - =, Shift — крупный шаг) |
| `D` | debug-панель (FPS, задержка, позиция головы) |
| `C` | калибровка (размеры экрана, смещение камеры, FOV вебки) |

Клавиши привязаны к физическим позициям (e.code) — работают в любой раскладке.

## Чек-лист приёмки (Stellar Window 2.0)

- [ ] Мир от первого лица, параллакс от движения головы
- [ ] Подход к экрану плавно «вводит» в мир (dolly), отход — выводит, без дрожи на границе
- [ ] Переключение миров `1..9`/`W`/`M` с шторкой < 0.5 с
- [ ] Демо-сплат рендерится (Spark), photo25d-миры рендерятся (спальня, балкон)
- [ ] Мир из другой технологии подключается папкой + meta.json без правки кода
- [ ] Debug: render ≥ 50 fps; потеря лица/два лица/запрет камеры — как в v1
- [ ] `gen-world.mjs` без ключа падает с понятным сообщением; с ключом собирает папку мира
```

И раздел «Замена контента» дополнить первой строкой: «Миры лежат в `public/assets/worlds/<имя>/` (сплат или 2.5D-фото) — формат описан в `docs/CONTENT_GUIDE.md` §5.»

- [ ] **Step 2: Финальная проверка**

Run: `npm test && npm run build`
Expected: все тесты PASS, build чистый.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: README под Stellar Window 2.0 (миры, выравнивание, чек-лист)"
```


