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
