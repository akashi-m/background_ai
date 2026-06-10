# Прототип «Зеркало Stellar» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Веб-прототип «виртуального зеркала»: посетитель видит себя внутри 3D-интерьера, фон параллаксится от положения головы (off-axis проекция), режим «Окно» показывает панораму города. Спека: `docs/superpowers/specs/2026-06-10-stellar-mirror-prototype-design.md`.

**Architecture:** Один веб-апп (Vite + TypeScript), без бэкенда. Конвейер: вебкамера → MediaPipe (маска фигуры + позиция головы) → One-Euro сглаживание → Three.js рендер с off-axis проекцией → композит фигуры поверх фона. Мировые единицы — сантиметры, экран = плоскость z=0, комната в z<0, зритель в z>0.

**Tech Stack:** TypeScript, Vite, Three.js, @mediapipe/tasks-vision (FaceLandmarker + ImageSegmenter), Vitest.

## Структура файлов

```
index.html                      каркас страницы, оверлей ошибок
src/main.ts                     сборка конвейера, рендер-цикл, клавиши
src/tracking/camera.ts          getUserMedia → <video>
src/tracking/oneEuro.ts         One-Euro фильтр (чистый, тесты)
src/tracking/headPose.ts        пиксели лица → позиция глаз в см (чистый, тесты)
src/tracking/headTracker.ts     MediaPipe FaceLandmarker, выбор ближайшего лица, затухание при потере
src/tracking/segmenter.ts       MediaPipe ImageSegmenter → маска-текстура
src/render/offAxis.ts           off-axis фрустум (чистый, тесты) + применение к камере
src/render/compositor.ts        фигура поверх сцены (шейдер), зеркальный флип, чёрный фейд
src/scenes/config.ts            пути к ассетам, параметры комнаты
src/scenes/mirrorScene.ts       процедурная комната (+опц. GLTF)
src/scenes/windowScene.ts       панорама города + оконная рама
src/app/calibration.ts          размеры экрана/камера, localStorage (чистый, тесты)
src/app/modes.ts                стейт-машина ЗЕРКАЛО/ОКНО с фейдом (чистая, тесты)
src/debug/panel.ts              FPS/задержка/позиция головы, панель калибровки
public/assets/city.jpg          панорама города (скачивается, Poly Haven CC0)
```

---

### Task 1: Каркас проекта

**Files:**
- Create: `package.json`, `tsconfig.json`, `index.html`, `src/main.ts`, `src/smoke.test.ts`

- [ ] **Step 1: package.json**

```json
{
  "name": "stellar-mirror",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "three": "^0.165.0",
    "@mediapipe/tasks-vision": "^0.10.14"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vite": "^5.2.0",
    "vitest": "^1.6.0",
    "@types/three": "^0.165.0"
  }
}
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: index.html**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Stellar Mirror</title>
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
    canvas { display: block; }
    #overlay {
      position: fixed; inset: 0; display: none;
      align-items: center; justify-content: center; text-align: center;
      color: #fff; font: 16px/1.6 system-ui; background: #000; padding: 40px;
    }
  </style>
</head>
<body>
  <div id="overlay"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

- [ ] **Step 4: src/main.ts (заглушка)**

```ts
console.log('Stellar Mirror: каркас работает')
```

- [ ] **Step 5: src/smoke.test.ts**

```ts
import { describe, it, expect } from 'vitest'

