// 3D-сцена physical-тени (spec §4): невидимый прокси-кастер + box/EXR-приёмник,
// лампы PointLight (castShadow только Key), камера запечена из lights.json.
// Рендерится в shadowRT, multiply-blit на compositeRT (compositor.ts).
// Базис: Blender Z-up во всей сцене (камера up=(0,0,1)); без координатного свопа.
import * as THREE from 'three'
import type { ShadowCamera } from './shadowGeom'
import { proxyCapsuleTransforms } from './shadowGeom'

// Box задаётся axis-aligned min/max в Blender Z-up мировых координатах.
export interface ReceiverBox { min: [number, number, number]; max: [number, number, number] }

// B1-приёмник (alignment-этап + fallback-пол): плоскость пола + box-прокси мебели.
// Материал ShadowMaterial: всюду прозрачен, рисует только тень-терм; receiveShadow.
export function boxReceiver(floorZ: number, boxes: ReceiverBox[]): THREE.Mesh[] {
  const mkMat = () => new THREE.ShadowMaterial({ color: 0x000000, transparent: true, opacity: 1 })

  // Пол: большая плоскость в Z=floorZ (Blender Z-up — плоскость в XY, нормаль +Z).
  const floorGeom = new THREE.PlaneGeometry(100, 100)
  const floor = new THREE.Mesh(floorGeom, mkMat())
  floor.position.set(0, 0, floorZ)
  floor.receiveShadow = true
  floor.castShadow = false

  const meshes: THREE.Mesh[] = [floor]
  for (const b of boxes) {
    const sx = b.max[0] - b.min[0]
    const sy = b.max[1] - b.min[1]
    const sz = b.max[2] - b.min[2]
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mkMat())
    mesh.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2)
    mesh.scale.set(sx, sy, sz)
    mesh.receiveShadow = true
    mesh.castShadow = false
    meshes.push(mesh)
  }
  return meshes
}

// Статический тест-кастер B1: невидимый «столбик» (капсула) высотой H в точке F.
// Не pose-driven (полноценный ProxyRig — Phase C). Нужен для alignment-проверки
// (тень совпадает с плейтом). Невидимость каста: colorWrite=false, depthWrite=false,
// visible=true (r180: visible=false выкинул бы из shadow-pass — spec §4.2). castShadow=true.
// Базис Z-up: прокси стоит вдоль +Z; корень в RAW F (без свопа).
export function staticProxy(F: [number, number, number], H: number): THREE.Group {
  const group = new THREE.Group()
  const mat = new THREE.MeshBasicMaterial()
  mat.colorWrite = false
  mat.depthWrite = false

  const radius = 0.12
  const cylLen = Math.max(0.01, H - 2 * radius)
  const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(radius, cylLen, 4, 8), mat)
  capsule.castShadow = true
  capsule.receiveShadow = false
  capsule.visible = true
  // CapsuleGeometry ось = локальный Y; в Z-up столбик должен идти вдоль +Z → rotateX(+90°).
  capsule.rotation.x = Math.PI / 2
  // центр капсулы на половине высоты над основанием группы (вдоль +Z)
  capsule.position.set(0, 0, H / 2)
  group.add(capsule)

  group.position.set(F[0], F[1], F[2]) // RAW Blender Z-up, без свопа
  return group
}

// Per-segment радиусы капсул (метры, pose-метрика; масштабируются вместе с _root).
const PROXY_RADII: Record<string, number> = {
  torso: 0.12,
  upperarm_L: 0.05, upperarm_R: 0.05, forearm_L: 0.045, forearm_R: 0.045,
  leg: 0.13, // единая центральная нога (hipMid→ankleMid) вместо двух — без «/\»-базы
  neck: 0.07, // короткий пенёк над плечами; головы нет (юзер: убрать всё выше шеи)
}

// Невидимый капсульный прокси, управляемый позой (§4.2). Пул мешей по сегментам,
// переиспользуется каждый кадр. Невидим в цвет/глубину (colorWrite/depthWrite=false),
// но castShadow=true + visible=true → попадает в shadow-pass (r180: visible=false выкинул бы).
export class ProxyRig {
  private _root = new THREE.Group()
  private _capsules = new Map<string, THREE.Mesh>()
  private _mat: THREE.MeshBasicMaterial
  private _q = new THREE.Quaternion()
  private _contact: THREE.Mesh // плоский диск-лужа у ступней (всегда видим)

