import * as THREE from 'three'

// Поверх отрендеренной сцены: вырезанная фигура из видео (зеркально) + чёрный фейд.
// Отдельная ortho-сцена, рендерится вторым проходом с autoClear=false.
export class Compositor {
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private personMat: THREE.ShaderMaterial
  private fadeMat: THREE.MeshBasicMaterial

  constructor(video: HTMLVideoElement) {
    const videoTex = new THREE.VideoTexture(video)
    videoTex.colorSpace = THREE.SRGBColorSpace

    this.personMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      uniforms: {
        uVideo: { value: videoTex },
        uMask: { value: null },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D uVideo;
        uniform sampler2D uMask;
        uniform float uOpacity;
        void main() {
          vec2 uv = vec2(1.0 - vUv.x, vUv.y);          // зеркальный флип
          float m = texture2D(uMask, vec2(uv.x, 1.0 - uv.y)).r; // маска хранится без flipY
          float a = smoothstep(0.35, 0.65, m);          // мягкие края
          vec4 c = texture2D(uVideo, uv);
          gl_FragColor = vec4(c.rgb, a * uOpacity);
        }
      `,
    })
    const person = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.personMat)
    person.renderOrder = 0
    this.scene.add(person)

    this.fadeMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0, depthTest: false,
    })
    const fade = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fadeMat)
    fade.renderOrder = 1
    this.scene.add(fade)
  }

  // personOpacity: 1 в режиме ЗЕРКАЛО, 0 в режиме ОКНО. fade: 0..1 чёрная шторка.
  render(renderer: THREE.WebGLRenderer, mask: THREE.Texture | null, personOpacity: number, fade: number): void {
    this.personMat.uniforms.uMask.value = mask
    this.personMat.uniforms.uOpacity.value = mask ? personOpacity : 0
    this.fadeMat.opacity = fade
    const prevAutoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.render(this.scene, this.camera)
    renderer.autoClear = prevAutoClear
  }
}