describe('каркас', () => {
  it('vitest работает', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 6: Установка и проверка**

Run: `npm install && npm test`
Expected: 1 passed

Run: `npm run dev` (запустить, открыть http://localhost:5173, в консоли браузера видна заглушка, остановить Ctrl+C)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: каркас проекта (Vite + TS + Vitest, three, mediapipe)"
```

---

### Task 2: One-Euro фильтр

**Files:**
- Create: `src/tracking/oneEuro.ts`
- Test: `src/tracking/oneEuro.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { describe, it, expect } from 'vitest'
import { OneEuroFilter } from './oneEuro'

const DT = 1 / 30

describe('OneEuroFilter', () => {
  it('первое значение проходит без изменений', () => {
    const f = new OneEuroFilter()
    expect(f.filter(5, DT)).toBe(5)
  })

  it('постоянный сигнал не меняется', () => {
    const f = new OneEuroFilter()
    for (let i = 0; i < 10; i++) f.filter(3, DT)
    expect(f.filter(3, DT)).toBeCloseTo(3, 6)
  })

  it('гасит дрожь: разброс фильтрованного шума меньше сырого', () => {
    const f = new OneEuroFilter()
    const noisy = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5))
    const out = noisy.map(v => f.filter(v, DT))
    const tail = out.slice(50)
    const spread = Math.max(...tail) - Math.min(...tail)
    expect(spread).toBeLessThan(0.2)
  })

  it('быстрое движение догоняется быстро (beta работает)', () => {
    const f = new OneEuroFilter()
    f.filter(0, DT)
    let last = 0
    for (let i = 1; i <= 30; i++) last = f.filter(i * 2, DT) // скачок 2 см/кадр
    expect(last).toBeGreaterThan(50) // не отстаёт больше чем на ~17%
  })

  it('reset забывает историю', () => {
    const f = new OneEuroFilter()
    f.filter(100, DT)
    f.reset()
    expect(f.filter(7, DT)).toBe(7)
  })
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm test`
Expected: FAIL — `Cannot find module './oneEuro'`

- [ ] **Step 3: Реализация**

```ts
// One-Euro фильтр (Casiez et al. 2012): мало лага при движении, мало дрожи в покое.
export interface OneEuroConfig {
  minCutoff: number // Гц; ниже — плавнее в покое
  beta: number      // чувствительность к скорости; выше — меньше лаг при движении
  dCutoff: number   // Гц; сглаживание производной
}

export class OneEuroFilter {
  private xPrev: number | null = null
  private dxPrev = 0

  constructor(private cfg: OneEuroConfig = { minCutoff: 1.0, beta: 0.05, dCutoff: 1.0 }) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  filter(x: number, dt: number): number {
    if (this.xPrev === null) {
      this.xPrev = x
      return x
    }
    const dx = (x - this.xPrev) / dt
    const aD = this.alpha(this.cfg.dCutoff, dt)
    this.dxPrev = aD * dx + (1 - aD) * this.dxPrev
    const cutoff = this.cfg.minCutoff + this.cfg.beta * Math.abs(this.dxPrev)
    const a = this.alpha(cutoff, dt)
    this.xPrev = a * x + (1 - a) * this.xPrev
    return this.xPrev
  }

  reset(): void {
    this.xPrev = null
    this.dxPrev = 0
  }
}

// Тройка фильтров для точки (x, y, z)
export class OneEuroPoint {
  private fx = new OneEuroFilter()
  private fy = new OneEuroFilter()
  private fz = new OneEuroFilter({ minCutoff: 0.5, beta: 0.02, dCutoff: 1.0 }) // z шумнее — глушим сильнее

  filter(p: { x: number; y: number; z: number }, dt: number) {
    return { x: this.fx.filter(p.x, dt), y: this.fy.filter(p.y, dt), z: this.fz.filter(p.z, dt) }
  }

  reset(): void {
    this.fx.reset(); this.fy.reset(); this.fz.reset()
  }
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `npm test`
Expected: PASS (все тесты oneEuro + smoke)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: One-Euro фильтр для сглаживания трекинга"
```

---

### Task 3: Off-axis проекция

**Files:**
- Create: `src/render/offAxis.ts`
- Test: `src/render/offAxis.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { describe, it, expect } from 'vitest'
import { offAxisFrustum } from './offAxis'

// Экран 30×19 см (MacBook), near = 1 см
const W = 30, H = 19, NEAR = 1

describe('offAxisFrustum', () => {
  it('глаз по центру → симметричный фрустум', () => {
    const f = offAxisFrustum({ x: 0, y: 0, z: 60 }, W, H, NEAR)
    expect(f.right).toBeCloseTo(-f.left, 6)
    expect(f.top).toBeCloseTo(-f.bottom, 6)
    expect(f.right).toBeCloseTo((W / 2) * (NEAR / 60), 6)
  })

  it('глаз вправо → фрустум скашивается влево', () => {
    const f = offAxisFrustum({ x: 10, y: 0, z: 60 }, W, H, NEAR)
    expect(f.left).toBeCloseTo((-W / 2 - 10) * (NEAR / 60), 6)
    expect(f.right).toBeCloseTo((W / 2 - 10) * (NEAR / 60), 6)
    expect(Math.abs(f.left)).toBeGreaterThan(Math.abs(f.right))
  })

  it('глаз вдвое дальше → фрустум вдвое уже', () => {
    const near60 = offAxisFrustum({ x: 0, y: 0, z: 60 }, W, H, NEAR)
    const near120 = offAxisFrustum({ x: 0, y: 0, z: 120 }, W, H, NEAR)
    expect(near120.right).toBeCloseTo(near60.right / 2, 6)
  })

  it('z <= 0 — ошибка (зритель за экраном невозможен)', () => {
    expect(() => offAxisFrustum({ x: 0, y: 0, z: 0 }, W, H, NEAR)).toThrow()
  })
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm test`
Expected: FAIL — `Cannot find module './offAxis'`

- [ ] **Step 3: Реализация**

```ts
import type { PerspectiveCamera } from 'three'

// Позиция глаз зрителя в см относительно ЦЕНТРА экрана.
// Оси: x — вправо (от зрителя), y — вверх, z — от экрана к зрителю (z > 0).
export interface EyeCm { x: number; y: number; z: number }

export interface FrustumCm { left: number; right: number; top: number; bottom: number }

// Generalized perspective projection (Kooima): экран — окно в мир,
// фрустум строится от глаза к физическим краям экрана.
export function offAxisFrustum(eye: EyeCm, screenWcm: number, screenHcm: number, nearCm: number): FrustumCm {
  if (eye.z <= 0) throw new Error('eye.z должен быть > 0 (зритель перед экраном)')
  const s = nearCm / eye.z
  return {
    left: (-screenWcm / 2 - eye.x) * s,
    right: (screenWcm / 2 - eye.x) * s,
    bottom: (-screenHcm / 2 - eye.y) * s,
    top: (screenHcm / 2 - eye.y) * s,
  }
}

const NEAR_CM = 1
const FAR_CM = 100000

// Ставит камеру в позицию глаз и подменяет проекционную матрицу.
// ВАЖНО: не вызывать camera.updateProjectionMatrix() — она затрёт нашу матрицу.
export function applyOffAxis(camera: PerspectiveCamera, eye: EyeCm, screenWcm: number, screenHcm: number): void {
  const f = offAxisFrustum(eye, screenWcm, screenHcm, NEAR_CM)
  camera.position.set(eye.x, eye.y, eye.z)
  camera.rotation.set(0, 0, 0) // всегда смотрим перпендикулярно экрану
  camera.projectionMatrix.makePerspective(f.left, f.right, f.top, f.bottom, NEAR_CM, FAR_CM)
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  camera.updateMatrixWorld()
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: off-axis проекция (экран = окно в мир)"
```

---

### Task 4: Калибровка

**Files:**
- Create: `src/app/calibration.ts`
- Test: `src/app/calibration.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { describe, it, expect } from 'vitest'
import { loadCalibration, saveCalibration, DEFAULT_CALIBRATION } from './calibration'

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v },
    data,
  }
}

describe('calibration', () => {
  it('пустое хранилище → дефолты', () => {
    expect(loadCalibration(fakeStorage())).toEqual(DEFAULT_CALIBRATION)
  })

  it('сохранение → загрузка возвращает то же', () => {
    const s = fakeStorage()
    const cal = { ...DEFAULT_CALIBRATION, screenWcm: 120 }
    saveCalibration(cal, s)
    expect(loadCalibration(s)).toEqual(cal)
  })

  it('битый JSON → дефолты, без исключений', () => {
    const s = fakeStorage({ 'stellar-mirror.calibration': '{oops' })
    expect(loadCalibration(s)).toEqual(DEFAULT_CALIBRATION)
  })

  it('частичные данные дополняются дефолтами', () => {
    const s = fakeStorage({ 'stellar-mirror.calibration': '{"screenWcm": 99}' })
    const cal = loadCalibration(s)
    expect(cal.screenWcm).toBe(99)
    expect(cal.screenHcm).toBe(DEFAULT_CALIBRATION.screenHcm)
  })
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm test`
Expected: FAIL — `Cannot find module './calibration'`

- [ ] **Step 3: Реализация**

```ts
export interface Calibration {
  screenWcm: number      // ширина видимой области экрана, см
  screenHcm: number      // высота, см
  camOffsetXcm: number   // смещение камеры от центра экрана, см (вправо +)
  camOffsetYcm: number   // (вверх +; вебка над экраном ≈ +screenHcm/2 + 1)
  webcamHfovDeg: number  // горизонтальный угол обзора вебки, градусы
}

// Дефолты под MacBook Pro 14": экран ~30×19.5 см, камера в верхней кромке.
export const DEFAULT_CALIBRATION: Calibration = {
  screenWcm: 30.4,
  screenHcm: 19.5,
  camOffsetXcm: 0,
  camOffsetYcm: 10.3,
  webcamHfovDeg: 63,
}

const KEY = 'stellar-mirror.calibration'

type ReadStore = Pick<Storage, 'getItem'>
type WriteStore = Pick<Storage, 'setItem'>

export function loadCalibration(storage: ReadStore = localStorage): Calibration {
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return { ...DEFAULT_CALIBRATION }
    return { ...DEFAULT_CALIBRATION, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_CALIBRATION }
  }
}

export function saveCalibration(cal: Calibration, storage: WriteStore = localStorage): void {
  storage.setItem(KEY, JSON.stringify(cal))
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: калибровка экрана и камеры (localStorage)"
```

---

### Task 5: Позиция головы из пикселей лица

**Files:**
- Create: `src/tracking/headPose.ts`
- Test: `src/tracking/headPose.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
import { describe, it, expect } from 'vitest'
import { eyePositionCm, focalLengthPx } from './headPose'
import { DEFAULT_CALIBRATION } from '../app/calibration'

// Камера 1280×720, hfov 63° → focal ≈ 1043 px
const CAL = { ...DEFAULT_CALIBRATION, camOffsetXcm: 0, camOffsetYcm: 0, webcamHfovDeg: 63 }

describe('eyePositionCm', () => {
  it('фокус из FOV: 1280 px, 63° → ~1044 px', () => {
    expect(focalLengthPx(1280, 63)).toBeCloseTo(1044.4, 0)
  })

  it('лицо в центре кадра → x=0, y=0, z по размеру IPD', () => {
    const f = focalLengthPx(1280, 63)
    // IPD 6.3 см на расстоянии 60 см → ipdPx = 6.3 * f / 60
    const ipdPx = (6.3 * f) / 60
    const eye = eyePositionCm({ cx: 640, cy: 360, ipdPx, videoW: 1280, videoH: 720 }, CAL)
    expect(eye.x).toBeCloseTo(0, 4)
    expect(eye.y).toBeCloseTo(0, 4)
    expect(eye.z).toBeCloseTo(60, 1)
  })

  it('зритель сдвинулся вправо (в кадре — влево) → x растёт', () => {
    const f = focalLengthPx(1280, 63)
    const ipdPx = (6.3 * f) / 60
    const eye = eyePositionCm({ cx: 500, cy: 360, ipdPx, videoW: 1280, videoH: 720 }, CAL)
    expect(eye.x).toBeGreaterThan(0)
  })

  it('зритель выше (в кадре — выше, cy меньше) → y растёт', () => {
    const f = focalLengthPx(1280, 63)
    const ipdPx = (6.3 * f) / 60
    const eye = eyePositionCm({ cx: 640, cy: 200, ipdPx, videoW: 1280, videoH: 720 }, CAL)
    expect(eye.y).toBeGreaterThan(0)
  })

  it('смещение камеры прибавляется', () => {
    const f = focalLengthPx(1280, 63)
    const ipdPx = (6.3 * f) / 60
    const cal = { ...CAL, camOffsetYcm: 10 }
    const eye = eyePositionCm({ cx: 640, cy: 360, ipdPx, videoW: 1280, videoH: 720 }, cal)
    expect(eye.y).toBeCloseTo(10, 4)
  })
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm test`
Expected: FAIL — `Cannot find module './headPose'`

- [ ] **Step 3: Реализация**

```ts
import type { EyeCm } from '../render/offAxis'
import type { Calibration } from '../app/calibration'

// Среднее межзрачковое расстояние взрослого человека, см. Точность ±10% достаточна.
export const IPD_CM = 6.3

// Точка между глазами в кадре видео (пиксели) + размер IPD в пикселях.
export interface FaceInVideo {
  cx: number
  cy: number
  ipdPx: number
  videoW: number
  videoH: number
}

export function focalLengthPx(videoW: number, hfovDeg: number): number {
  return videoW / 2 / Math.tan(((hfovDeg * Math.PI) / 180) / 2)
}

// Пинхол-модель: z из размера IPD, x/y из смещения от центра кадра.
// Знаки: видео НЕ зеркальное — зритель двигается вправо → в кадре влево (cx падает),
// поэтому минус. Ось y видео направлена вниз — тоже минус.
export function eyePositionCm(face: FaceInVideo, cal: Calibration): EyeCm {
  const f = focalLengthPx(face.videoW, cal.webcamHfovDeg)
  const z = (IPD_CM * f) / face.ipdPx
  const x = -(((face.cx - face.videoW / 2) * z) / f) + cal.camOffsetXcm
  const y = -(((face.cy - face.videoH / 2) * z) / f) + cal.camOffsetYcm
  return { x, y, z }
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: оценка позиции головы в см из координат лица"
```

---

### Task 6: Камера + трекер головы (MediaPipe)

**Files:**
- Create: `src/tracking/camera.ts`, `src/tracking/headTracker.ts`
- Modify: `src/main.ts`

Это интеграция с железом — юнит-тестов нет, проверка ручная через debug-вывод.

- [ ] **Step 1: src/tracking/camera.ts**

```ts
export async function openCamera(): Promise<HTMLVideoElement> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  })
  const video = document.createElement('video')
  video.srcObject = stream
  video.muted = true
  video.playsInline = true
  await video.play()
  return video
}

// Камера запрещена/не найдена → инструкция; остальное (например, не загрузился
// ассет) → общее сообщение с текстом ошибки (там будет имя файла).
export function showFatalError(err: unknown): void {
  const overlay = document.getElementById('overlay')!
  overlay.style.display = 'flex'
  const isCamera = err instanceof DOMException &&
    (err.name === 'NotAllowedError' || err.name === 'NotFoundError')
  const title = isCamera ? 'Нет доступа к камере' : 'Не удалось запуститься'
  const hint = isCamera
    ? 'Разрешите доступ к камере в настройках браузера и перезагрузите страницу.'
    : 'Подробности ниже — проверьте консоль и наличие файлов в public/assets/.'
  overlay.innerHTML =
    `<div><h2>${title}</h2><p>${hint}</p>` +
    `<p style="opacity:.6">${err instanceof Error ? err.message : String(err)}</p></div>`
}
```

- [ ] **Step 2: src/tracking/headTracker.ts**

```ts
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { OneEuroPoint } from './oneEuro'
import { eyePositionCm, type FaceInVideo } from './headPose'
import type { EyeCm } from '../render/offAxis'
import type { Calibration } from '../app/calibration'

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// Индексы центров зрачков в 478-точечной модели FaceLandmarker
const LEFT_IRIS = 468
const RIGHT_IRIS = 473

const NEUTRAL: EyeCm = { x: 0, y: 0, z: 60 } // куда затухаем при потере лица
const LOST_AFTER_MS = 500

export class HeadTracker {
  private landmarker!: FaceLandmarker
  private filter = new OneEuroPoint()
  private current: EyeCm = { ...NEUTRAL }
  private target: EyeCm = { ...NEUTRAL }
  private lastSeenMs = 0
  private lastVideoTimeMs = -1
  faceVisible = false

  constructor(private video: HTMLVideoElement, public calibration: Calibration) {}

  async init(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL)
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 3, // детектим до 3 лиц, берём ближайшее
    })
  }

  // Зовётся каждый кадр рендера. Возвращает сглаженную позицию глаз.
  update(nowMs: number, dt: number): EyeCm {
    if (this.video.currentTime * 1000 !== this.lastVideoTimeMs) {
      this.lastVideoTimeMs = this.video.currentTime * 1000
      const res = this.landmarker.detectForVideo(this.video, nowMs)
      const face = this.pickNearestFace(res.faceLandmarks)
      if (face) {
        this.target = eyePositionCm(face, this.calibration)
        this.lastSeenMs = nowMs
      }
    }

    this.faceVisible = nowMs - this.lastSeenMs < LOST_AFTER_MS
    const goal = this.faceVisible ? this.target : NEUTRAL
    if (!this.faceVisible) this.filter.reset() // после паузы — подхват без рывка из старой истории

    // Экспоненциальное приближение к цели + One-Euro поверх: плавно и без дрожи
    const k = 1 - Math.exp(-dt * 10)
    this.current = {
      x: this.current.x + (goal.x - this.current.x) * k,
      y: this.current.y + (goal.y - this.current.y) * k,
      z: this.current.z + (goal.z - this.current.z) * k,
    }
    return this.faceVisible ? this.filter.filter(this.current, dt) : this.current
  }

  // Ближайшее лицо = самое большое межзрачковое расстояние в пикселях
  private pickNearestFace(faces: { x: number; y: number }[][]): FaceInVideo | null {
    let best: FaceInVideo | null = null
    for (const lm of faces) {
      const li = lm[LEFT_IRIS], ri = lm[RIGHT_IRIS]
      if (!li || !ri) continue
      const w = this.video.videoWidth, h = this.video.videoHeight
      const dx = (li.x - ri.x) * w, dy = (li.y - ri.y) * h
      const ipdPx = Math.hypot(dx, dy)
      if (!best || ipdPx > best.ipdPx) {
        best = { cx: ((li.x + ri.x) / 2) * w, cy: ((li.y + ri.y) / 2) * h, ipdPx, videoW: w, videoH: h }
      }
    }
    return best
  }
}
```

- [ ] **Step 3: Временная проверка в src/main.ts**

```ts
import { openCamera, showFatalError } from './tracking/camera'
import { HeadTracker } from './tracking/headTracker'
import { loadCalibration } from './app/calibration'

async function start() {
  const video = await openCamera()
  const tracker = new HeadTracker(video, loadCalibration())
  await tracker.init()
  const el = document.createElement('pre')
  el.style.cssText = 'position:fixed;top:8px;left:8px;color:#0f0;font:12px monospace;z-index:10'
  document.body.appendChild(el)
  let last = performance.now()
  const loop = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    const eye = tracker.update(now, dt)
    el.textContent =
      `eye: x=${eye.x.toFixed(1)} y=${eye.y.toFixed(1)} z=${eye.z.toFixed(1)} см\n` +
      `лицо: ${tracker.faceVisible ? 'да' : 'НЕТ (затухание к центру)'}`
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}

start().catch(showFatalError)
```

- [ ] **Step 4: Ручная проверка**

Run: `npm run dev`, открыть http://localhost:5173, разрешить камеру.
Expected:
- z ≈ реальное расстояние до экрана (±15%): сядь на ~60 см — увидишь ~50–70
- двигаешься вправо → x растёт; вверх → y растёт (если знак не тот — проверь, что видео не зеркалится)
- закрыл камеру рукой → через полсекунды «лицо: НЕТ», числа плавно ползут к 0,0,60
- два лица в кадре → трекается ближнее

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: трекер головы на MediaPipe (ближайшее лицо, затухание при потере)"
```

---

### Task 7: Процедурная комната + параллакс — первый «тест магии»

**Files:**
- Create: `src/scenes/config.ts`, `src/scenes/mirrorScene.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: src/scenes/config.ts**

```ts
// Все ассеты и габариты — здесь. Замена контента = правка этого файла.
export const SCENE_CONFIG = {
  // Комната (см). Экран = проём в стене z=0, комната уходит в z<0.
  room: { width: 400, height: 280, depth: 500 },
  // Панорама города (равнопромежуточная). Скачать: см. Task 9.
  cityPanoramaUrl: '/assets/city.jpg',
  // Если появится GLTF-интерьер от заказчика — путь сюда, процедурная комната отключится.
  interiorGltfUrl: null as string | null,
}
```

- [ ] **Step 2: src/scenes/mirrorScene.ts**

```ts
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { SCENE_CONFIG } from './config'

// Процедурная «жилая комната»: пол, стены, окно с видом, мебель-болванки.
// Качество — уровня прототипа: проверяем параллакс, не архвиз.
export async function buildMirrorScene(): Promise<THREE.Scene> {
  const scene = new THREE.Scene()
  const { width: W, height: H, depth: D } = SCENE_CONFIG.room

  if (SCENE_CONFIG.interiorGltfUrl) {
    const gltf = await new GLTFLoader().loadAsync(SCENE_CONFIG.interiorGltfUrl)
    scene.add(gltf.scene)
  } else {
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xe8e0d4 })
    const floorMat = new THREE.MeshLambertMaterial({ color: 0x9c7b5a })

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat)
    floor.rotation.x = -Math.PI / 2
    floor.position.set(0, -H / 2, -D / 2)
    scene.add(floor)

    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), wallMat.clone())
    ceiling.rotation.x = Math.PI / 2
    ceiling.position.set(0, H / 2, -D / 2)
    scene.add(ceiling)

    const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat.clone())
    back.position.set(0, 0, -D)
    scene.add(back)

    const left = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMat.clone())
    left.rotation.y = Math.PI / 2
    left.position.set(-W / 2, 0, -D / 2)
    scene.add(left)

    const right = left.clone()
    right.rotation.y = -Math.PI / 2
    right.position.set(W / 2, 0, -D / 2)
    scene.add(right)

    // Окно на задней стене: светящаяся «панорама» + рама
    const tex = await new THREE.TextureLoader().loadAsync(SCENE_CONFIG.cityPanoramaUrl)
    tex.colorSpace = THREE.SRGBColorSpace
    const view = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 120),
      new THREE.MeshBasicMaterial({ map: tex })
    )
    view.position.set(60, 20, -D + 1)
    scene.add(view)
    const frameMat = new THREE.MeshLambertMaterial({ color: 0x6b5b45 })
    for (const [w, h, x, y] of [[170, 8, 60, 84], [170, 8, 60, -44], [8, 130, -22, 20], [8, 130, 142, 20]]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 6), frameMat)
      bar.position.set(x, y, -D + 3)
      scene.add(bar)
    }

    // Мебель-болванки: диван, столик, торшер — дают параллаксу зацепки на разной глубине
    const sofaMat = new THREE.MeshLambertMaterial({ color: 0x5d7396 })
    const sofa = new THREE.Mesh(new THREE.BoxGeometry(180, 70, 80), sofaMat)
    sofa.position.set(-80, -H / 2 + 35, -D + 120)
    scene.add(sofa)
    const sofaBack = new THREE.Mesh(new THREE.BoxGeometry(180, 60, 20), sofaMat)
    sofaBack.position.set(-80, -H / 2 + 95, -D + 90)
    scene.add(sofaBack)

    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(40, 40, 6, 32),
      new THREE.MeshLambertMaterial({ color: 0x8a6f4d })
    )
    table.position.set(40, -H / 2 + 45, -D / 2)
    scene.add(table)

    const lampPole = new THREE.Mesh(
      new THREE.CylinderGeometry(2, 2, 150, 8),
      new THREE.MeshLambertMaterial({ color: 0x333333 })
    )
    lampPole.position.set(150, -H / 2 + 75, -120)
    scene.add(lampPole)
    const lampLight = new THREE.PointLight(0xffd9a0, 30000, 0, 2)
    lampLight.position.set(150, 20, -120)
    scene.add(lampLight)
  }

  scene.add(new THREE.AmbientLight(0xffffff, 0.5))
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.2)
  sun.position.set(100, 200, 100)
  scene.add(sun)
  return scene
}
```

- [ ] **Step 3: src/main.ts — рендер с параллаксом (заменить целиком)**

```ts
import * as THREE from 'three'
import { openCamera, showFatalError } from './tracking/camera'
import { HeadTracker } from './tracking/headTracker'
import { loadCalibration } from './app/calibration'
import { applyOffAxis } from './render/offAxis'
import { buildMirrorScene } from './scenes/mirrorScene'

