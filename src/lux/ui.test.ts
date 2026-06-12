import { describe, it, expect } from 'vitest'
import { interiorLabels } from './ui'

describe('interiorLabels', () => {
  it('строит подписи из заголовков миров', () => {
    expect(interiorLabels([{ title: 'Спальня' }, { title: 'Балкон' }]))
      .toEqual(['Спальня', 'Балкон'])
  })

  it('пустой заголовок → нумерованный фолбэк', () => {
    expect(interiorLabels([{ title: '' }, { title: 'Лофт' }]))
      .toEqual(['Интерьер 1', 'Лофт'])
  })
})
