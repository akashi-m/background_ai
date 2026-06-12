// Парсер .cube (Adobe/Resolve 3D LUT) и identity-фолбэк (спека §3, §8).
// Битый файл → null; вызывающий подставляет identity и пишет console.warn.

import * as THREE from 'three'

export interface ParsedLut {
  size: number
  data: Float32Array // r,g,b подряд, red быстрее всех (стандарт .cube)
}

export function parseCube(text: string): ParsedLut | null {
  let size = 0
  const values: number[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const mSize = /^LUT_3D_SIZE\s+(\d+)$/i.exec(line)
    if (mSize) {
      size = Number(mSize[1])
      continue
    }
    if (/^[A-Z_]/i.test(line)) continue // TITLE, DOMAIN_MIN и прочие ключи
    const parts = line.split(/\s+/).map(Number)
    if (parts.length === 3 && parts.every((v) => isFinite(v))) {
      values.push(...parts)
    } else {
      return null
    }
  }
  if (size < 2 || values.length !== size * size * size * 3) return null
  return { size, data: new Float32Array(values) }
}

export function identityLut(size = 16): ParsedLut {
  const data = new Float32Array(size * size * size * 3)
  let i = 0
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        data[i++] = r / (size - 1)
        data[i++] = g / (size - 1)
        data[i++] = b / (size - 1)
      }
  return { size, data }
}

export function makeLutTexture(lut: ParsedLut): THREE.Data3DTexture {
  const n = lut.size
  const rgba = new Uint8Array(n * n * n * 4)
  for (let i = 0, j = 0; i < lut.data.length; i += 3, j += 4) {
    rgba[j] = Math.round(lut.data[i] * 255)
    rgba[j + 1] = Math.round(lut.data[i + 1] * 255)
    rgba[j + 2] = Math.round(lut.data[i + 2] * 255)
    rgba[j + 3] = 255
  }
  const tex = new THREE.Data3DTexture(rgba, n, n, n)
  tex.format = THREE.RGBAFormat
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

/** Загрузка LUT мира: нет файла/битый → identity + warn. */
export async function loadLutTexture(url: string | null): Promise<THREE.Data3DTexture> {
  if (url) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const parsed = parseCube(await res.text())
        if (parsed) return makeLutTexture(parsed)
      }
      console.warn(`битый или недоступный LUT ${url} — использую identity`)
    } catch {
      console.warn(`не удалось загрузить LUT ${url} — использую identity`)
    }
  }
  return makeLutTexture(identityLut())
}