async function start() {
  const video = await openCamera()
  const calibration = loadCalibration()
  const tracker = new HeadTracker(video, calibration)
  await tracker.init()

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(innerWidth, innerHeight)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  document.body.appendChild(renderer.domElement)
  addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight))

  const scene = await buildMirrorScene()
  const camera = new THREE.PerspectiveCamera()

  let last = performance.now()
  renderer.setAnimationLoop((now) => {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    const eye = tracker.update(now, dt)
    applyOffAxis(camera, eye, calibration.screenWcm, calibration.screenHcm)
    renderer.render(scene, camera)
  })
}

start().catch(showFatalError)
```

- [ ] **Step 4: Временная заглушка панорамы**

Окну нужна текстура. Скачать панораму (или любую городскую фотографию) в `public/assets/city.jpg`:

Run: `mkdir -p public/assets && curl -L -o public/assets/city.jpg "https://dl.polyhaven.org/file/ph-assets/HDRIs/extra/Tonemapped%20JPG/canary_wharf.jpg"`

Проверить: `file public/assets/city.jpg` → JPEG. Если URL не отвечает или это не JPEG — взять любую городскую равнопромежуточную панораму с https://polyhaven.com (категория Urban, кнопка Tonemapped JPG) и положить как `public/assets/city.jpg`.

- [ ] **Step 5: Ручная проверка — ПЕРВЫЙ ТЕСТ МАГИИ**

Run: `npm run dev`
Expected:
- видна комната «за экраном»: пол, стены, окно, мебель
- двигаешь голову влево/вправо/вверх/вниз → ракурс комнаты меняется, как будто смотришь в проём
- подходишь ближе → видно больше комнаты (шире угол)
- движение плавное, без дрожи и желе-лага
- если параллакс «инвертирован» (комната едет в ту же сторону, что и голова) — знаки в headPose уже протестированы, проверь зеркальность видео

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: процедурная комната + off-axis параллакс (первый тест магии)"
```

