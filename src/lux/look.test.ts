import { describe, expect, it } from 'vitest'
import { LOOK_DEFAULTS, resolveLook, loadLook, type ResolvedLook, type FetchLike } from './look'
import { LUX_CONFIG } from './config'
import { makeMultiplyBlitMat, makeBakedShadowMat } from './multiplyBlit'

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

  it('результат изолирован — мутация результата не портит дефолты', () => {
    const r = resolveLook(LOOK_DEFAULTS, { grade: { contrast: 1.2 } })
    expect(r.matte.feather).not.toBe(LOOK_DEFAULTS.matte.feather)        // не та же ссылка
    r.matte.feather[0] = 999
    r.shadow.multiply.tint[0] = 999
    expect(LOOK_DEFAULTS.matte.feather[0]).toBe(0.4)                     // дефолт цел
    expect(LOOK_DEFAULTS.shadow.multiply.tint[0]).toBe(0.40)
  })
})

describe('LOOK_DEFAULTS привязаны к текущим источникам (гард миграции)', () => {
  it('grade ← LUX_CONFIG (config.ts)', () => {
    expect(LOOK_DEFAULTS.grade.contrast).toBe(LUX_CONFIG.contrast)
    expect(LOOK_DEFAULTS.grade.temp).toBe(LUX_CONFIG.temp)
    expect(LOOK_DEFAULTS.grade.shade).toBe(LUX_CONFIG.shadeAmount)
    expect(LOOK_DEFAULTS.grade.wrapStrength).toBe(LUX_CONFIG.wrapStrength)
    expect(LOOK_DEFAULTS.grade.colorMatch.cast).toBe(LUX_CONFIG.colorMatch.cast)
    expect(LOOK_DEFAULTS.grade.colorMatch.exposure).toBe(LUX_CONFIG.colorMatch.exposure)
  })

  it('matte / unify ← LUX_CONFIG (config.ts)', () => {
    expect(LOOK_DEFAULTS.matte.erode).toBe(LUX_CONFIG.erode)
    expect(LOOK_DEFAULTS.matte.feather).toEqual(LUX_CONFIG.feather)
    expect(LOOK_DEFAULTS.unify.grain).toBe(LUX_CONFIG.grainAmount)
    expect(LOOK_DEFAULTS.unify.bloom).toBe(LUX_CONFIG.bloom)
  })

  it('shadow strength/softness/bias ← LUX_CONFIG.shadow (config.ts)', () => {
    expect(LOOK_DEFAULTS.shadow.strength).toBe(LUX_CONFIG.shadow.strength)
    expect(LOOK_DEFAULTS.shadow.softness).toBe(LUX_CONFIG.shadow.softness)
    expect(LOOK_DEFAULTS.shadow.bias).toBe(LUX_CONFIG.shadow.bias)
  })

  it('shadow.multiply ← дефолты makeMultiplyBlitMat (multiplyBlit.ts)', () => {
    const u = makeMultiplyBlitMat().uniforms
    expect(LOOK_DEFAULTS.shadow.multiply.centerDark).toBe(u.uCenterDark.value)
    expect(LOOK_DEFAULTS.shadow.multiply.edgeDark).toBe(u.uEdgeDark.value)
    expect(LOOK_DEFAULTS.shadow.multiply.blur).toBe(u.uBlur.value)
    const tint = u.uShadowTint.value as { r: number; g: number; b: number }
    expect(LOOK_DEFAULTS.shadow.multiply.tint).toEqual([tint.r, tint.g, tint.b])
    // ловушка двойного множителя: per-world strength = единственная сила (config), материал тоже 0.5
    expect(u.uShadowStrength.value).toBe(LUX_CONFIG.shadow.strength)
  })

  it('shadow.baked.feetUV + multiply.maxShadow ← дефолты makeBakedShadowMat (multiplyBlit.ts)', () => {
    const u = makeBakedShadowMat().uniforms
    const feet = u.uFeetMask.value as { x: number; y: number }
    expect(LOOK_DEFAULTS.shadow.baked.feetUV).toEqual([feet.x, feet.y])
    expect(LOOK_DEFAULTS.shadow.multiply.maxShadow).toBe(u.uMaxShadow.value)
  })

  it('shadow.proxy ≠ shadow.multiply (ловушка centerDark ×3: 0.12 прокси против 0.36 материала)', () => {
    // прокси-оверрайды захардкожены в compositor.ts:677-679 (не экспортированы) — пиним литералами
    expect(LOOK_DEFAULTS.shadow.proxy.centerDark).toBe(0.12)
    expect(LOOK_DEFAULTS.shadow.proxy.edgeDark).toBe(0.03)
    expect(LOOK_DEFAULTS.shadow.proxy.blur).toBe(0.014)
    expect(LOOK_DEFAULTS.shadow.proxy.feetCutR).toBe(0.16)
    // ключ: это ДРУГИЕ поля, чем multiply.* — слияние в одно утроило бы тьму прокси
    expect(LOOK_DEFAULTS.shadow.proxy.centerDark).not.toBe(LOOK_DEFAULTS.shadow.multiply.centerDark)
  })

  it('хардкоды compositor.ts пинятся литералами (проводятся в P2/контакт-фазе)', () => {
    // источники: compositor.ts BAKED_RAISE=0.05; blob opacity 0.36 (:743), ratioY 0.3 (:741),
    // raise 0.04 (:739); bloomThreshold 0.72 (:194); shrinkK 0.89 (shadowScene3D.ts:127)
    expect(LOOK_DEFAULTS.shadow.baked.raise).toBe(0.05)
    expect(LOOK_DEFAULTS.shadow.blob.opacity).toBe(0.36)
    expect(LOOK_DEFAULTS.shadow.blob.ratioY).toBe(0.3)
    expect(LOOK_DEFAULTS.shadow.blob.raise).toBe(0.04)
    expect(LOOK_DEFAULTS.unify.bloomThreshold).toBe(0.72)
    expect(LOOK_DEFAULTS.shadow.proxy.shrinkK).toBe(0.89)
    expect(LOOK_DEFAULTS.crop.edgeFade).toBe(0.03)
    expect(LOOK_DEFAULTS.crop.sbsSeamGuard).toBe(0.0015)
  })

  it('новые ветки в NO-OP (поведение при проводке не изменится)', () => {
    expect(LOOK_DEFAULTS.deshadow.mode).toBe('off')
    expect(LOOK_DEFAULTS.shadow.contact.enabled).toBe(false)
    expect(LOOK_DEFAULTS.geom.anchorMode).toBe('coverfit')
    expect(LOOK_DEFAULTS.grade.saturation).toBe(1.0)
    expect(LOOK_DEFAULTS.grade.gain).toBe(1.0)
    expect(LOOK_DEFAULTS.unify.lut).toBeNull()
    expect(LOOK_DEFAULTS.unify.lutStrength).toBe(1.0)
    expect(LOOK_DEFAULTS.unify.vignette).toBe(0.0)
  })
})

