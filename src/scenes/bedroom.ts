import * as THREE from 'three'
import { SCENE_CONFIG } from './config'
import { loadTextureCached } from './textures'

// Процедурная спальня по референсу заказчика (images/bedroom.jpg):
// тёмный стиль, кровать у левой стены, галерея постеров, LED-подсветка,
// рабочий стол и ТВ у правой стены, окно со шторами на задней стене.
// Координаты в см: x вправо, y вверх (0 = центр), z вглубь комнаты (отрицательный).

const M = {
  wall: new THREE.MeshLambertMaterial({ color: 0xb3afaa }),
  ceiling: new THREE.MeshLambertMaterial({ color: 0x7d7a77 }),
  dark: new THREE.MeshLambertMaterial({ color: 0x26262b }),
  bedding: new THREE.MeshLambertMaterial({ color: 0x2e2e34 }),
  throwBlanket: new THREE.MeshLambertMaterial({ color: 0x4a4d55 }),
  mattress: new THREE.MeshLambertMaterial({ color: 0xcfccc6 }),
  pillowLight: new THREE.MeshLambertMaterial({ color: 0xb9b6b1 }),
  pillowDark: new THREE.MeshLambertMaterial({ color: 0x3a3a40 }),
  rug: new THREE.MeshLambertMaterial({ color: 0x5c5c61 }),
  curtain: new THREE.MeshLambertMaterial({ color: 0x17171b }),
  sheer: new THREE.MeshLambertMaterial({ color: 0xd8d6d2, transparent: true, opacity: 0.28 }),
  poster: new THREE.MeshLambertMaterial({ color: 0xc9c7c3 }),
  metal: new THREE.MeshLambertMaterial({ color: 0x3c3c42 }),
  plant: new THREE.MeshLambertMaterial({ color: 0x2c4a37 }),
  led: new THREE.MeshBasicMaterial({ color: 0xffe0b8 }), // светится сама — LED-лента
  tvScreen: new THREE.MeshBasicMaterial({ color: 0x1b2735 }),
  monitorScreen: new THREE.MeshBasicMaterial({ color: 0x2a3a52 }),
}

function box(
  scene: THREE.Scene, mat: THREE.Material,
  w: number, h: number, d: number,
  x: number, y: number, z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  m.position.set(x, y, z)
  scene.add(m)
  return m
}

// Светло-серая плитка с тёмными швами (как в референсе) — рисуем на канвасе
function makeTileFloorTexture(repeatX: number, repeatY: number): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')!
  g.fillStyle = '#9b9ba0'
  g.fillRect(0, 0, 256, 256)
  for (let i = 0; i < 400; i++) { // лёгкая каменная неоднородность
    const v = 120 + Math.random() * 45
    g.fillStyle = `rgba(${v}, ${v}, ${v + 6}, 0.06)`
    g.fillRect(Math.random() * 256, Math.random() * 256, 26, 26)
  }
  g.strokeStyle = '#6e6e73'
  g.lineWidth = 4
  g.strokeRect(0, 0, 256, 256) // шов по краю → при repeat получается сетка плитки
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(repeatX, repeatY)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

