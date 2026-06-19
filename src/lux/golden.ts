// Детерминированный golden-режим (?golden): рендерит ОДИН воспроизводимый кадр
// (статичный человек-SBS + замороженное время + фикс-размер + фикс-мир) для
// before/after скрин-диффа при поведение-сохраняющих рефакторах компоновщика.
// Полностью изолирован: вызывается только из main.ts за flags.golden и делает return
// до живого цикла — на прод-путь не влияет.

import * as THREE from 'three'

import { LUX_CONFIG } from './config'
import type { LuxCompositor } from './compositor'
import type { BuiltWorld } from '../scenes/worldScene'

// Фикс-размер кадра (9:16, pixelRatio=1) — стабильно между прогонами независимо от окна.
export const GOLDEN_W = 540
export const GOLDEN_H = 960

// Статичный «человек» в SBS-раскладке: левая половина — RGB-силуэт, правая — альфа.
// Чисто процедурно (без рандома/времени) → одинаков каждый прогон.
export function buildGoldenPerson(): { texture: THREE.Texture; aspect: number } {
  const half = 512
  const c = document.createElement('canvas')
  c.width = half * 2
  c.height = half
  const g = c.getContext('2d')!
  g.fillStyle = '#000000'
  g.fillRect(0, 0, half * 2, half)

  const body = { x: half * 0.40, y: half * 0.26, w: half * 0.20, h: half * 0.66 }
  const head = { cx: half * 0.5, cy: half * 0.18, r: half * 0.085 }

  // ЛЕВО — RGB телесно-серый силуэт
  g.fillStyle = '#b0906c'
  g.fillRect(body.x, body.y, body.w, body.h)
  g.beginPath(); g.arc(head.cx, head.cy, head.r, 0, Math.PI * 2); g.fill()
  // ПРАВО — альфа (бел=непрозрачно)
  g.fillStyle = '#ffffff'
  g.fillRect(half + body.x, body.y, body.w, body.h)
  g.beginPath(); g.arc(half + head.cx, head.cy, head.r, 0, Math.PI * 2); g.fill()

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return { texture: tex, aspect: half / half } // personAspect = (width/2)/height = 1.0
}

export async function runGolden(deps: {
  renderer: THREE.WebGLRenderer
  compositor: LuxCompositor
  world: BuiltWorld
  lut: THREE.Data3DTexture
}): Promise<void> {
  const { renderer, compositor, world, lut } = deps
  renderer.setPixelRatio(1)
  renderer.setSize(GOLDEN_W, GOLDEN_H)
  compositor.setSize(GOLDEN_W, GOLDEN_H)

  const { texture: person, aspect: personAspect } = buildGoldenPerson()
  const camera = new THREE.PerspectiveCamera() // flat-мир использует backplate-путь; камера не нужна

  const opts: Parameters<LuxCompositor['render']>[0] = {
    scene: world.scene,
    camera,
    backplate: world.backplate ?? null,
    backplateAspect: world.meta.aspect ?? null,
    person,
    personAspect,
    lightDirX: world.meta.lightDirX ?? 0,
    mirrorOpacity: 1,
    shadow: null,
    shadowStrength: world.meta.shadowStrength,
    shadowData: world.shadowData
      ? {
          lamps: world.shadowData.lamps,
          worldPos: world.shadowData.worldPos,
          floorZ: world.shadowData.floorZ,
          camera: world.shadowData.camera,
          bakedShadow: world.shadowData.bakedShadow ?? null,
        }
      : null,
    personFloor: null, // фолбэк-силуэт + блоб (без proxy: pose=null)
    pose: null,
    feetUV: { u: 0.5, v: 0.12, halfW: 0.12 },
    shadowCfg: LUX_CONFIG.shadow,
    lut,
    lutSize: lut.image.width,
    toggles: { lut: true, wrap: true, shadow: true, grain: true, colorMatch: true, bloom: true },
    fade: 0,
    slides: { a: null, b: null, mix: 0, visible: 0 },
    timeSec: 0, // замороженное время → зерно детерминировано
    canvasAspect: GOLDEN_W / GOLDEN_H,
  }

  // Несколько кадров — на случай отложенной загрузки/аплоада текстур.
  for (let i = 0; i < 3; i++) compositor.render(opts)

  // Хэш отрендеренных пикселей (точный before/after дифф без JPEG-потерь):
  // readPixels дефолтного фреймбуфера сразу после финального пасса, FNV-1a 32-бит.
  const gl = renderer.getContext()
  const w = renderer.domElement.width
  const h = renderer.domElement.height
  const px = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
  let hash = 0x811c9dc5
  for (let i = 0; i < px.length; i++) {
    hash ^= px[i]
    hash = Math.imul(hash, 0x01000193)
  }
  const win = window as unknown as { __goldenReady?: boolean; __goldenHash?: string; __goldenSize?: string }
  win.__goldenHash = (hash >>> 0).toString(16)
  win.__goldenSize = `${w}x${h}`
  win.__goldenReady = true
}