  constructor() {
    this._mat = new THREE.MeshBasicMaterial()
    this._mat.colorWrite = false
    this._mat.depthWrite = false
    for (const [name, radius] of Object.entries(PROXY_RADII)) {
      // CapsuleGeometry ось = Y, цилиндр высотой 1 → масштаб Y до длины сегмента в update.
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, 1, 4, 8), this._mat)
      mesh.castShadow = true
      mesh.receiveShadow = false
      mesh.visible = false
      this._capsules.set(name, mesh)
      this._root.add(mesh)
    }
    // Контактная лужа: плоский широкий эллипсоид у ступней → низ тени = мягкий полукруг,
    // плавно сливается с блобом (юзер). НЕ в _capsules → hide-loop позы её не трогает.
    this._contact = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), this._mat)
    this._contact.castShadow = true
    this._contact.receiveShadow = false
    this._contact.scale.set(0.22, 0.22, 0.05) // широкий, плоский
    this._contact.position.set(0, 0, 0.05)
    this._root.add(this._contact)
  }

  get object(): THREE.Group { return this._root }

  // Привод прокси от живой позы (§4.2 + ремап осей). MediaPipe world: x-вправо, y-ВНИЗ,
  // z-к камере (hip-origin). Камера сцены смотрит вдоль +X → scene-X = ГЛУБИНА, scene-Y =
  // горизонталь экрана. Поэтому глубина позы (mp_z) → scene-X, лево-право (mp_x) → scene-Y,
  // вертикаль (−mp_y) → scene-Z. Ремап [z, x, -y]: человек боком даёт узкий профиль (а не
  // фронтальный широкий силуэт). Затем якорь ступней на 0 + скейл к росту H.
  update(poseWorld: number[][], F: THREE.Vector3, H: number): void {
    // 1) ремап осей в Z-up + сбор вертикального экстента видимых суставов
    const mapped: number[][] = poseWorld.map((lm) =>
      lm && lm.length >= 4 ? [lm[2], lm[0], -lm[1], lm[3]] : [0, 0, 0, 0])
    let minZ = Infinity
    let maxZ = -Infinity
    for (const lm of mapped) {
      if ((lm[3] ?? 0) < 0.5) continue
      if (lm[2] < minZ) minZ = lm[2]
      if (lm[2] > maxZ) maxZ = lm[2]
    }
    const hasVis = isFinite(minZ)
    // 2) якорь: нижняя точка (ступни) → 0 (на уровень root=F)
    if (hasVis) for (const lm of mapped) lm[2] -= minZ
    // 3) скейл к росту H по вертикальному размаху позы
    const height = hasVis ? maxZ - minZ : 0
    const s = height > 1e-3 ? H / height : 1
    this._root.position.copy(F)
    // общий множитель размера тени (юзер: −10%, −10%, затем +10% → 0.81·1.1 ≈ 0.89);
    // высота = 0.8·(ширина) сохраняется. (z/y = 0.8 инвариантно к k — тест C.5 держится.)
    const k = 0.89
    this._root.scale.set(s * k, s * k, s * 0.8 * k)

    const xfs = proxyCapsuleTransforms(mapped)
    const used = new Set<string>()
    for (const xf of xfs) {
      const mesh = this._capsules.get(xf.name)
      if (!mesh) continue
      mesh.position.set(xf.center[0], xf.center[1], xf.center[2])
      this._q.set(xf.quat[0], xf.quat[1], xf.quat[2], xf.quat[3])
      mesh.quaternion.copy(this._q)
      mesh.scale.set(1, Math.max(1e-3, xf.length), 1) // все сегменты — капсулы (головы нет)
      mesh.visible = true
      used.add(xf.name)
    }
    for (const [name, mesh] of this._capsules) {
      if (!used.has(name)) mesh.visible = false
    }
  }
}

export interface Lamp { pos: [number, number, number]; weight: number }

// Лампы → PointLight. castShadow ТОЛЬКО у Key (max weight): PointLight cube-shadow
// дорог (6 граней) — fill-лампы вносят вклад только интенсивностью (spec §4.3).
// Позиции RAW Blender Z-up (вся сцена Z-up, без свопа).
export function keyPointLights(lamps: Lamp[]): THREE.PointLight[] {
  let keyIdx = 0
  for (let i = 1; i < lamps.length; i++) if (lamps[i].weight > lamps[keyIdx].weight) keyIdx = i

  return lamps.map((lamp, i) => {
    const light = new THREE.PointLight(0xffffff, lamp.weight)
    light.position.set(lamp.pos[0], lamp.pos[1], lamp.pos[2]) // RAW Z-up
    light.decay = 0 // запечённые позиции — без физ-затухания (как v1: вес = вклад)
    if (i === keyIdx) {
      light.castShadow = true
      light.shadow.mapSize.set(2048, 2048)
      light.shadow.bias = -0.0005
      light.shadow.normalBias = 0.03
      light.shadow.radius = 8 // PCFSoft: мягкая кромка shadow-map (диффузный контур)
    }
    return light
  })
}

