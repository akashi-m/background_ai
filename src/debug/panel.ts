import type { EyeCm } from '../render/offAxis'
import { type Calibration, saveCalibration } from '../app/calibration'

// D — статистика, C — калибровка. Прототип: без фреймворков, голый DOM.
export class DebugPanel {
  private stats = document.createElement('pre')
  private form = document.createElement('div')
  private renderFrames = 0
  private renderFps = 0
  private windowStart = performance.now()

  constructor(private calibration: Calibration, private onCalibrationChange: () => void) {
    this.stats.style.cssText =
      'position:fixed;top:8px;left:8px;color:#0f0;font:12px monospace;z-index:10;' +
      'background:rgba(0,0,0,.5);padding:6px;display:none'
    document.body.appendChild(this.stats)

    this.form.style.cssText =
      'position:fixed;top:8px;right:8px;color:#fff;font:13px system-ui;z-index:10;' +
      'background:rgba(0,0,0,.8);padding:12px;border-radius:8px;display:none'
    this.buildForm()
    document.body.appendChild(this.form)

    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'KeyD') this.stats.style.display = this.stats.style.display === 'none' ? 'block' : 'none'
      if (e.code === 'KeyC') this.form.style.display = this.form.style.display === 'none' ? 'block' : 'none'
    })
  }

  private buildForm(): void {
    const fields: [keyof Calibration, string][] = [
      ['screenWcm', 'Ширина экрана, см'],
      ['screenHcm', 'Высота экрана, см'],
      ['camOffsetXcm', 'Камера: смещение X, см'],
      ['camOffsetYcm', 'Камера: смещение Y, см'],
      ['webcamHfovDeg', 'FOV вебки, °'],
    ]
    this.form.innerHTML = '<b>Калибровка</b><br>'
    for (const [key, label] of fields) {
      const row = document.createElement('label')
      row.style.cssText = 'display:block;margin:6px 0'
      row.textContent = label + ' '
      const input = document.createElement('input')
      input.type = 'number'
      input.step = '0.1'
      input.value = String(this.calibration[key])
      input.style.width = '70px'
      input.onchange = () => {
        const v = Number(input.value)
        const mustBePositive = key === 'screenWcm' || key === 'screenHcm' || key === 'webcamHfovDeg'
        if (!Number.isFinite(v) || (mustBePositive && v <= 0)) {
          input.value = String(this.calibration[key]) // откат: пустое/мусорное значение не коммитим
          return
        }
        this.calibration[key] = v
        saveCalibration(this.calibration)
        this.onCalibrationChange()
      }
      row.appendChild(input)
      this.form.appendChild(row)
    }
  }

  // Зовётся каждый кадр рендера
  frame(eye: EyeCm, faceVisible: boolean, segFps: number, videoLagMs: number): void {
    this.renderFrames++
    const now = performance.now()
    if (now - this.windowStart > 1000) {
      this.renderFps = this.renderFrames
      this.renderFrames = 0
      this.windowStart = now
    }
    if (this.stats.style.display !== 'none') {
      this.stats.textContent =
        `render: ${this.renderFps} fps\n` +
        `сегментация: ${segFps === 0 ? 'выкл' : `${segFps} fps`}\n` +
        `возраст кадра камеры: ~${videoLagMs.toFixed(0)} мс\n` +
        `eye: x=${eye.x.toFixed(1)} y=${eye.y.toFixed(1)} z=${eye.z.toFixed(1)} см\n` +
        `лицо: ${faceVisible ? 'да' : 'нет'}\n` +
        `клавиши: 1..9 мир, W/M след./пред., A выравнивание, C калибровка`
    }
  }
}