---

### Task 8: Сегментация + композитор — зеркало целиком

**Files:**
- Create: `src/tracking/segmenter.ts`, `src/render/compositor.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: src/tracking/segmenter.ts**

```ts
import { ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision'
import * as THREE from 'three'

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'

// Маска фигуры: float 0..1, обновляется на частоте камеры, отдаётся как THREE-текстура.
export class PersonSegmenter {
  private segmenter!: ImageSegmenter
  private lastVideoTimeMs = -1
  texture: THREE.DataTexture | null = null
  fps = 0
  private frames = 0
  private fpsWindowStart = 0

  constructor(private video: HTMLVideoElement) {}

  async init(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL)
    this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    })
  }

  update(nowMs: number): void {
    if (this.video.currentTime * 1000 === this.lastVideoTimeMs) return
    this.lastVideoTimeMs = this.video.currentTime * 1000

    this.segmenter.segmentForVideo(this.video, nowMs, (result) => {
      const mask = result.confidenceMasks?.[0]
      if (!mask) return
      const data = mask.getAsFloat32Array()
      if (!this.texture || this.texture.image.width !== mask.width) {
        this.texture?.dispose()
        this.texture = new THREE.DataTexture(
          new Float32Array(data.length), mask.width, mask.height,
          THREE.RedFormat, THREE.FloatType
        )
        this.texture.minFilter = THREE.LinearFilter
        this.texture.magFilter = THREE.LinearFilter
      }
      ;(this.texture.image.data as Float32Array).set(data)
      this.texture.needsUpdate = true
      mask.close()

      this.frames++
      if (nowMs - this.fpsWindowStart > 1000) {
        this.fps = this.frames
        this.frames = 0
        this.fpsWindowStart = nowMs
      }
    })
  }
}
```

- [ ] **Step 2: src/render/compositor.ts**

```ts
import * as THREE from 'three'

