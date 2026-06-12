import { describe, it, expect } from 'vitest'
import { parseCube, identityLut, makeLutTexture } from './lut'

const CUBE_2 = `# комментарий
TITLE "test"
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`

describe('parseCube', () => {
  it('валидный .cube 2×2×2', () => {
    const lut = parseCube(CUBE_2)!
    expect(lut.size).toBe(2)
    expect(lut.data.length).toBe(2 * 2 * 2 * 3)
    expect(Array.from(lut.data.slice(0, 3))).toEqual([0, 0, 0])
    expect(Array.from(lut.data.slice(21, 24))).toEqual([1, 1, 1])
  })

  it('нет LUT_3D_SIZE → null', () => {
    expect(parseCube('1 2 3\n4 5 6')).toBeNull()
  })

  it('обрезанные данные → null', () => {
    expect(parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1')).toBeNull()
  })

  it('мусорные значения → null', () => {
    expect(parseCube('LUT_3D_SIZE 2\n' + 'a b c\n'.repeat(8))).toBeNull()
  })
})

describe('identityLut', () => {
  it('identity: углы куба соответствуют цветам', () => {
    const lut = identityLut(4)
    expect(lut.size).toBe(4)
    expect(Array.from(lut.data.slice(0, 3))).toEqual([0, 0, 0])
    const last = lut.data.length - 3
    expect(Array.from(lut.data.slice(last))).toEqual([1, 1, 1])
  })
})

describe('makeLutTexture', () => {
  it('значения за [0,1] клампятся, а не заворачиваются в Uint8Array', () => {
    const lut = parseCube('LUT_3D_SIZE 2\n' + '-0.01 0 0\n'.repeat(7) + '1.01 1 1\n')!
    const tex = makeLutTexture(lut)
    const rgba = tex.image.data as Uint8Array
    expect(rgba[0]).toBe(0)              // не 253
    expect(rgba[(8 - 1) * 4]).toBe(255)  // не 2
  })
})
