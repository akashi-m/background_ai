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
