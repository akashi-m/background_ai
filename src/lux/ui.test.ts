import { describe, it, expect } from 'vitest'
import { styleButtonSpecs } from './ui'
import type { StyleDef } from '../scenes/config'

const STYLES: StyleDef[] = [
  { key: 'light', label: 'LIGHT', world: 'lobby' },
  { key: 'modern', label: 'MODERN', world: null },
  { key: 'classic', label: 'CLASSIC', world: null },
  { key: 'ferre', label: 'FERRÉ', world: null },
]

describe('styleButtonSpecs', () => {
  it('light → индекс мира lobby; пустышки (world null) → worldIndex null', () => {
    expect(styleButtonSpecs(STYLES, ['lobby'])).toEqual([
      { label: 'LIGHT', worldIndex: 0 },
      { label: 'MODERN', worldIndex: null },
      { label: 'CLASSIC', worldIndex: null },
      { label: 'FERRÉ', worldIndex: null },
    ])
  })

  it('стиль ссылается на незагруженный мир → пустышка (null), не падает', () => {
    expect(styleButtonSpecs([{ key: 'x', label: 'X', world: 'missing' }], ['lobby'])[0].worldIndex)
      .toBeNull()
  })

  it('маппинг к правильному индексу среди нескольких миров', () => {
    expect(styleButtonSpecs([{ key: 'a', label: 'A', world: 'b' }], ['a', 'b', 'c'])[0].worldIndex)
      .toBe(1)
  })
})