// Поверх отрендеренной сцены: вырезанная фигура из видео (зеркально) + чёрный фейд.
// Отдельная ortho-сцена, рендерится вторым проходом с autoClear=false.
export class Compositor {
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private personMat: THREE.ShaderMaterial
  private fadeMat: THREE.MeshBasicMaterial

  constructor(video: HTMLVideoElement) {
    const videoTex = new THREE.VideoTexture(video)
    videoTex.colorSpace = THREE.SRGBColorSpace

    this.personMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      uniforms: {
        uVideo: { value: videoTex },
        uMask: { value: null },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D uVideo;
        uniform sampler2D uMask;
        uniform float uOpacity;
        void main() {
          vec2 uv = vec2(1.0 - vUv.x, vUv.y);          // зеркальный флип
          float m = texture2D(uMask, vec2(uv.x, 1.0 - uv.y)).r; // маска хранится без flipY
          float a = smoothstep(0.35, 0.65, m);          // мягкие края
          vec4 c = texture2D(uVideo, uv);
          gl_FragColor = vec4(c.rgb, a * uOpacity);
        }
      `,
    })
    const person = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.personMat)
    person.renderOrder = 0
    this.scene.add(person)

    this.fadeMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0, depthTest: false,
    })
    const fade = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fadeMat)
    fade.renderOrder = 1
    this.scene.add(fade)
  }

  // personOpacity: 1 в режиме ЗЕРКАЛО, 0 в режиме ОКНО. fade: 0..1 чёрная шторка.
  render(renderer: THREE.WebGLRenderer, mask: THREE.Texture | null, personOpacity: number, fade: number): void {
    this.personMat.uniforms.uMask.value = mask
    this.personMat.uniforms.uOpacity.value = mask ? personOpacity : 0
    this.fadeMat.opacity = fade
    const prevAutoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.render(this.scene, this.camera)
    renderer.autoClear = prevAutoClear
  }
}
```

- [ ] **Step 3: Подключить в src/main.ts**

После создания `tracker` добавить:

```ts
import { PersonSegmenter } from './tracking/segmenter'
import { Compositor } from './render/compositor'
```

```ts
  const segmenter = new PersonSegmenter(video)
  await segmenter.init()
  const compositor = new Compositor(video)
```

В рендер-цикле после `renderer.render(scene, camera)`:

```ts
    segmenter.update(now)
    compositor.render(renderer, segmenter.texture, 1, 0)
```

- [ ] **Step 4: Ручная проверка — зеркало работает**

Run: `npm run dev`
Expected:
- видишь себя «в комнате», движения зеркальны (поднял правую руку → отражение подняло руку напротив, как в зеркале)
- фон за тобой — комната с параллаксом, а НЕ твоя реальная комната
- края фигуры мягкие, без грубой «лесенки»; если фигура и маска разъехались по вертикали — убрать `1.0 - uv.y` в семплировании uMask
- FPS не просел заметно (проверить во вкладке Performance)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: сегментация фигуры + композитор — режим зеркала целиком"
```

---

### Task 9: Стейт-машина режимов + сцена «Окно»

**Files:**
- Create: `src/app/modes.ts`, `src/scenes/windowScene.ts`
- Test: `src/app/modes.test.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Падающий тест стейт-машины**

```ts
import { describe, it, expect } from 'vitest'
import { ModeMachine } from './modes'

describe('ModeMachine', () => {
  it('старт: режим ЗЕРКАЛО, фейда нет', () => {
    const m = new ModeMachine(0.2)
    expect(m.mode).toBe('MIRROR')
    expect(m.fade).toBe(0)
  })

  it('переключение: фейд в чёрное, смена режима, фейд обратно', () => {
    const m = new ModeMachine(0.2)
    m.switchTo('WINDOW')
    m.update(0.1) // середина затемнения
    expect(m.fade).toBeCloseTo(0.5, 5)
    expect(m.mode).toBe('MIRROR') // ещё старый режим
    m.update(0.1) // дошли до чёрного
    expect(m.mode).toBe('WINDOW') // режим сменился под шторкой
    m.update(0.2) // рассвело
    expect(m.fade).toBe(0)
    expect(m.phase).toBe('IDLE')
  })

  it('полный цикл укладывается в 0.5 с (требование спеки)', () => {
    const m = new ModeMachine(0.2)
    m.switchTo('WINDOW')
    let t = 0
    while (m.phase !== 'IDLE' && t < 1) { m.update(1 / 60); t += 1 / 60 }
    expect(t).toBeLessThan(0.5)
  })

  it('повторный switchTo в тот же режим игнорируется', () => {
    const m = new ModeMachine(0.2)
    m.switchTo('MIRROR')
    expect(m.phase).toBe('IDLE')
  })

  it('switchTo во время фейда игнорируется (без дёрганья)', () => {
    const m = new ModeMachine(0.2)
    m.switchTo('WINDOW')
    m.update(0.1)
    m.switchTo('MIRROR')
    m.update(0.1)
    expect(m.mode).toBe('WINDOW')
  })
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm test`
Expected: FAIL — `Cannot find module './modes'`

- [ ] **Step 3: Реализация src/app/modes.ts**

```ts
export type Mode = 'MIRROR' | 'WINDOW'
export type Phase = 'IDLE' | 'FADE_OUT' | 'FADE_IN'

// Переключение через короткую чёрную шторку: FADE_OUT → смена сцены → FADE_IN.
export class ModeMachine {
  mode: Mode = 'MIRROR'
  phase: Phase = 'IDLE'
  fade = 0 // 0 — прозрачно, 1 — чёрный экран
  private target: Mode | null = null

  constructor(private fadeDurationSec = 0.2) {}

  switchTo(mode: Mode): void {
    if (mode === this.mode || this.phase !== 'IDLE') return
    this.target = mode
    this.phase = 'FADE_OUT'
  }

  update(dt: number): void {
    if (this.phase === 'FADE_OUT') {
      this.fade += dt / this.fadeDurationSec
      if (this.fade >= 1) {
        this.fade = 1
        this.mode = this.target!
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
Expected: PASS

- [ ] **Step 5: src/scenes/windowScene.ts**

```ts
import * as THREE from 'three'
import { SCENE_CONFIG } from './config'

// Экран = окно квартиры: панорама города на сфере + рама близко к плоскости экрана.
// Рама — главный источник параллакса (панорама далеко, сдвигается слабо).
export async function buildWindowScene(): Promise<THREE.Scene> {
  const scene = new THREE.Scene()

  const tex = await new THREE.TextureLoader().loadAsync(SCENE_CONFIG.cityPanoramaUrl)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.mapping = THREE.EquirectangularReflectionMapping
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(5000, 48, 32),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide })
  )
  scene.add(sky)