// Запечённая камера тени = ровно Blender-камера плейта (lights.json.camera).
// Базис: Blender Z-up во всей сцене → camera.up=(0,0,1), БЕЗ свопа координат
// (приёмник boxReceiver/EXR-mesh тоже в Z-up). matrixAutoUpdate=false: мировую
// матрицу собираем вручную (lookAt в Z-up), чтобы тень проецировалась в те же
// пиксели, что геометрия на плоском плейте (spec §4.3, reconcile §B.9).
export function bakedShadowCamera(cam: ShadowCamera): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(cam.fovY), cam.aspect, 0.05, 100)
  c.matrixAutoUpdate = false
  const eye = new THREE.Vector3(cam.pos[0], cam.pos[1], cam.pos[2])
  const tgt = new THREE.Vector3(cam.target[0], cam.target[1], cam.target[2])
  // lookAt строит ориентацию; up = Blender world-up = (0,0,1) (камера не закручена)
  const m = new THREE.Matrix4().lookAt(eye, tgt, new THREE.Vector3(0, 0, 1))
  m.setPosition(eye)
  c.matrix.copy(m)
  c.matrixWorld.copy(m)          // нет родителя → world = local
  c.matrixWorldNeedsUpdate = false
  c.updateProjectionMatrix()
  return c
}

// Подмножество BuiltWorld['shadowData'], нужное ShadowScene3D. worldPos/worldPosData
// опциональны: B1 box-приёмнику не нужны, B2 EXR-приёмник их использует.
export interface ShadowData {
  lamps: Lamp[]
  camera: ShadowCamera
  floorZ: number
  boxes?: ReceiverBox[]
  worldPos?: THREE.Texture
  worldPosData?: { data: Float32Array; width: number; height: number }
}

export class ShadowScene3D {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  caster!: THREE.Object3D
  // C: pose-driven прокси (строится в ctor, в сцену НЕ добавляется здесь — становится
  // кастером, когда compositor зовёт setCaster(proxyRig.object) при наличии позы).
  proxyRig = new ProxyRig()
  private receiverGroup = new THREE.Group()
  private casterGroup = new THREE.Group()

  constructor(shadowData: ShadowData, _renderer: THREE.WebGLRenderer) {
    this.scene = new THREE.Scene()
    this.camera = bakedShadowCamera(shadowData.camera)
    for (const light of keyPointLights(shadowData.lamps)) this.scene.add(light)
    this.scene.add(this.receiverGroup)
    this.setReceiver(boxReceiver(shadowData.floorZ, shadowData.boxes ?? []))
    this.scene.add(this.casterGroup)
    // B1: статический тест-кастер (столбик в центре пола, рост 1.7); Phase C → setCaster(proxyRig.object)
    this.setCaster(staticProxy([0, 0, shadowData.floorZ], 1.7))
  }

  // Замена приёмника (B2: box → EXR-mesh).
  setReceiver(meshes: THREE.Object3D[]): void {
    this.receiverGroup.clear()
    for (const m of meshes) this.receiverGroup.add(m)
  }

  // Замена кастера (Phase C: staticProxy → ProxyRig.object).
  setCaster(obj: THREE.Object3D): void {
    this.casterGroup.clear()
    this.caster = obj
    this.casterGroup.add(obj)
  }

  // B1: no-op (прокси статический). Phase C: proxyRig.update(pose.world, F, H) + ShadowMaterial.opacity=shadowStrength.
  // 4-арг канон (§A.2): shadowStrength опционален (дефолт 1) → 3-арг вызовы C.6 компилируются, D передаёт силу.
  update(
    _pose: { world: number[][]; norm: number[][]; healthy: number } | null,
    _personFloor: { F: THREE.Vector3; H: number },
    _shadowData: ShadowData,
    _shadowStrength = 1,
  ): void {
    // pose-drive — Phase C
  }
}
