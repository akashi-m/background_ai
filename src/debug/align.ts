import type { BuiltWorld } from '../scenes/worldScene'
import type { WorldTransform } from '../app/worldMeta'

// Выравнивание сгенерённого мира: клавиша A — вкл/выкл режим, затем
// стрелки — сдвиг X/Z, PgUp/PgDn — Y, [ ] — поворот, - = — масштаб.
// Каждое изменение пишется в localStorage и печатается готовым JSON
// для вставки в meta.json (выровнял один раз — мир готов).
const KEY_PREFIX = 'stellar-mirror.align.'

export function loadAlignOverride(worldName: string): WorldTransform | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + worldName)
    return raw ? (JSON.parse(raw) as WorldTransform) : null
  } catch {
    return null
  }
}

export class AlignController {
  private active = false
  private hint = document.createElement('div')

  constructor(private getWorld: () => BuiltWorld, private getWorldName: () => string) {
    this.hint.style.cssText =
      'position:fixed;bottom:8px;left:8px;color:#ff0;font:12px monospace;z-index:10;' +
      'background:rgba(0,0,0,.6);padding:6px;display:none;white-space:pre'
    document.body.appendChild(this.hint)

    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'KeyA') {
        this.active = !this.active
        this.hint.style.display = this.active ? 'block' : 'none'
        if (this.active) this.refresh()
        return
      }
      if (!this.active) return

      const root = this.getWorld().root
      const stepCm = e.shiftKey ? 10 : 1
      const stepDeg = e.shiftKey ? 10 : 1
      const stepScale = e.shiftKey ? 1.25 : 1.02
      switch (e.code) {
        case 'ArrowLeft': root.position.x -= stepCm; break
        case 'ArrowRight': root.position.x += stepCm; break
        case 'ArrowUp': root.position.z -= stepCm; break
        case 'ArrowDown': root.position.z += stepCm; break
        case 'PageUp': root.position.y += stepCm; break
        case 'PageDown': root.position.y -= stepCm; break
        case 'BracketLeft': root.rotation.y -= (stepDeg * Math.PI) / 180; break
        case 'BracketRight': root.rotation.y += (stepDeg * Math.PI) / 180; break
        case 'Minus': root.scale.multiplyScalar(1 / stepScale); break
        case 'Equal': root.scale.multiplyScalar(stepScale); break
        default: return
      }
      e.preventDefault()
      this.save()
      this.refresh()
    })
  }

  private currentTransform(): WorldTransform {
    const root = this.getWorld().root
    return {
      position: [
        Math.round(root.position.x * 10) / 10,
        Math.round(root.position.y * 10) / 10,
        Math.round(root.position.z * 10) / 10,
      ],
      rotationYDeg: Math.round((root.rotation.y * 180) / Math.PI * 10) / 10,
      scale: Math.round(root.scale.x * 1000) / 1000,
    }
  }

  private save(): void {
    const t = this.currentTransform()
    localStorage.setItem(KEY_PREFIX + this.getWorldName(), JSON.stringify(t))
    console.log(`meta.json «${this.getWorldName()}» → "transform": ${JSON.stringify(t)}`)
  }

  private refresh(): void {
    const t = this.currentTransform()
    this.hint.textContent =
      `ВЫРАВНИВАНИЕ «${this.getWorldName()}» (A — выйти)\n` +
      `стрелки X/Z, PgUp/PgDn Y, [ ] поворот, - = масштаб, Shift — крупный шаг\n` +
      `transform: ${JSON.stringify(t)}`
  }
}