  // Рама окна сразу за плоскостью экрана (z = -4 см)
  const frameMat = new THREE.MeshLambertMaterial({ color: 0xf2efe9 })
  const bars: [number, number, number, number][] = [
    [400, 12, 0, 136],   // верх
    [400, 12, 0, -136],  // низ
    [12, 280, -194, 0],  // лево
    [12, 280, 194, 0],   // право
    [8, 280, 0, 0],      // средник вертикальный
    [400, 8, 0, 0],      // средник горизонтальный
  ]
  for (const [w, h, x, y] of bars) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 8), frameMat)
    bar.position.set(x, y, -4)
    scene.add(bar)
  }
  // Подоконник
  const sill = new THREE.Mesh(new THREE.BoxGeometry(420, 6, 30), frameMat)
  sill.position.set(0, -145, -10)
  scene.add(sill)

  scene.add(new THREE.AmbientLight(0xffffff, 1.0))
  return scene
}
```

- [ ] **Step 6: Подключить режимы в src/main.ts**

```ts
import { ModeMachine } from './app/modes'
import { buildWindowScene } from './scenes/windowScene'
```

После создания сцены зеркала:

```ts
  const mirrorScene = await buildMirrorScene()
  const windowScene = await buildWindowScene()
  const modes = new ModeMachine()

  addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'm' || e.key.toLowerCase() === 'ь') modes.switchTo('MIRROR')
    if (e.key.toLowerCase() === 'w' || e.key.toLowerCase() === 'ц') modes.switchTo('WINDOW')
  })