export async function buildBedroom(scene: THREE.Scene): Promise<void> {
  const { width: W, height: H, depth: D } = SCENE_CONFIG.room
  const halfW = W / 2, halfH = H / 2

  // --- Коробка комнаты (плитка 60×60 см) ---
  const floorMat = new THREE.MeshLambertMaterial({ map: makeTileFloorTexture(W / 60, D / 60) })
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat)
  floor.rotation.x = -Math.PI / 2
  floor.position.set(0, -halfH, -D / 2)
  scene.add(floor)

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), M.ceiling)
  ceiling.rotation.x = Math.PI / 2
  ceiling.position.set(0, halfH, -D / 2)
  scene.add(ceiling)

  const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), M.wall)
  back.position.set(0, 0, -D)
  scene.add(back)

  const left = new THREE.Mesh(new THREE.PlaneGeometry(D, H), M.wall)
  left.rotation.y = Math.PI / 2
  left.position.set(-halfW, 0, -D / 2)
  scene.add(left)

  const right = new THREE.Mesh(new THREE.PlaneGeometry(D, H), M.wall)
  right.rotation.y = -Math.PI / 2
  right.position.set(halfW, 0, -D / 2)
  scene.add(right)

  // --- Кровать у левой стены (изголовье к стене, 180×200) ---
  box(scene, M.dark, 204, 28, 184, -48, -121, -260)        // платформа
  box(scene, M.mattress, 196, 20, 176, -50, -97, -260)     // матрас
  box(scene, M.bedding, 160, 8, 174, -10, -83, -260)       // тёмное одеяло
  box(scene, M.throwBlanket, 50, 6, 176, 30, -79, -260)    // плед в ногах
  box(scene, M.dark, 6, 90, 210, -147, -60, -260)          // изголовье

  // Подушки: задний ряд тёмные, передний — светлые
  for (const z of [-300, -220]) box(scene, M.pillowDark, 18, 16, 48, -128, -76, z)
  for (const z of [-294, -226]) {
    const p = box(scene, M.pillowLight, 16, 14, 42, -112, -74, z)
    p.rotation.z = -0.12 // слегка прислонены к изголовью
  }

  // LED-лента за изголовьем + тёплая подсветка
  box(scene, M.led, 0.5, 4, 200, -149, -14, -260)
  const headboardGlow = new THREE.PointLight(0xffd9a0, 8000, 0, 2)
  headboardGlow.position.set(-138, -20, -260)
  scene.add(headboardGlow)

  // Тумбочка у изножья ряда (ближе к зеркалу)
  box(scene, M.dark, 40, 45, 38, -128, -112, -158)

  // --- Галерея постеров над кроватью (левая стена) ---
  const frames: [number, number, number, number][] = [ // z, y, ширина, высота
    [-190, 70, 38, 50], [-235, 75, 30, 40], [-275, 65, 36, 52],
    [-195, 14, 30, 42], [-240, 20, 36, 46], [-282, 8, 30, 40],
  ]
  for (const [z, y, w, h] of frames) {
    box(scene, M.dark, 1.5, h, w, -149, y, z)
    box(scene, M.poster, 0.6, h - 8, w - 8, -148.2, y, z)
  }

  // --- Ковёр под кроватью ---
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(230, 250), M.rug)
  rug.rotation.x = -Math.PI / 2
  rug.position.set(-10, -halfH + 0.6, -265)
  scene.add(rug)

  // --- Окно на задней стене: фото города + шторы ---
  const cityTex = await loadTextureCached(SCENE_CONFIG.cityView.url)
  const view = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 160), // аспект фото 736×981 = 0.75
    new THREE.MeshBasicMaterial({ map: cityTex })
  )
  view.position.set(20, 5, -D + 1)
  scene.add(view)
  const sheer = new THREE.Mesh(new THREE.PlaneGeometry(120, 200), M.sheer)
  sheer.position.set(20, -5, -D + 6)
  scene.add(sheer)
  box(scene, M.curtain, 40, 240, 8, -60, -10, -D + 8)  // тёмная штора слева
  box(scene, M.curtain, 40, 240, 8, 100, -10, -D + 8)  // тёмная штора справа

  // Холодный свет из окна
  const windowGlow = new THREE.PointLight(0xa9bdd9, 15000, 0, 2)
  windowGlow.position.set(20, 10, -D + 50)
  scene.add(windowGlow)

  // --- Рабочий стол у правой стены (у окна) ---
  box(scene, M.dark, 60, 4, 140, 120, -60, -380)       // столешница
  box(scene, M.dark, 58, 73, 4, 120, -98, -314)        // боковина
  box(scene, M.dark, 58, 73, 4, 120, -98, -446)        // боковина
  box(scene, M.metal, 2, 35, 55, 132, -33, -380)       // монитор
  box(scene, M.monitorScreen, 0.6, 30, 50, 130.6, -33, -380)
  // Кресло
  box(scene, M.dark, 46, 8, 46, 72, -86, -380)
  box(scene, M.dark, 6, 52, 46, 50, -58, -380)
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 30, 12), M.metal)
  pole.position.set(72, -105, -380)
  scene.add(pole)
  const base = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 3, 16), M.metal)
  base.position.set(72, -122, -380)
  scene.add(base)

  // --- ТВ-зона у правой стены (ближе к зеркалу) ---
  box(scene, M.dark, 50, 45, 160, 124, -112, -150)     // консоль
  box(scene, M.metal, 3, 60, 105, 146, -40, -150)      // ТВ
  box(scene, M.tvScreen, 0.6, 52, 95, 144.2, -40, -150)

  // --- Растение в левом ближнем углу ---
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(13, 10, 24, 16), M.dark)
  pot.position.set(-126, -123, -55)
  scene.add(pot)
  for (const [dx, dy, dz, s] of [[0, 0, 0, 18], [-8, -10, 6, 12], [9, -12, -5, 11]] as const) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(s, 8, 6), M.plant)
    leaf.scale.set(1, 1.5, 1)
    leaf.position.set(-126 + dx, -90 + dy, -55 + dz)
    scene.add(leaf)
  }

  // --- Карнизная LED-подсветка по периметру потолка ---
  box(scene, M.led, W - 6, 2, 3, 0, halfH - 4, -8)
  box(scene, M.led, W - 6, 2, 3, 0, halfH - 4, -D + 8)
  box(scene, M.led, 3, 2, D - 6, -halfW + 3, halfH - 4, -D / 2)
  box(scene, M.led, 3, 2, D - 6, halfW - 3, halfH - 4, -D / 2)

  // --- Свет: тёплый вечерний, как в референсе ---
  scene.add(new THREE.AmbientLight(0xffffff, 0.3))
  for (const z of [-140, -340]) {
    const warm = new THREE.PointLight(0xffe2bb, 25000, 0, 2)
    warm.position.set(0, halfH - 17, z)
    scene.add(warm)
  }
  const coolFill = new THREE.DirectionalLight(0xdfe6f0, 0.3)
  coolFill.position.set(20, 60, -400) // холодный подсвет со стороны окна
  scene.add(coolFill)
}
