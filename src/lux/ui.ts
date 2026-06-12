// UI-оверлей зеркала: кнопки интерьеров из миров, opacity-синхронизация
// с mirrorOpacity (UI «проявляется» вместе с зеркалом, спека №3 §3).

export function interiorLabels(metas: { title: string }[]): string[] {
  return metas.map((m, i) => m.title || `Интерьер ${i + 1}`)
}

export class LuxUI {
  private idleEls: HTMLElement[]
  private mirrorEls: HTMLElement[]
  private buttons: HTMLButtonElement[] = []

  constructor(private onInterior: (index: number) => void) {
    this.idleEls = Array.from(document.querySelectorAll<HTMLElement>('[data-idle]'))
    this.mirrorEls = Array.from(document.querySelectorAll<HTMLElement>('[data-mirror]'))
  }

  setWorlds(titles: string[]): void {
    const nav = document.getElementById('lux-interiors')
    if (!nav) return
    nav.innerHTML = ''
    this.buttons = titles.map((title, i) => {
      const b = document.createElement('button')
      b.className = 'lux-btn'
      b.textContent = title
      b.addEventListener('click', () => this.onInterior(i))
      nav.appendChild(b)
      return b
    })
  }

  setActive(index: number): void {
    this.buttons.forEach((b, i) => b.classList.toggle('active', i === index))
  }

  /** Звать каждый кадр: 0 = IDLE-вид, 1 = MIRROR-вид. */
  update(mirrorOpacity: number): void {
    const mo = String(mirrorOpacity)
    const io = String(1 - mirrorOpacity)
    for (const el of this.mirrorEls) {
      el.style.opacity = mo
      el.style.pointerEvents = mirrorOpacity > 0.5 ? 'auto' : 'none'
    }
    for (const el of this.idleEls) el.style.opacity = io
  }
}
