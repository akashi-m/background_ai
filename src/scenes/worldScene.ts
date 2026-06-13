import * as THREE from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import type { WorldMeta } from '../app/worldMeta'
import { makeDepthPhotoMesh, fitCoverCm } from './depthPhoto'
import { loadAlignOverride } from '../debug/align'

// Мир, собранный из папки worlds/<имя>/.
// scene → dolly (анимируется въездом) → root (выравнивание из meta.transform).
export interface BuiltWorld {
  scene: THREE.Scene
  dolly: THREE.Group
  root: THREE.Group
  meta: WorldMeta
  name: string
  // Живая ручка силы 2.5D-объёма (только photo25d; для сплатов undefined)
  setDepthAmount?: (cm: number) => void
  depthAmountCm?: number
  // flat-миры: текстура плейта для фуллскрин-блита фона зеркала (без 3D-камеры)
  backplate?: THREE.Texture
  // физическая тень (Lux): лампы + камера + карта world-position для проекции теней
  shadowData?: {
    lamps: { pos: [number, number, number]; weight: number }[]
    camera: import('../lux/shadowGeom').ShadowCamera
    floorZ: number
    worldPos: THREE.Texture
  }
}

const DEPTH_KEY_PREFIX = 'stellar-mirror.depth.'

// Сохранённая оператором сила объёма перекрывает meta.json (как у выравнивания)
function loadDepthOverride(name: string): number | null {
  const v = Number(localStorage.getItem(DEPTH_KEY_PREFIX + name))
  return Number.isFinite(v) && v >= 0 && v <= 200 ? v : null
}

export function saveDepthOverride(name: string, cm: number): void {
  localStorage.setItem(DEPTH_KEY_PREFIX + name, String(cm))
}

export async function buildWorld(
  baseUrl: string, // '/assets/worlds/bedroom/'
  meta: WorldMeta,
  screenWcm: number,
  screenHcm: number,
  renderer: THREE.WebGLRenderer,
): Promise<BuiltWorld> {
  const scene = new THREE.Scene()
  const dolly = new THREE.Group()
  scene.add(dolly)
  const root = new THREE.Group()
  root.position.set(...meta.transform.position)
  root.rotation.y = (meta.transform.rotationYDeg * Math.PI) / 180
  root.scale.setScalar(meta.transform.scale)
  dolly.add(root)

  // Незакоммиченное выравнивание из localStorage перекрывает meta.json
  const name = baseUrl.split('/').filter(Boolean).pop()!
  const override = loadAlignOverride(name)
  if (override) {
    root.position.set(...override.position)
    root.rotation.y = (override.rotationYDeg * Math.PI) / 180
    root.scale.setScalar(override.scale)
    console.info(`мир «${name}»: применено выравнивание из localStorage — meta.json игнорируется (очистить: localStorage.removeItem('stellar-mirror.align.${name}'))`)
  }

  const built: BuiltWorld = { scene, dolly, root, meta, name }

  if (meta.format === 'splat') {
    const url = baseUrl + meta.file
    // SparkRenderer должен лежать в той сцене, которую рендерим
    scene.add(new SparkRenderer({ renderer }))
    const splat = new SplatMesh({ url })
    // Сплаты конвенционально Y-вниз (PLY/SPZ); переворачиваем в Y-вверх three.js.
    // Поворот мира вокруг Y из meta.transform применяется выше, на root.
    splat.quaternion.set(1, 0, 0, 0)
    root.add(splat)
    try {
      await splat.initialized
    } catch (e) {
      throw new Error(`Не загрузился ассет: ${url} (${e instanceof Error ? e.message : String(e)})`)
    }
  } else {
    // flat: плоский плейт-фон зеркала — плоскость в плоскости экрана (z=0),
    // без overscan и без 2.5D-смещения → фото показывается целиком, без кропа.
    const flat = meta.flat === true
    const zCm = flat ? 0 : -60
    const depthAmountCm = flat ? 0 : (loadDepthOverride(name) ?? meta.depthAmountCm ?? 60)
    const fit = fitCoverCm(meta.aspect!, zCm, screenWcm, screenHcm, flat ? 1.0 : 1.35)
    const mesh = await makeDepthPhotoMesh({
      photoUrl: baseUrl + meta.file,
      depthUrl: baseUrl + meta.depthFile!,
      widthCm: fit.widthCm,
      heightCm: fit.heightCm,
      zCm,
      depthAmountCm,
    })
    root.add(mesh)
    const mat = mesh.material as THREE.ShaderMaterial
    built.depthAmountCm = depthAmountCm
    built.setDepthAmount = (cm) => {
      mat.uniforms.uAmount.value = cm
      built.depthAmountCm = cm
    }
    // flat: фон рисуется фуллскрин-блитом (без 3D-камеры/глаза → без зума)
    if (flat) built.backplate = mat.uniforms.uMap.value as THREE.Texture

    // физическая тень (Lux): лампы/камера из lights.json + карта world-position (EXR)
    if (meta.shadow) {
      try {
        const res = await fetch(baseUrl + meta.shadow.lightsFile)
        if (!res.ok) throw new Error(`lights ${res.status}`)
        const lights = await res.json()
        const lamps = lights.lamps as { pos: [number, number, number]; weight: number }[]
        const wsum = lamps.reduce((s, l) => s + l.weight, 0) || 1
        lamps.forEach((l) => { l.weight = l.weight / wsum })
        const worldPos = await new EXRLoader().loadAsync(baseUrl + meta.shadow.worldPosFile)
        worldPos.minFilter = THREE.NearestFilter
        worldPos.magFilter = THREE.NearestFilter
        built.shadowData = {
          lamps,
          camera: lights.camera,
          floorZ: lights.floorZ,
          worldPos,
        }
      } catch (e) {
        console.warn(`мир «${name}»: shadowData не загружена (${e instanceof Error ? e.message : e}); тень-фолбэк`)
      }
    }
  }

  return built
}
