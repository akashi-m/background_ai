import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { SCENE_CONFIG } from './config'

// Процедурная «жилая комната»: пол, стены, окно с видом, мебель-болванки.
// Качество — уровня прототипа: проверяем параллакс, не архвиз.
export async function buildMirrorScene(): Promise<THREE.Scene> {
  const scene = new THREE.Scene()
  const { width: W, height: H, depth: D } = SCENE_CONFIG.room

  if (SCENE_CONFIG.interiorGltfUrl) {
    const gltf = await new GLTFLoader().loadAsync(SCENE_CONFIG.interiorGltfUrl)
    scene.add(gltf.scene)
  } else {
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xe8e0d4 })
    const floorMat = new THREE.MeshLambertMaterial({ color: 0x9c7b5a })

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat)
    floor.rotation.x = -Math.PI / 2
    floor.position.set(0, -H / 2, -D / 2)
    scene.add(floor)

    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), wallMat.clone())
    ceiling.rotation.x = Math.PI / 2
    ceiling.position.set(0, H / 2, -D / 2)
    scene.add(ceiling)

    const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat.clone())
    back.position.set(0, 0, -D)
    scene.add(back)

    const left = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMat.clone())
    left.rotation.y = Math.PI / 2
    left.position.set(-W / 2, 0, -D / 2)
    scene.add(left)

    const right = left.clone()
    right.rotation.y = -Math.PI / 2
    right.position.set(W / 2, 0, -D / 2)
    scene.add(right)

    // Окно на задней стене: светящаяся «панорама» + рама
    const tex = await new THREE.TextureLoader().loadAsync(SCENE_CONFIG.cityPanoramaUrl)
    tex.colorSpace = THREE.SRGBColorSpace
    const view = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 120),
      new THREE.MeshBasicMaterial({ map: tex })
    )
    view.position.set(60, 20, -D + 1)
    scene.add(view)
    const frameMat = new THREE.MeshLambertMaterial({ color: 0x6b5b45 })
    for (const [w, h, x, y] of [[170, 8, 60, 84], [170, 8, 60, -44], [8, 130, -22, 20], [8, 130, 142, 20]]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 6), frameMat)
      bar.position.set(x, y, -D + 3)
      scene.add(bar)
    }

    // Мебель-болванки: диван, столик, торшер — дают параллаксу зацепки на разной глубине
    const sofaMat = new THREE.MeshLambertMaterial({ color: 0x5d7396 })
    const sofa = new THREE.Mesh(new THREE.BoxGeometry(180, 70, 80), sofaMat)
    sofa.position.set(-80, -H / 2 + 35, -D + 120)
    scene.add(sofa)
    const sofaBack = new THREE.Mesh(new THREE.BoxGeometry(180, 60, 20), sofaMat)
    sofaBack.position.set(-80, -H / 2 + 95, -D + 90)
    scene.add(sofaBack)

    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(40, 40, 6, 32),
      new THREE.MeshLambertMaterial({ color: 0x8a6f4d })
    )
    table.position.set(40, -H / 2 + 45, -D / 2)
    scene.add(table)

    const lampPole = new THREE.Mesh(
      new THREE.CylinderGeometry(2, 2, 150, 8),
      new THREE.MeshLambertMaterial({ color: 0x333333 })
    )
    lampPole.position.set(150, -H / 2 + 75, -120)
    scene.add(lampPole)
    const lampLight = new THREE.PointLight(0xffd9a0, 30000, 0, 2)
    lampLight.position.set(150, 20, -120)
    scene.add(lampLight)
  }

  scene.add(new THREE.AmbientLight(0xffffff, 0.5))
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.2)
  sun.position.set(100, 200, 100)
  scene.add(sun)
  return scene
}
