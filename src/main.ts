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
    if (e.code === 'KeyM') modes.switchTo('MIRROR')
    if (e.code === 'KeyW') modes.switchTo('WINDOW')
  })

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
    segmenter.update(now)
    const personOpacity = modes.mode === 'MIRROR' ? 1 : 0
    compositor.render(renderer, segmenter.texture, personOpacity, modes.fade)
  })
}

start().catch(showFatalError)
