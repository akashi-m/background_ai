import * as THREE from 'three'

// Кэш текстур: одна загрузка / одна GPU-текстура на URL (city.jpg нужна обеим сценам)
const cache = new Map<string, Promise<THREE.Texture>>()

export function loadTextureCached(url: string): Promise<THREE.Texture> {
  let p = cache.get(url)
  if (!p) {
    p = new THREE.TextureLoader().loadAsync(url).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace
      return t
    })
    cache.set(url, p)
    p.catch(() => cache.delete(url))
  }
  return p
}
