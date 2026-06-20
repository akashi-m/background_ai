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
import { createDevPanel } from './lux/devPanel'
import { IdleSlides } from './lux/idle'
import { loadLutTexture } from './lux/lut'
import { shadowFromBbox, SmoothedShadow } from './lux/shadow'
import { personFloorWorld, sampleWorldXYZ, selectShadowMode, PoseSmoother } from './lux/shadowGeom'
import { floorPointAnalytic, heightLockScale } from './lux/mirrorGeom'
import { parseDevFlags } from './lux/devFlags'
import { LuxUI, interiorLabels } from './lux/ui'
import { runGolden } from './lux/golden'
import { loadLook } from './lux/look'

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
  if (!flags.noTracker && !flags.golden) {
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
  // physical-тень прокси (spec §4.0): без shadowMap.enabled castShadow молча
  // игнорируется → тень не появляется. mapSize/bias на самой лампе (keyPointLights).
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  document.body.appendChild(renderer.domElement)

  const compositor = new LuxCompositor(
    renderer,
    Math.floor(innerWidth * renderer.getPixelRatio()),
    Math.floor(innerHeight * renderer.getPixelRatio()),
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
  const worldLooks = await Promise.all(SCENE_CONFIG.worlds.map((n) => loadLook(n)))
  const switcher = new WorldSwitcher(worlds.length)

  // Детерминированный golden-кадр для before/after скрин-диффа (изолировано, см. golden.ts).
  // Возврат ДО живого цикла — на прод-путь не влияет.
  if (flags.golden) {
    await runGolden({ renderer, compositor, world: worlds[0], lut: luts[0], look: worldLooks[0] })
    return
  }

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
  const toggles: HarmonizeToggles = { lut: true, wrap: true, shadow: true, grain: true, colorMatch: true, bloom: true }

  const ui = new LuxUI((i) => switcher.switchTo(i))
  ui.setWorlds(interiorLabels(worlds.map((w) => w.meta)))

  // Мелкий хелпер: мутирует obj по dotted-path (a.b.c)
  function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.')
    let cur: Record<string, unknown> = obj
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur[parts[i]] as Record<string, unknown>
    }
    cur[parts[parts.length - 1]] = value
  }

  // Извлечь значения слайдеров из ResolvedLook для reseed
  function sliderValuesFromLook(look: (typeof worldLooks)[0]): Record<string, number> {
    return {
      wrapStrength:   look.grade.wrapStrength,
      erode:          look.matte.erode,
      grainAmount:    look.unify.grain,
      bloom:          look.unify.bloom,
      bloomThreshold: look.unify.bloomThreshold,
      contrast:       look.grade.contrast,
      temp:           look.grade.temp,
      shade:          look.grade.shade,
      gain:           look.grade.gain,
      cast:           look.grade.colorMatch.cast,
      exposure:       look.grade.colorMatch.exposure,
    }
  }

  const initialLook = worldLooks[0]

  // dev-панель реал-тайм тюна пост-обработки (тоггл G; скрыта по умолчанию)
  const devPanel = createDevPanel(
    [
      { key: 'wrapStrength', label: 'light wrap', min: 0, max: 1, step: 0.01, value: initialLook.grade.wrapStrength },
      { key: 'erode', label: 'erode (RVM)', min: 0, max: 0.01, step: 0.0005, value: initialLook.matte.erode },
      { key: 'grainAmount', label: 'grain', min: 0, max: 0.15, step: 0.005, value: initialLook.unify.grain },
      { key: 'bloom', label: 'bloom', min: 0, max: 1.5, step: 0.05, value: initialLook.unify.bloom },
      { key: 'bloomThreshold', label: 'bloom thr', min: 0.4, max: 1, step: 0.02, value: initialLook.unify.bloomThreshold },
      { key: 'contrast', label: 'contrast', min: 0.8, max: 1.4, step: 0.01, value: initialLook.grade.contrast },
      { key: 'temp', label: 'temp', min: -0.1, max: 0.1, step: 0.005, value: initialLook.grade.temp },
      { key: 'shade', label: 'shade', min: 0, max: 0.5, step: 0.01, value: initialLook.grade.shade },
      { key: 'gain', label: 'person brightness', min: 0.3, max: 1.5, step: 0.01, value: initialLook.grade.gain },
      { key: 'cast', label: 'colorMatch cast', min: 0, max: 1, step: 0.01, value: initialLook.grade.colorMatch.cast },
      { key: 'exposure', label: 'colorMatch exp', min: 0, max: 0.5, step: 0.01, value: initialLook.grade.colorMatch.exposure },
    ],
    // setLookValue: мутирует worldLooks[active] по dotted look-path
    (path: string, value: number) => {
      setPath(worldLooks[switcher.index] as unknown as Record<string, unknown>, path, value)
    },
    // onSave: POST активный look на Vite dev-эндпоинт /__look/:world
    () => {
      const worldName = SCENE_CONFIG.worlds[switcher.index]
      fetch(`/__look/${worldName}`, {
        method: 'POST',
        body: JSON.stringify(worldLooks[switcher.index]),
      }).catch((e) => console.warn('look save failed:', e))
    },
  )

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
    if (e.code === 'KeyG') devPanel.toggle() // dev-панель тюна пост-обработки

    const digit = /^Digit([1-9])$/.exec(e.code)
    if (digit) switcher.switchTo(Number(digit[1]) - 1)
    if (e.code === 'F1') toggles.lut = !toggles.lut
    if (e.code === 'F2') toggles.wrap = !toggles.wrap
    if (e.code === 'F3') toggles.shadow = !toggles.shadow
    if (e.code === 'F4') toggles.grain = !toggles.grain
    if (e.code === 'F6') toggles.colorMatch = !toggles.colorMatch
    if (e.code === 'F7') toggles.bloom = !toggles.bloom
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

  // физическая тень: сглаженные точка ног F и рост H посетителя в мире
  let smoothF: [number, number, number] | null = null
  let smoothH = 1.7
  const poseSmoother = new PoseSmoother()
  // height-lock 1:1 (anchorMode='height'): сглаженный общий масштаб фигуры+тени (EWMA)
  let smoothScale: { sx: number; sy: number } | null = null

  let last = performance.now()
  let prevSwitcherIndex = switcher.index
  renderer.setAnimationLoop((now) => {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    switcher.update(dt)
    // при смене мира — пересидировать слайдеры из нового worldLook
    if (switcher.index !== prevSwitcherIndex) {
      prevSwitcherIndex = switcher.index
      devPanel.reseed(sliderValuesFromLook(worldLooks[switcher.index]))
    }
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

    // точка ног посетителя в мире (для физической тени) — со сглаживанием F/H;
    // mirror-X центра bbox, как делает существующая силуэтная тень
    const sd = active.shadowData
    let personFloor: { F: [number, number, number]; H: number } | null = null
    let feetUV: { u: number; v: number; halfW: number } | null = null
    // экранная точка ступней (плейт-uv) для контактной blob-тени — нужна всегда,
    // когда есть фигура в кадре (даже без мир-данных)
    if (healthy && t?.bbox) {
      const [bx0, , bx1, by1] = t.bbox
      feetUV = { u: 1 - (bx0 + bx1) / 2, v: 1 - by1, halfW: (bx1 - bx0) / 2 }
    }
    if (sd && healthy && t?.bbox && t.distanceCm != null) {
      const [x0, y0, x1, y1] = t.bbox
      // рост — из телеметрии (bbox+дистанция); F — якорь к экранным ступням:
      // worldPos-EXR = обратная проекция камеры-плейта, сэмплим точку пола под
      // ступнями (X зеркалится как у фигуры, низ bbox = y1 → texture v = 1-y1).
      const H = personFloorWorld(
        { distanceCm: t.distanceCm, bboxCx: 1 - (x0 + x1) / 2, bboxH: y1 - y0 },
        sd.camera, sd.floorZ,
      ).H
      // F: EXR-сэмпл когда worldPosData есть (living/etc.); иначе аналитический луч
      // камеры → пол Z=floorZ (lobby, flat без EXR) — тот же mirror-U / низ-bbox-V.
      const F = sd.worldPosData != null
        ? sampleWorldXYZ(sd.worldPosData, 1 - (x0 + x1) / 2, 1 - y1)
        : floorPointAnalytic(sd.camera, 1 - (x0 + x1) / 2, 1 - y1, sd.floorZ)
      const k = 1 - Math.exp(-dt * 8)
      smoothF = smoothF
        ? [smoothF[0] + (F[0] - smoothF[0]) * k, smoothF[1] + (F[1] - smoothF[1]) * k, smoothF[2] + (F[2] - smoothF[2]) * k]
        : F
      smoothH = smoothH + (H - smoothH) * k
      personFloor = { F: smoothF, H: smoothH }
    } else {
      smoothF = null
    }

    // height-lock 1:1: при anchorMode='height' (+ есть рост H и bbox) считаем единый
    // масштаб фигуры+тени так, чтобы аватар читался в натуральный рост; иначе cover-fit.
    const look0 = worldLooks[switcher.index]
    let scaleOverride: { sx: number; sy: number } | undefined
    if (look0.geom.anchorMode === 'height' && personFloor && t?.bbox) {
      const [, sy0, , sy1] = t.bbox
      const target = heightLockScale({
        H_m: smoothH,
        bboxHfrac: sy1 - sy0,
        canvasHeightPx: Math.floor(innerHeight * renderer.getPixelRatio()),
        screenHcm: calibration.screenHcm,
        mirrorMag: look0.geom.mirrorMag,
        personAspect: person.videoAspect ?? 1,
        canvasAspect: innerWidth / innerHeight,
      })
      const ks = 1 - Math.exp(-dt * 4)
      smoothScale = smoothScale
        ? { sx: smoothScale.sx + (target.sx - smoothScale.sx) * ks, sy: smoothScale.sy + (target.sy - smoothScale.sy) * ks }
        : target
      scaleOverride = smoothScale
    } else {
      smoothScale = null
      scaleOverride = undefined
    }

    compositor.render({
      scene: active.scene,
      camera,
      backplate: active.backplate ?? null,
      backplateAspect: active.meta.aspect ?? null,
      person: person.texture,
      personAspect: person.videoAspect,
      scaleOverride,
      lightDirX: active.meta.lightDirX ?? 0,
      mirrorOpacity: experience.mirrorOpacity,
      shadow,
      shadowStrength: active.meta.shadowStrength,
      shadowData: active.shadowData ? {
        lamps: active.shadowData.lamps,
        worldPos: active.shadowData.worldPos,
        floorZ: active.shadowData.floorZ,
        camera: active.shadowData.camera,
        bakedShadow: active.shadowData.bakedShadow ?? null,
      } : null,
      personFloor,
      pose: (() => {
        if (!sd || !smoothF || !t?.pose) return null
        const mode = selectShadowMode({ hasPose: true, F: smoothF, floorZ: sd.floorZ, hasShadowData: true })
        if (mode !== 'proxy') return null
        return { world: poseSmoother.push(t.pose.world, dt), healthy: t.pose.healthy }
      })(),
      feetUV,
      shadowCfg: LUX_CONFIG.shadow,
      lut: luts[switcher.index],
      lutSize: luts[switcher.index].image.width,
      toggles,
      fade: switcher.fade,
      slides: slides.update(dt, 1 - experience.mirrorOpacity),
      timeSec: now / 1000,
      canvasAspect: innerWidth / innerHeight,
      look: worldLooks[switcher.index],
    })

    ui.setActive(switcher.index)
    ui.update(experience.mirrorOpacity)

    debug.frame(safeEye, tracker?.faceVisible ?? false, 0, videoLag(),
      `lux: ${experience.phase} mirror=${experience.mirrorOpacity.toFixed(2)} поток=${person.status} битых=${person.badMessages}`)
  })
}

start().catch(showFatalError)
