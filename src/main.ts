import * as THREE from 'three'
import { openCamera, showFatalError } from './tracking/camera'
import { HeadTracker } from './tracking/headTracker'
import { PersonSegmenter } from './tracking/segmenter'
import { loadCalibration } from './app/calibration'
import { applyOffAxis } from './render/offAxis'
import { buildMirrorScene } from './scenes/mirrorScene'
import { buildWindowScene } from './scenes/windowScene'
import { Compositor } from './render/compositor'
import { ModeMachine } from './app/modes'
import { DebugPanel } from './debug/panel'

async function start() {
  const video = await openCamera()
  const calibration = loadCalibration()
  const tracker = new HeadTracker(video, calibration)
  await tracker.init()
  const segmenter = new PersonSegmenter(video)
  await segmenter.init()
  const compositor = new Compositor(video)

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(innerWidth, innerHeight)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  document.body.appendChild(renderer.domElement)
  addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight))

  const mirrorScene = await buildMirrorScene()
  const windowScene = await buildWindowScene(calibration.screenWcm, calibration.screenHcm)
  const modes = new ModeMachine()

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return
    if (e.code === 'KeyM') modes.switchTo('MIRROR')
    if (e.code === 'KeyW') modes.switchTo('WINDOW')
  })

  // Геометрия оконного фрейма (windowScene) строится один раз при старте; изменения
  // screenWcm/screenHcm вступят в силу только после перезагрузки страницы (ограничение прототипа).
  const debug = new DebugPanel(calibration, () => { /* размеры экрана подхватятся в следующем кадре */ })

  // возраст последнего кадра камеры — грубая оценка вклада камеры в задержку
  let lastVideoFrameAt = performance.now()
  const onVideoFrame = () => {
    lastVideoFrameAt = performance.now()
    ;(video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void }).requestVideoFrameCallback(onVideoFrame)
  }
  ;(video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void }).requestVideoFrameCallback(onVideoFrame)

  const camera = new THREE.PerspectiveCamera()

  let last = performance.now()
  renderer.setAnimationLoop((now) => {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    modes.update(dt)
    const eye = tracker.update(now, dt)
    const safeEye = { x: eye.x, y: eye.y, z: Math.min(Math.max(eye.z, 20), 300) }
    // окно браузера может быть не на весь экран: переводим px → см через калибровку
    const cmPerPx = calibration.screenWcm / screen.width
    applyOffAxis(camera, safeEye, innerWidth * cmPerPx, innerHeight * cmPerPx)
    const scene = modes.mode === 'MIRROR' ? mirrorScene : windowScene
    renderer.render(scene, camera)
    // ЗАМЕТКА (fps): детекция лица и сегментация гейтятся одним и тем же новым кадром
    // камеры — раз в ~33 мс один тик rAF несёт обе ML-инференции + рендер.
    // Если ручной тест покажет провалы fps — разнести их по чётным/нечётным кадрам.
    segmenter.update(now)
    const personOpacity = modes.mode === 'MIRROR' ? 1 : 0
    compositor.render(renderer, segmenter.texture, personOpacity, modes.fade)
    debug.frame(safeEye, tracker.faceVisible, segmenter.fps, performance.now() - lastVideoFrameAt)
  })
}

start().catch(showFatalError)
