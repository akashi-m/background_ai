import { describe, expect, it } from 'vitest'
import { LOOK_DEFAULTS, resolveLook, type ResolvedLook } from './look'

describe('resolveLook (deep-merge)', () => {
  it('пустой/нулевой оверрайд → глубоко равно дефолтам', () => {
    expect(resolveLook(LOOK_DEFAULTS, null)).toEqual(LOOK_DEFAULTS)
    expect(resolveLook(LOOK_DEFAULTS, undefined)).toEqual(LOOK_DEFAULTS)
    expect(resolveLook(LOOK_DEFAULTS, {})).toEqual(LOOK_DEFAULTS)
  })

  it('скалярный оверрайд листа меняет только его, соседей не трогает', () => {
    const r = resolveLook(LOOK_DEFAULTS, { grade: { contrast: 1.2 } })
    expect(r.grade.contrast).toBe(1.2)
    expect(r.grade.temp).toBe(LOOK_DEFAULTS.grade.temp)
    expect(r.unify.bloom).toBe(LOOK_DEFAULTS.unify.bloom)
  })

  it('вложенный объект мёржится по листам', () => {
    const r = resolveLook(LOOK_DEFAULTS, { grade: { colorMatch: { cast: 0.9 } } })
    expect(r.grade.colorMatch.cast).toBe(0.9)
    expect(r.grade.colorMatch.exposure).toBe(LOOK_DEFAULTS.grade.colorMatch.exposure)
  })

  it('массив заменяется целиком (не мёржится поэлементно)', () => {
    const r = resolveLook(LOOK_DEFAULTS, { matte: { feather: [0.5, 0.9] } })
    expect(r.matte.feather).toEqual([0.5, 0.9])
    expect(r.matte.erode).toBe(LOOK_DEFAULTS.matte.erode)
  })

  it('не мутирует дефолты', () => {
    const before = JSON.stringify(LOOK_DEFAULTS)
    resolveLook(LOOK_DEFAULTS, { grade: { contrast: 99 } })
    expect(JSON.stringify(LOOK_DEFAULTS)).toBe(before)
  })

  it('результат — валидный ResolvedLook со всеми ветками', () => {
    const r: ResolvedLook = resolveLook(LOOK_DEFAULTS, { shadow: { strength: 0.7 } })
    expect(r.shadow.strength).toBe(0.7)
    expect(r.shadow.multiply.centerDark).toBe(LOOK_DEFAULTS.shadow.multiply.centerDark)
  })
})