```

Рендер-цикл становится таким:

```ts
  renderer.setAnimationLoop((now) => {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    modes.update(dt)
    const eye = tracker.update(now, dt)
    applyOffAxis(camera, eye, calibration.screenWcm, calibration.screenHcm)
    const scene = modes.mode === 'MIRROR' ? mirrorScene : windowScene
    renderer.render(scene, camera)
    segmenter.update(now)
    const personOpacity = modes.mode === 'MIRROR' ? 1 : 0
    compositor.render(renderer, segmenter.texture, personOpacity, modes.fade)
  })
```

(Старую строку `const scene = await buildMirrorScene()` и старые вызовы рендера удалить.)

- [ ] **Step 7: Ручная проверка**

Run: `npm run dev`
Expected:
- `W` → короткое затемнение → вид из окна: панорама города за рамой, фигуры нет
- двигаешь голову → рама заметно параллаксится относительно города (эффект настоящего окна)
- `M` → обратно в зеркало, фигура вернулась
- переключение ощущается мгновенным (< 0.5 с)

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: режим «Окно» + стейт-машина переключения с фейдом"
```

---

### Task 10: Debug-панель и панель калибровки

**Files:**
- Create: `src/debug/panel.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: src/debug/panel.ts**

```ts
import type { EyeCm } from '../render/offAxis'
import { type Calibration, saveCalibration } from '../app/calibration'

// D — статистика, C — калибровка. Прототип: без фреймворков, голый DOM.
export class DebugPanel {
  private stats = document.createElement('pre')
  private form = document.createElement('div')
  private renderFrames = 0
  private renderFps = 0
  private windowStart = performance.now()

