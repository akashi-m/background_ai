// Dev-панель реал-тайм тюна пост-обработки (слайдеры → look активного мира).
// Тоггл по клавише в main; в проде скрыта (видна только по тогглу). НЕ часть рендер-контракта.

// slider key → look dotted path
const SLIDER_LOOK_PATH: Record<string, string> = {
  wrapStrength:   'grade.wrapStrength',
  erode:          'matte.erode',
  grainAmount:    'unify.grain',
  bloom:          'unify.bloom',
  bloomThreshold: 'unify.bloomThreshold',
  contrast:       'grade.contrast',
  temp:           'grade.temp',
  shade:          'grade.shade',
  gain:           'grade.gain',
  cast:           'grade.colorMatch.cast',
  exposure:       'grade.colorMatch.exposure',
}

export interface SliderSpec {
  key: string // ключ слайдера; маппится в look-путь через SLIDER_LOOK_PATH
  label: string
  min: number
  max: number
  step: number
  value: number // стартовое
}

export interface DevPanel {
  toggle: () => void
  visible: () => boolean
  /** Перезаполнить слайдеры из нового набора значений (при смене мира). */
  reseed: (values: Record<string, number>) => void
}

// Создаёт DOM-панель со слайдерами.
// setLookValue(lookPath, value) вызывается при изменении слайдера.
// onSave() вызывается по кнопке «Save look.json».
export function createDevPanel(
  specs: SliderSpec[],
  setLookValue: (path: string, value: number) => void,
  onSave: () => void,
): DevPanel {
  const cur: Record<string, number> = {}

  const panel = document.createElement('div')
  panel.id = 'dev-panel'
  Object.assign(panel.style, {
    position: 'fixed', top: '12px', right: '12px', zIndex: '20',
    width: '230px', maxHeight: '90vh', overflowY: 'auto',
    padding: '12px 14px', borderRadius: '10px',
    background: 'rgba(12, 12, 14, 0.86)', backdropFilter: 'blur(8px)',
    border: '1px solid rgba(255,255,255,0.12)',
    font: '11px/1.5 ui-monospace, monospace', color: '#e8e8ea',
    display: 'none', pointerEvents: 'auto', userSelect: 'none',
  })

  const title = document.createElement('div')
  title.textContent = 'LOOK (G — скрыть)'
  Object.assign(title.style, { fontWeight: '700', letterSpacing: '0.08em', marginBottom: '8px', opacity: '0.7' })
  panel.appendChild(title)

  // элементы для reseed: key → { val, range, dec }
  type SliderEl = { val: HTMLSpanElement; range: HTMLInputElement; dec: number }
  const sliderEls: Record<string, SliderEl> = {}

  for (const s of specs) {
    cur[s.key] = s.value
    const row = document.createElement('label')
    Object.assign(row.style, { display: 'block', margin: '7px 0' })

    const head = document.createElement('div')
    Object.assign(head.style, { display: 'flex', justifyContent: 'space-between', marginBottom: '2px' })
    const name = document.createElement('span'); name.textContent = s.label; name.style.opacity = '0.85'
    const val = document.createElement('span'); val.style.color = '#d9b878'
    const dec = s.step < 0.01 ? 4 : s.step < 0.1 ? 3 : 2
    val.textContent = s.value.toFixed(dec)
    head.append(name, val)

    const range = document.createElement('input')
    range.type = 'range'
    range.min = String(s.min); range.max = String(s.max); range.step = String(s.step)
    range.value = String(s.value)
    Object.assign(range.style, { width: '100%', accentColor: '#d9b878', cursor: 'pointer' })
    range.addEventListener('input', () => {
      const v = Number(range.value)
      cur[s.key] = v
      val.textContent = v.toFixed(dec)
      const lookPath = SLIDER_LOOK_PATH[s.key] ?? s.key
      setLookValue(lookPath, v)
    })

    sliderEls[s.key] = { val, range, dec }
    row.append(head, range)
    panel.appendChild(row)
  }

  const copy = document.createElement('button')
  copy.textContent = 'Copy values'
  Object.assign(copy.style, {
    marginTop: '10px', width: '100%', padding: '6px', cursor: 'pointer',
    background: 'rgba(217,184,120,0.16)', color: '#d9b878',
    border: '1px solid rgba(217,184,120,0.5)', borderRadius: '6px',
    font: 'inherit',
  })
  copy.addEventListener('click', () => {
    const snippet = specs.map((s) => `  ${s.key}: ${cur[s.key]},`).join('\n')
    void navigator.clipboard?.writeText(snippet)
    copy.textContent = 'Copied ✓'
    setTimeout(() => { copy.textContent = 'Copy values' }, 1200)
  })
  panel.appendChild(copy)

  const save = document.createElement('button')
  save.textContent = 'Save look.json'
  Object.assign(save.style, {
    marginTop: '6px', width: '100%', padding: '6px', cursor: 'pointer',
    background: 'rgba(120,200,120,0.16)', color: '#7acc7a',
    border: '1px solid rgba(120,200,120,0.5)', borderRadius: '6px',
    font: 'inherit',
  })
  save.addEventListener('click', () => {
    onSave()
    save.textContent = 'Saved ✓'
    setTimeout(() => { save.textContent = 'Save look.json' }, 1500)
  })
  panel.appendChild(save)

  document.body.appendChild(panel)

  return {
    toggle: () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none' },
    visible: () => panel.style.display !== 'none',
    reseed: (values: Record<string, number>) => {
      for (const s of specs) {
        const v = values[s.key]
        if (v === undefined) continue
        cur[s.key] = v
        const el = sliderEls[s.key]
        if (!el) continue
        el.range.value = String(v)
        el.val.textContent = v.toFixed(el.dec)
      }
    },
  }
}
