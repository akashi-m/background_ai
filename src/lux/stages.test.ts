import { describe, expect, it } from 'vitest'
import { activeStages, STAGE_ORDER, type StageFrame, type StageInputs } from './stages'

// Базовый StageInputs; точечно переопределяем под сценарий.
function inputs(over: Partial<StageInputs>): StageInputs {
  return {
    toggles: { shadow: true, bloom: false, lut: true },
    person: null, shadowData: null, personFloor: null, pose: null, feetUV: null,
    slides: { visible: 0, a: null }, fade: 0,
    ...over,
  }
}
function frame(mirrorVisible: boolean, over: Partial<StageInputs>): StageFrame {
  return { opts: inputs(over), mirrorVisible, sx: 1, sy: 1 }
}

const PERSON = {} // непустой маркер текстуры
const SHADOW_BAKED = { bakedShadow: {} }
const SHADOW_NOBAKE = { bakedShadow: null }
const FLOOR = { F: [0, 0, 0], H: 1.7 }
const POSE = { world: [], healthy: 1 }
const FEET = { u: 0.5, v: 0.1, halfW: 0.1 }

describe('activeStages — порядок и предикаты (сверено с render())', () => {
  it('STAGE_ORDER — канонический порядок из 12 стадий', () => {
    expect(STAGE_ORDER).toEqual([
      'sceneBackground', 'compositeBase', 'idleSlides', 'bakedShadow', 'proxyShadow',
      'fallbackSilhouette', 'blobContact', 'person', 'unifyLut', 'bloom', 'grainPresent', 'fadeCurtain',
    ])
  })

  it('MIRROR + baked + floor + pose + feetUV + bloom on', () => {
    expect(activeStages(frame(true, {
      toggles: { shadow: true, bloom: true, lut: true }, person: PERSON,
      shadowData: SHADOW_BAKED, personFloor: FLOOR, pose: POSE, feetUV: FEET,
    }))).toEqual(['sceneBackground', 'compositeBase', 'bakedShadow', 'proxyShadow', 'blobContact', 'person', 'unifyLut', 'bloom', 'grainPresent'])
  })

  it('MIRROR + shadowData present но personFloor null → фолбэк-силуэт + фигура', () => {
    // person рисуется ВСЕГДА при mirrorVisible+person (compositor.ts:751, независимо от теней)
    expect(activeStages(frame(true, {
      person: PERSON, shadowData: SHADOW_BAKED, personFloor: null,
    }))).toEqual(['sceneBackground', 'compositeBase', 'fallbackSilhouette', 'person', 'unifyLut', 'grainPresent'])
  })

  it('MIRROR + нет shadowData + feetUV → фолбэк-силуэт + блоб + фигура', () => {
    expect(activeStages(frame(true, {
      person: PERSON, shadowData: null, feetUV: FEET,
    }))).toEqual(['sceneBackground', 'compositeBase', 'fallbackSilhouette', 'blobContact', 'person', 'unifyLut', 'grainPresent'])
  })

  it('IDLE (mirror invisible) + slides + bloom on', () => {
    expect(activeStages(frame(false, {
      toggles: { shadow: true, bloom: true, lut: true }, slides: { visible: 1, a: {} },
    }))).toEqual(['compositeBase', 'idleSlides', 'bloom', 'grainPresent'])
  })

  it('MIRROR + shadowData без baked + floor + pose → только proxy (без baked)', () => {
    expect(activeStages(frame(true, {
      person: PERSON, shadowData: SHADOW_NOBAKE, personFloor: FLOOR, pose: POSE,
    }))).toEqual(['sceneBackground', 'compositeBase', 'proxyShadow', 'person', 'unifyLut', 'grainPresent'])
  })

  it('MIRROR + baked + floor, pose null, feetUV → baked + блоб (без proxy)', () => {
    expect(activeStages(frame(true, {
      person: PERSON, shadowData: SHADOW_BAKED, personFloor: FLOOR, pose: null, feetUV: FEET,
    }))).toEqual(['sceneBackground', 'compositeBase', 'bakedShadow', 'blobContact', 'person', 'unifyLut', 'grainPresent'])
  })

  it('MIRROR + shadow OFF + feetUV + bloom on + fade>0 → без теней, со шторкой', () => {
    expect(activeStages(frame(true, {
      toggles: { shadow: false, bloom: true, lut: true }, person: PERSON, feetUV: FEET, fade: 0.5,
    }))).toEqual(['sceneBackground', 'compositeBase', 'person', 'unifyLut', 'bloom', 'grainPresent', 'fadeCurtain'])
  })

  it('MIRROR + toggles.lut=false → unifyLut отсутствует', () => {
    expect(activeStages(frame(true, {
      toggles: { shadow: true, bloom: false, lut: false }, person: PERSON,
    }))).toEqual(['sceneBackground', 'compositeBase', 'fallbackSilhouette', 'person', 'grainPresent'])
  })
})