  constructor(private calibration: Calibration, private onCalibrationChange: () => void) {
    this.stats.style.cssText =
      'position:fixed;top:8px;left:8px;color:#0f0;font:12px monospace;z-index:10;' +
      'background:rgba(0,0,0,.5);padding:6px;display:none'
    document.body.appendChild(this.stats)

    this.form.style.cssText =
      'position:fixed;top:8px;right:8px;color:#fff;font:13px system-ui;z-index:10;' +
      'background:rgba(0,0,0,.8);padding:12px;border-radius:8px;display:none'
    this.buildForm()
    document.body.appendChild(this.form)

    addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase()
      if (k === 'd' || k === 'в') this.stats.style.display = this.stats.style.display === 'none' ? 'block' : 'none'
      if (k === 'c' || k === 'с') this.form.style.display = this.form.style.display === 'none' ? 'block' : 'none'
    })
  }

  private buildForm(): void {
    const fields: [keyof Calibration, string][] = [
      ['screenWcm', 'Ширина экрана, см'],
      ['screenHcm', 'Высота экрана, см'],
      ['camOffsetXcm', 'Камера: смещение X, см'],
      ['camOffsetYcm', 'Камера: смещение Y, см'],
      ['webcamHfovDeg', 'FOV вебки, °'],
    ]
    this.form.innerHTML = '<b>Калибровка</b><br>'
    for (const [key, label] of fields) {
      const row = document.createElement('label')
      row.style.cssText = 'display:block;margin:6px 0'
      row.textContent = label + ' '
      const input = document.createElement('input')
      input.type = 'number'
      input.step = '0.1'
      input.value = String(this.calibration[key])
      input.style.width = '70px'
      input.onchange = () => {
        this.calibration[key] = Number(input.value)
        saveCalibration(this.calibration)
        this.onCalibrationChange()
      }
      row.appendChild(input)
      this.form.appendChild(row)
    }
  }

  // Зовётся каждый кадр рендера
  frame(eye: EyeCm, faceVisible: boolean, segFps: number, videoLagMs: number): void {
    this.renderFrames++
    const now = performance.now()
    if (now - this.windowStart > 1000) {
      this.renderFps = this.renderFrames
      this.renderFrames = 0
      this.windowStart = now
    }
    if (this.stats.style.display !== 'none') {
      this.stats.textContent =
        `render: ${this.renderFps} fps\n` +
        `сегментация: ${segFps} fps\n` +
        `возраст кадра камеры: ~${videoLagMs.toFixed(0)} мс\n` +
        `eye: x=${eye.x.toFixed(1)} y=${eye.y.toFixed(1)} z=${eye.z.toFixed(1)} см\n` +
        `лицо: ${faceVisible ? 'да' : 'нет'}\n` +
        `клавиши: M зеркало, W окно, C калибровка`
    }
  }
}
```

- [ ] **Step 2: Подключить в src/main.ts**

```ts
import { DebugPanel } from './debug/panel'
```

После создания tracker (он держит ссылку на calibration — панель меняет её на месте):

```ts
  const debug = new DebugPanel(calibration, () => { /* размеры экрана подхватятся в следующем кадре */ })

  // возраст последнего кадра камеры — грубая оценка вклада камеры в задержку
  let lastVideoFrameAt = performance.now()
  const onVideoFrame = () => {
    lastVideoFrameAt = performance.now()
    video.requestVideoFrameCallback(onVideoFrame)
  }
  video.requestVideoFrameCallback(onVideoFrame)
```

В конец рендер-цикла:

```ts
    debug.frame(eye, tracker.faceVisible, segmenter.fps, performance.now() - lastVideoFrameAt)
```

- [ ] **Step 3: Ручная проверка**

Run: `npm run dev`
Expected:
- `D` → панель: render ≥ 50 fps, сегментация ≥ 24 fps, возраст кадра < 50 мс
- `C` → форма калибровки; поменял «ширину экрана» → параллакс стал шире/уже сразу
- перезагрузка страницы сохраняет введённые значения

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: debug-панель (FPS, задержка) и UI калибровки"
```

---

### Task 11: README и чек-лист приёмки

**Files:**
- Create: `README.md`

- [ ] **Step 1: README.md**

```markdown
# Stellar Mirror — прототип

«Виртуальное зеркало» для инсталляции Stellar Residence: видишь себя в 3D-интерьере,
фон параллаксится от положения головы. Спека: `docs/superpowers/specs/2026-06-10-stellar-mirror-prototype-design.md`.

## Запуск

    npm install
    npm run dev        # http://localhost:5173, разрешить камеру
    npm test           # юнит-тесты

## Клавиши

| Клавиша | Действие |
|---|---|
| `M` | режим «Зеркало» (ты в интерьере) |
| `W` | режим «Окно» (вид на город) |
| `D` | debug-панель (FPS, задержка, позиция головы) |
| `C` | калибровка (размеры экрана, смещение камеры, FOV вебки) |

## Калибровка под свой ноутбук

Нажми `C` и введи: ширину/высоту видимой области экрана в сантиметрах (линейкой),
смещение камеры от центра экрана (обычно X=0, Y = высота/2 + 1 см). FOV вебки —
63° если не знаешь точно.

## Чек-лист приёмки (из спеки)

- [ ] Видишь себя в 3D-интерьере, фон параллаксится от движения головы
- [ ] Debug: render ≥ 50 fps, сегментация ≥ 24 fps, возраст кадра камеры < 50 мс
- [ ] `W`/`M` переключают режимы, шторка < 0.5 с
- [ ] Закрыть камеру рукой → картинка плавно уезжает в нейтральный ракурс, без рывков
- [ ] Два человека в кадре → трекается ближний
- [ ] Запрет камеры → понятное сообщение, не чёрный экран
- [ ] Замена интерьера/панорамы = правка `src/scenes/config.ts`

## Замена контента

Все пути и габариты — в `src/scenes/config.ts`. Появится GLTF-квартира от заказчика —
прописать в `interiorGltfUrl`, процедурная комната отключится сама.
```

- [ ] **Step 2: Финальная проверка**

Run: `npm test && npm run build`
Expected: тесты PASS, сборка без ошибок TypeScript

Пройти чек-лист из README руками.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: README с чек-листом приёмки прототипа"
```