const okFetch = (body: unknown): FetchLike => async () => ({ ok: true, json: async () => body })

describe('loadLook', () => {
  it('валидный look.json → мёрж над дефолтами', async () => {
    const r = await loadLook('living', okFetch({ grade: { contrast: 1.3 } }))
    expect(r.grade.contrast).toBe(1.3)
    expect(r.grade.temp).toBe(LOOK_DEFAULTS.grade.temp)
  })

  it('файла нет (ok:false) → чистые дефолты', async () => {
    const f: FetchLike = async () => ({ ok: false, json: async () => ({}) })
    expect(await loadLook('x', f)).toEqual(LOOK_DEFAULTS)
  })

  it('сеть упала (throw) → чистые дефолты', async () => {
    const f: FetchLike = async () => { throw new Error('net') }
    expect(await loadLook('x', f)).toEqual(LOOK_DEFAULTS)
  })

  it('мусор вместо объекта → чистые дефолты', async () => {
    expect(await loadLook('x', okFetch('не объект'))).toEqual(LOOK_DEFAULTS)
    expect(await loadLook('x', okFetch(null))).toEqual(LOOK_DEFAULTS)
  })

  it('запрашивает правильный URL мира', async () => {
    let seen = ''
    const f: FetchLike = async (u: string) => { seen = u; return { ok: true, json: async () => ({}) } }
    await loadLook('bedroom', f)
    expect(seen).toBe('/assets/worlds/bedroom/look.json')
  })

  it('массив из JSON-оверрайда заменяется целиком', async () => {
    const r = await loadLook('x', okFetch({ matte: { feather: [0.5, 0.9] } }))
    expect(r.matte.feather).toEqual([0.5, 0.9])
    expect(r.matte.erode).toBe(LOOK_DEFAULTS.matte.erode)
  })
})
