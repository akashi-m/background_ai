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
import { AlignController } from './debug/align'
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

  const renderer = new THREE.WebGLRenderer({ antialias: false }) // antialias выключен: Spark не выигрывает от MSAA, а fps теряет
  renderer.setSize(innerWidth, innerHeight)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  document.body.appendChild(renderer.domElement)
  addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight))

  // Загружаем все миры (их немного; Spark стримит сплаты с LOD сам).
  // При росте списка >5 — перейти на ленивую подгрузку соседей.
  const worlds: BuiltWorld[] = await Promise.all(
    SCENE_CONFIG.worlds.map(async (name) => {
      const meta = parseWorldMeta(await fetchJson(`/assets/worlds/${name}/meta.json`), name)
      return buildWorld(`/assets/worlds/${name}/`, meta, calibration.screenWcm, calibration.screenHcm, renderer)
    }),
  )
  const switcher = new WorldSwitcher(worlds.length)

  new AlignController(
    () => worlds[switcher.index],
    () => SCENE_CONFIG.worlds[switcher.index],
  )

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
