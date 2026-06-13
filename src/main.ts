import * as THREE from 'three'
import { openCamera, showFatalError } from './tracking/camera'
import { HeadTracker } from './tracking/headTracker'
import { loadCalibration } from './app/calibration'
import { applyOffAxis } from './render/offAxis'
import { WorldSwitcher } from './app/worldSwitcher'
import { parseWorldMeta } from './app/worldMeta'
import { buildWorld, saveDepthOverride, type BuiltWorld } from './scenes/worldScene'
import { dollyFromEyeZ } from './app/dolly'
import { DebugPanel } from './debug/panel'
import { AlignController } from './debug/align'
import { SCENE_CONFIG } from './scenes/config'
import { LUX_CONFIG } from './lux/config'
import { PersonStream } from './lux/personStream'
import { Experience } from './lux/experience'
import { LuxCompositor, type HarmonizeToggles } from './lux/compositor'
import { IdleSlides } from './lux/idle'
import { loadLutTexture } from './lux/lut'
import { shadowFromBbox, SmoothedShadow } from './lux/shadow'
import { parseDevFlags } from './lux/devFlags'
import { LuxUI, interiorLabels } from './lux/ui'

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Не загрузился ассет: ${url} (HTTP ${res.status})`)
  return res.json()
}

async function start() {
  const flags = parseDevFlags(location.search)
  const calibration = loadCalibration()
  let tracker: HeadTracker | null = null
  let videoLag: () => number = () => 0
  if (!flags.noTracker) {
    const video = await openCamera() // HeadTracker-параллакс фона (v2)
    tracker = new HeadTracker(video, calibration)
    await tracker.init()
    let lastVideoFrameAt = performance.now()
    const onVideoFrame = () => {
      lastVideoFrameAt = performance.now()
      ;(video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void }).requestVideoFrameCallback(onVideoFrame)
    }
    ;(video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): void }).requestVideoFrameCallback(onVideoFrame)
    videoLag = () => performance.now() - lastVideoFrameAt
  }

  const renderer = new THREE.WebGLRenderer({ antialias: false })
  renderer.setSize(innerWidth, innerHeight)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.autoClear = false
  document.body.appendChild(renderer.domElement)

  const compositor = new LuxCompositor(
    renderer,
    Math.floor(innerWidth * renderer.getPixelRatio()),
    Math.floor(innerHeight * renderer.getPixelRatio()),
    { wrapStrength: LUX_CONFIG.wrapStrength, grainAmount: LUX_CONFIG.grainAmount, feather: LUX_CONFIG.feather, colorMatch: LUX_CONFIG.colorMatch, shadeAmount: LUX_CONFIG.shadeAmount },
  )
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight)
    compositor.setSize(Math.floor(innerWidth * renderer.getPixelRatio()), Math.floor(innerHeight * renderer.getPixelRatio()))
  })

  // Миры-интерьеры + их LUT
  const worlds: BuiltWorld[] = await Promise.all(
    SCENE_CONFIG.worlds.map(async (name) => {
      const meta = parseWorldMeta(await fetchJson(`/assets/worlds/${name}/meta.json`), name)
      return buildWorld(`/assets/worlds/${name}/`, meta, calibration.screenWcm, calibration.screenHcm, renderer)
    }),
  )
  const luts = await Promise.all(
    worlds.map((w) =>
      loadLutTexture(w.meta.lut ? `/assets/worlds/${w.name}/${w.meta.lut}` : null),
    ),
  )
  const switcher = new WorldSwitcher(worlds.length)

  // Lux: поток фигуры, опыт, слайдшоу, тень
  const person = new PersonStream(LUX_CONFIG.captureUrl)
  person.start()
  const experience = new Experience(LUX_CONFIG)
  if (flags.forcePhase) {
    // форс через публичный механизм F5: крутим цикл до нужной фазы
    while (experience.phase !== flags.forcePhase) experience.forceNext()
  }
  const slides = new IdleSlides(LUX_CONFIG.slideSec)
  await slides.load(
    worlds.filter((w) => w.meta.format === 'photo25d').map((w) => `/assets/worlds/${w.name}/${w.meta.file}`),
  )
  const shadowSmooth = new SmoothedShadow()
  const toggles: HarmonizeToggles = { lut: true, wrap: true, shadow: true, grain: true, colorMatch: true }

  const ui = new LuxUI((i) => switcher.switchTo(i))
  ui.setWorlds(interiorLabels(worlds.map((w) => w.meta)))

  new AlignController(() => worlds[switcher.index], () => SCENE_CONFIG.worlds[switcher.index])

  const PRODUCTION_SCREEN_W_CM = 120
  const savedGain = Number(localStorage.getItem('stellar-mirror.parallaxGain'))
  let parallaxGain = Number.isFinite(savedGain) && savedGain > 0 && savedGain <= 2
    ? savedGain
    : Math.min(1, Math.max(0.5, calibration.screenWcm / PRODUCTION_SCREEN_W_CM))

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return
    if (e.code === 'KeyW') switcher.next()
    if (e.code === 'KeyM') switcher.prev()
    const digit = /^Digit([1-9])$/.exec(e.code)
    if (digit) switcher.switchTo(Number(digit[1]) - 1)
    if (e.code === 'F1') toggles.lut = !toggles.lut
    if (e.code === 'F2') toggles.wrap = !toggles.wrap
    if (e.code === 'F3') toggles.shadow = !toggles.shadow
    if (e.code === 'F4') toggles.grain = !toggles.grain
    if (e.code === 'F6') toggles.colorMatch = !toggles.colorMatch
    if (e.code === 'F5') experience.forceNext()
    if (e.code === 'Comma' || e.code === 'Period') {
      parallaxGain = Math.round(Math.min(2, Math.max(0.1, parallaxGain + (e.code === 'Period' ? 0.05 : -0.05))) * 100) / 100
      localStorage.setItem('stellar-mirror.parallaxGain', String(parallaxGain))
      console.log(`параллакс-гейн: ${parallaxGain}`)
    }
    if (e.code === 'Semicolon' || e.code === 'Quote') {
      const w = worlds[switcher.index]
      if (!w.setDepthAmount || w.depthAmountCm === undefined) return
      const cm = Math.min(200, Math.max(0, w.depthAmountCm + (e.code === 'Quote' ? 5 : -5)))
      w.setDepthAmount(cm)
      saveDepthOverride(w.name, cm)
      console.log(`глубина 2.5D «${w.name}»: ${cm} см`)
    }
  })

  const debug = new DebugPanel(calibration, () => { /* подхватится в следующем кадре */ })

  const camera = new THREE.PerspectiveCamera()

  let last = performance.now()
  renderer.setAnimationLoop((now) => {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    switcher.update(dt)
    person.tick()

    // здоровье потока для опыта: live + телеметрия свежа
    const healthy = person.status === 'live' && person.telemetryAgeSec(now) < LUX_CONFIG.staleSec
    const t = person.telemetry
    experience.update(dt, {
      present: t?.present ?? false,
      distanceCm: t?.distanceCm ?? null,
      healthy,
    })

    const eye = tracker ? tracker.update(now, dt) : { x: 0, y: 0, z: 60 }
    const safeZ = Math.min(Math.max(eye.z, 20), 300)
    const safeEye = { x: eye.x * parallaxGain, y: eye.y * parallaxGain, z: safeZ }
    const cmPerPx = calibration.screenWcm / screen.width
    applyOffAxis(camera, safeEye, innerWidth * cmPerPx, innerHeight * cmPerPx)

    const active = worlds[switcher.index]
    active.dolly.position.z = dollyFromEyeZ(safeZ, active.meta.dollyMaxCm)

    const shadowTarget = experience.phase === 'MIRROR' || experience.phase === 'APPROACH'
      ? shadowFromBbox(healthy ? (t?.bbox ?? null) : null)
      : null
    const shadow = shadowSmooth.update(shadowTarget, dt)

    compositor.render({
      scene: active.scene,
      camera,
      backplate: active.backplate ?? null,
      backplateAspect: active.meta.aspect ?? null,
      person: person.texture,
      personAspect: person.videoAspect,
      lightDirX: active.meta.lightDirX ?? 0,
      mirrorOpacity: experience.mirrorOpacity,
      shadow,
      shadowStrength: active.meta.shadowStrength,
      lut: luts[switcher.index],
      lutSize: luts[switcher.index].image.width,
      toggles,
      fade: switcher.fade,
      slides: slides.update(dt, 1 - experience.mirrorOpacity),
      timeSec: now / 1000,
      canvasAspect: innerWidth / innerHeight,
    })

    ui.setActive(switcher.index)
    ui.update(experience.mirrorOpacity)

    debug.frame(safeEye, tracker?.faceVisible ?? false, 0, videoLag(),
      `lux: ${experience.phase} mirror=${experience.mirrorOpacity.toFixed(2)} поток=${person.status} битых=${person.badMessages}`)
  })
}

start().catch(showFatalError)
