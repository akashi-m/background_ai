# Физическая тень от ламп (пол + мебель + стены) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить экранную силуэт-тень на физическую: силуэт-билборд отбрасывает тень, которая ложится на пол/мебель/стены по реальной геометрии комнаты (мировые координаты пикселей из Blender) от 2-3 ламп.

**Architecture:** Из Blender выгружается `lights.json` (лампы + камера/FOV) и `roomworld.exr` (Cycles Position-pass: мировая XYZ каждого пикселя плейта). Чистый модуль `shadowGeom.ts` считает позицию/рост посетителя на полу из телеметрии. Компоновщик добавляет полноэкранный shadow-пасс: для каждого пикселя читает его мировую точку, пускает луч на каждую лампу сквозь силуэт-билборд, и затемняет фон где occluded. Отбрасыватель — плоский силуэт (объём = будущий вариант B).

**Tech Stack:** TypeScript, three.js (WebGL2 GLSL3, EXRLoader), Vitest, Blender (Cycles, MCP), Python.

**Спека:** `docs/superpowers/specs/2026-06-13-physical-floor-shadow-design.md`

---

## Структура файлов

- Create: `public/assets/worlds/living/lights.json` — лампы (world XYZ + weight), камера (pos/fovY/aspect), floorZ. Данные из Blender.
- Create: `public/assets/worlds/living/roomworld.exr` — Cycles Position-pass (RGB = мировые XYZ пикселя). Данные из Blender.
- Create: `capture/../scripts/export-shadow-data.py` (запускается в Blender через MCP) — включает Position-пасс, рендерит EXR, пишет lights.json.
- Create: `src/lux/shadowGeom.ts` — чистые функции: `personFloorWorld`, типы `Lamp`/`ShadowCamera`/`ShadowData`. + тесты `src/lux/shadowGeom.test.ts`.
- Modify: `src/app/worldMeta.ts` — поле `shadow?: { lightsFile, worldPosFile }`.
- Modify: `src/scenes/worldScene.ts` — грузит lights.json + EXR, кладёт в `built.shadowData`.
- Modify: `src/lux/compositor.ts` — новый `roomShadowMat` (полноэкранный), заменяет `groundShadowMat`-пасс; фолбэк на старую тень если нет shadowData.
- Modify: `src/main.ts` — считает `F`/`H` через shadowGeom, сглаживает, передаёт в `compositor.render`.
- Modify: `src/lux/config.ts` — `LUX_CONFIG.shadow = { strength, softness, bias }`.

---

## Task 1: Экспорт данных тени из Blender

**Files:**
- Create: `scripts/export-shadow-data.py` (Python для Blender MCP)
- Output: `public/assets/worlds/living/lights.json`, `public/assets/worlds/living/roomworld.exr`

- [ ] **Step 1: Написать скрипт экспорта**

`scripts/export-shadow-data.py`:
```python
import bpy, json, mathutils, math, os
sc = bpy.context.scene
OUT = bpy.path.abspath("//")  # или абсолютный путь к public/assets/worlds/living/
DEST = os.environ.get("SHADOW_OUT", "/Users/iman/Projects/background_ar/public/assets/worlds/living")

# 1) Position-пасс (мировые координаты пикселя)
vl = sc.view_layers[0]
vl.use_pass_position = True
sc.use_nodes = True
nt = sc.node_tree
for n in list(nt.nodes):
    if n.type == 'OUTPUT_FILE': nt.nodes.remove(n)
rl = next(n for n in nt.nodes if n.type == 'R_LAYERS')
fo = nt.nodes.new('CompositorNodeOutputFile')
fo.base_path = DEST
fo.format.file_format = 'OPEN_EXR'
fo.format.color_depth = '32'
fo.file_slots[0].path = 'roomworld'
nt.links.new(rl.outputs['Position'], fo.inputs[0])

# 2) Камера: позиция, цель, fovY, aspect
cam = bpy.data.objects['Camera']
camd = cam.data
fwd = (cam.matrix_world.to_quaternion() @ mathutils.Vector((0,0,-1)))
target = cam.location + fwd
data = {
  "lamps": [
    {"name":"Key_Living_Warm","pos":list(bpy.data.objects['Key_Living_Warm'].location),"weight":1.0},
    {"name":"Spot_LV_1","pos":list(bpy.data.objects['Spot_LV_1'].location),"weight":0.6},
    {"name":"Ceiling_LED","pos":[4.0,1.5,3.0],"weight":0.4},
  ],
  "camera": {
    "pos": list(cam.location),
    "target": list(target),
    "fovY": camd.angle_y,
    "aspect": sc.render.resolution_x / sc.render.resolution_y,
  },
  "floorZ": 0.0,
}
with open(os.path.join(DEST,"lights.json"),"w") as f:
    json.dump(data, f, indent=2)

# 3) рендер (Position-пасс пишется в roomworld####.exr)
sc.render.filepath = "/tmp/_shadow_beauty.png"
bpy.ops.render.render(write_still=True)
print("EXPORTED lights.json + roomworld EXR to", DEST)
```

- [ ] **Step 2: Прогнать через Blender MCP**

Через `mcp__blender__execute_blender_code` выполнить содержимое скрипта (рендер долгий → MCP таймаутит, файл допишется; поллить).

- [ ] **Step 3: Проверить артефакты**

Run: `ls -la public/assets/worlds/living/lights.json public/assets/worlds/living/roomworld*.exr`
Expected: оба файла есть; `lights.json` валиден (`python3 -m json.tool < .../lights.json`). Переименовать `roomworld0001.exr` → `roomworld.exr` если с номером.

- [ ] **Step 4: Commit**

```bash
git add scripts/export-shadow-data.py public/assets/worlds/living/lights.json public/assets/worlds/living/roomworld.exr
git commit -m "feat(shadow): экспорт ламп + Position-пасса комнаты из Blender"
```

---

## Task 2: Чистая геометрия — позиция/рост посетителя на полу

**Files:**
- Create: `src/lux/shadowGeom.ts`
- Test: `src/lux/shadowGeom.test.ts`

- [ ] **Step 1: Написать падающий тест**

`src/lux/shadowGeom.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { personFloorWorld, type ShadowCamera } from './shadowGeom'

// камера у балконной двери смотрит на восток (как плейт гостиной)
const CAM: ShadowCamera = {
  pos: [1.35, 2.2, 1.62], target: [8.0, 1.5, 1.05], fovY: 1.05, aspect: 1080 / 1920,
}

describe('personFloorWorld', () => {
  it('дальше дистанция → точка F дальше от камеры по оси взгляда', () => {
    const near = personFloorWorld({ distanceCm: 120, bboxCx: 0.5, bboxH: 0.8 }, CAM, 0)
    const far = personFloorWorld({ distanceCm: 250, bboxCx: 0.5, bboxH: 0.5 }, CAM, 0)
    const dNear = Math.hypot(near.F[0] - 1.35, near.F[1] - 2.2)
    const dFar = Math.hypot(far.F[0] - 1.35, far.F[1] - 2.2)
    expect(dFar).toBeGreaterThan(dNear)
    expect(near.F[2]).toBeCloseTo(0, 5) // на полу
  })

  it('смещение bbox вправо → F смещается вбок (Y меняется)', () => {
    const c = personFloorWorld({ distanceCm: 200, bboxCx: 0.5, bboxH: 0.6 }, CAM, 0)
    const r = personFloorWorld({ distanceCm: 200, bboxCx: 0.8, bboxH: 0.6 }, CAM, 0)
    expect(Math.abs(r.F[1] - c.F[1])).toBeGreaterThan(0.1)
  })

  it('рост из bbox+дистанции в диапазоне [1.4, 2.0]', () => {
    const p = personFloorWorld({ distanceCm: 200, bboxCx: 0.5, bboxH: 0.9 }, CAM, 0)
    expect(p.H).toBeGreaterThanOrEqual(1.4)
    expect(p.H).toBeLessThanOrEqual(2.0)
  })
})
```

- [ ] **Step 2: Запустить — упадёт**

Run: `npx vitest run src/lux/shadowGeom.test.ts`
Expected: FAIL — `personFloorWorld` не найдена.

- [ ] **Step 3: Реализовать**

`src/lux/shadowGeom.ts`:
```ts
export type Vec3 = [number, number, number]

export interface ShadowCamera {
  pos: Vec3
  target: Vec3
  fovY: number   // радианы (вертикальный угол)
  aspect: number // resX/resY
}

export interface PersonTelemetry {
  distanceCm: number // дистанция камера→человек
  bboxCx: number     // центр bbox по X, доля кадра 0..1
  bboxH: number      // высота bbox, доля кадра 0..1
}

export interface PersonOnFloor { F: Vec3; H: number }

function sub(a: Vec3, b: Vec3): Vec3 { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]] }
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0]/l, a[1]/l, a[2]/l]
}

export function personFloorWorld(t: PersonTelemetry, cam: ShadowCamera, floorZ: number): PersonOnFloor {
  const fwd = norm(sub(cam.target, cam.pos))
  // правый вектор (горизонталь): fwd × up(0,0,1)
  const right = norm([fwd[1] * 1 - 0, 0 - fwd[0] * 1, 0])
  const d = t.distanceCm / 100 // м
  // боковое смещение из центра bbox: доля кадра → метры по полю зрения на дистанции d
  const halfW = Math.tan(cam.fovY / 2) * cam.aspect * d
  const lateral = (t.bboxCx - 0.5) * 2 * halfW
  // точка в пространстве на дистанции d, затем опускаем на пол
  const px = cam.pos[0] + fwd[0]*d + right[0]*lateral
  const py = cam.pos[1] + fwd[1]*d + right[1]*lateral
  const F: Vec3 = [px, py, floorZ]
  // рост: высота bbox (доля) × видимая высота кадра на дистанции d
  const frameH = 2 * Math.tan(cam.fovY / 2) * d
  const H = Math.min(2.0, Math.max(1.4, t.bboxH * frameH))
  return { F, H }
}
```

- [ ] **Step 4: Запустить — пройдёт**

Run: `npx vitest run src/lux/shadowGeom.test.ts`
Expected: PASS (3 теста).

- [ ] **Step 5: Commit**

```bash
git add src/lux/shadowGeom.ts src/lux/shadowGeom.test.ts
git commit -m "feat(shadow): чистая геометрия — позиция/рост посетителя на полу из телеметрии"
```

---

## Task 3: Загрузка shadowData (lights.json + EXR) в мире

**Files:**
- Modify: `src/app/worldMeta.ts` (поле `shadow`)
- Modify: `src/scenes/worldScene.ts` (загрузка, `built.shadowData`)
- Test: `src/app/worldMeta.test.ts` (если есть; иначе добавить кейс в существующий)

- [ ] **Step 1: Тест парсинга meta.shadow**

Добавить в существующий тест worldMeta (или создать `src/app/worldMeta.test.ts`):
```ts
import { describe, expect, it } from 'vitest'
import { parseWorldMeta } from './worldMeta'

describe('worldMeta shadow', () => {
  it('парсит shadow-файлы', () => {
    const m = parseWorldMeta({
      title: 'x', format: 'photo25d', file: 'p.png', depthFile: 'd.png', aspect: 0.5625,
      shadow: { lightsFile: 'lights.json', worldPosFile: 'roomworld.exr' },
    }, 'x')
    expect(m.shadow?.lightsFile).toBe('lights.json')
    expect(m.shadow?.worldPosFile).toBe('roomworld.exr')
  })
  it('без shadow → undefined', () => {
    const m = parseWorldMeta({ title:'x', format:'photo25d', file:'p.png', depthFile:'d.png', aspect:1 }, 'x')
    expect(m.shadow).toBeUndefined()
  })
})
```

- [ ] **Step 2: Запустить — упадёт**

Run: `npx vitest run src/app/worldMeta.test.ts`
Expected: FAIL — `shadow` нет в типе/парсере.

- [ ] **Step 3: Добавить поле в worldMeta**

`src/app/worldMeta.ts` — в интерфейс `WorldMeta`:
```ts
  shadow?: { lightsFile: string; worldPosFile: string }
```
В `parseWorldMeta`, перед `return`:
```ts
  let shadow: WorldMeta['shadow']
  if (j.shadow && typeof j.shadow === 'object') {
    const s = j.shadow as Record<string, unknown>
    if (typeof s.lightsFile === 'string' && typeof s.worldPosFile === 'string') {
      shadow = { lightsFile: s.lightsFile, worldPosFile: s.worldPosFile }
    }
  }
```
В объект `return`: `shadow,`.

- [ ] **Step 4: Запустить — пройдёт**

Run: `npx vitest run src/app/worldMeta.test.ts`
Expected: PASS.

- [ ] **Step 5: Загрузить данные в worldScene**

`src/scenes/worldScene.ts`:
- импорт: `import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'`
- в `BuiltWorld` добавить: `shadowData?: { lamps: {pos:[number,number,number];weight:number}[]; camera: import('../lux/shadowGeom').ShadowCamera; floorZ: number; worldPos: THREE.Texture }`
- в `buildWorld` для flat-миров, если `meta.shadow`:
```ts
  if (meta.shadow) {
    const lights = await (await fetch(baseUrl + meta.shadow.lightsFile)).json()
    const worldPos = await new EXRLoader().loadAsync(baseUrl + meta.shadow.worldPosFile)
    worldPos.minFilter = THREE.NearestFilter; worldPos.magFilter = THREE.NearestFilter
    built.shadowData = { lamps: lights.lamps, camera: lights.camera, floorZ: lights.floorZ, worldPos }
  }
```

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit` → ok
```bash
git add src/app/worldMeta.ts src/app/worldMeta.test.ts src/scenes/worldScene.ts
git commit -m "feat(shadow): загрузка lights.json + Position-EXR в BuiltWorld.shadowData"
```

---

## Task 4: Прокинуть shadowData + сглаженные F/H в compositor.render

**Files:**
- Modify: `src/lux/config.ts` (LUX_CONFIG.shadow)
- Modify: `src/main.ts` (вызов personFloorWorld + сглаживание + передача)

- [ ] **Step 1: Конфиг тени**

`src/lux/config.ts` — в `LUX_CONFIG`:
```ts
  shadow: { strength: 0.55, softness: 1.0, bias: 0.03 },
```

- [ ] **Step 2: Сгладить F/H и передать (main.ts)**

В `src/main.ts` рядом с расчётом `shadowTarget` заменить на расчёт физ-тени:
```ts
import { personFloorWorld } from './lux/shadowGeom'
// ...
let smoothF: [number,number,number] | null = null
let smoothH = 1.7
// в цикле, при наличии active.shadowData и healthy bbox:
const sd = active.shadowData
let personFloor: { F:[number,number,number]; H:number } | null = null
if (sd && healthy && t?.bbox && t.distanceCm != null) {
  const [x0,, x1] = t.bbox
  const cur = personFloorWorld(
    { distanceCm: t.distanceCm, bboxCx: 1 - (x0 + x1) / 2, bboxH: (t.bbox[3] - t.bbox[1]) },
    sd.camera, sd.floorZ,
  )
  const k = 1 - Math.exp(-dt * 8)
  smoothF = smoothF ? [smoothF[0]+(cur.F[0]-smoothF[0])*k, smoothF[1]+(cur.F[1]-smoothF[1])*k, cur.F[2]] : cur.F
  smoothH = smoothH + (cur.H - smoothH) * k
  personFloor = { F: smoothF, H: smoothH }
}
```
(Зеркальный флип X учтён: bboxCx = 1 − центр, как в текущей тени.)

В `compositor.render({...})` добавить (мапим в форму для рендера, явный `cameraPos`):
```ts
      shadowData: active.shadowData ? {
        lamps: active.shadowData.lamps,
        worldPos: active.shadowData.worldPos,
        floorZ: active.shadowData.floorZ,
        cameraPos: active.shadowData.camera.pos,
      } : null,
      personFloor,
      shadowCfg: LUX_CONFIG.shadow,
```

- [ ] **Step 3: Typecheck (упадёт — compositor ещё не знает полей)**

Run: `npx tsc --noEmit`
Expected: FAIL — нет полей в типе render(). Норм, добавим в Task 5.

- [ ] **Step 4: Commit (после Task 5 пройдёт; коммитим вместе)** — пропустить до Task 5.

---

## Task 5: Shadow-пасс по мировым координатам (компоновщик)

**Files:**
- Modify: `src/lux/compositor.ts`

- [ ] **Step 1: Расширить тип render() и поля**

В `render(opts:{...})` добавить:
```ts
    shadowData: { lamps: {pos:[number,number,number];weight:number}[]; worldPos: THREE.Texture; floorZ: number; cameraPos: [number,number,number] } | null
    personFloor: { F: [number,number,number]; H: number } | null
    shadowCfg: { strength: number; softness: number; bias: number }
```

- [ ] **Step 2: Создать `roomShadowMat` в конструкторе**

Рядом с `groundShadowMat`. GLSL3, фуллскрин. Затемняет фон по мировой геометрии:
```ts
this.roomShadowMat = new THREE.ShaderMaterial({
  transparent: true, depthTest: false, glslVersion: THREE.GLSL3,
  uniforms: {
    tBg: { value: null }, tWorld: { value: null }, tVideo: { value: null },
    uUvScale: { value: new THREE.Vector2(1,1) },      // cover-fit (как фон)
    uPersonUvScale: { value: new THREE.Vector2(1,1) }, // cover-fit силуэта
    uF: { value: new THREE.Vector3() }, uH: { value: 1.7 },
    uCamPos: { value: new THREE.Vector3() },
    uLamp0: { value: new THREE.Vector3() }, uLamp1: { value: new THREE.Vector3() }, uLamp2: { value: new THREE.Vector3() },
    uW: { value: new THREE.Vector3(1,0,0) }, // веса 3 ламп
    uStrength: { value: 0.55 }, uSoft: { value: 1.0 }, uBias: { value: 0.03 },
    uOpacity: { value: 0 }, uNLamps: { value: 0 },
  },
  vertexShader: VERT3,
  fragmentShader: /* glsl */ `
    precision highp float;
    in vec2 vUv; out vec4 fragColor;
    uniform sampler2D tBg, tWorld, tVideo;
    uniform vec2 uUvScale, uPersonUvScale;
    uniform vec3 uF, uCamPos, uLamp0, uLamp1, uLamp2, uW;
    uniform float uH, uStrength, uSoft, uBias, uOpacity, uNLamps;

    // альфа силуэта в мировой точке P на билборд-плоскости (в F, лицом к камере)
    float silAlpha(vec3 P) {
      vec3 n = normalize(vec3(uCamPos.xy - uF.xy, 0.0)); // нормаль билборда (к камере, горизонт.)
      vec3 t = normalize(cross(vec3(0,0,1), n));         // касательная (вбок)
      float u = dot(P - uF, t);                           // поперёк
      float v = (P.z - uF.z) / max(uH, 0.01);             // 0 ступни .. 1 макушка
      // ширина билборда ~ uH*personAspect; маппим u в [0..1] силуэта
      float halfW = uH * (uPersonUvScale.x / max(uPersonUvScale.y, 0.01)) * 0.5;
      float su = clamp(0.5 + u / max(2.0*halfW, 0.01), 0.0, 1.0);
      if (v < 0.0 || v > 1.0) return 0.0;
      // силуэт: cover-fit + зеркальный флип как у фигуры; альфа = правая половина SBS
      vec2 puv = (vec2(su, v) - 0.5) * uPersonUvScale + 0.5; // в кадр силуэта
      vec2 m = vec2(1.0 - puv.x, puv.y);
      return texture(tVideo, vec2(0.5 + m.x*0.5, m.y)).r;
    }

    float shadowFromLamp(vec3 Pw, vec3 L) {
      vec3 n = normalize(vec3(uCamPos.xy - uF.xy, 0.0));
      vec3 dir = L - Pw;
      float denom = dot(dir, n);
      if (abs(denom) < 1e-4) return 0.0;
      float tHit = dot(uF - Pw, n) / denom;   // пересечение с плоскостью билборда
      if (tHit <= uBias || tHit >= 1.0) return 0.0; // окклюдер между Pw и L
      vec3 hit = Pw + dir * tHit;
      return silAlpha(hit);
    }

    void main() {
      vec3 bg = texture(tBg, vUv).rgb;
      // мировая точка пикселя комнаты (cover-fit как у фона)
      vec2 wuv = (vUv - 0.5) * uUvScale + 0.5;
      vec3 Pw = texture(tWorld, wuv).rgb;
      float s = 0.0;
      if (uNLamps > 0.5) s += shadowFromLamp(Pw, uLamp0) * uW.x;
      if (uNLamps > 1.5) s += shadowFromLamp(Pw, uLamp1) * uW.y;
      if (uNLamps > 2.5) s += shadowFromLamp(Pw, uLamp2) * uW.z;
      s = clamp(s, 0.0, 1.0);
      bg *= (1.0 - uStrength * s * uOpacity);
      fragColor = vec4(bg, 1.0);
    }
  `,
})
```
Добавить поле `private roomShadowMat: THREE.ShaderMaterial` и объявление.

- [ ] **Step 3: В render() — пасс тени между фоном и фигурой**

Заменить блок `// 4. силуэтная контактная тень` на:
```ts
    // 4. тень: физическая (по мировым координатам) или фолбэк-силуэт
    if (mirrorVisible && opts.toggles.shadow && opts.person) {
      if (opts.shadowData && opts.personFloor) {
        const u = this.roomShadowMat.uniforms
        u.tBg.value = this.compositeRT.texture // ВАЖНО: фон уже в compositeRT
        u.tWorld.value = opts.shadowData.worldPos
        u.tVideo.value = opts.person
        u.uUvScale.value.set(/* как у coverMat */ this.coverMat.uniforms.uUvScale.value.x, this.coverMat.uniforms.uUvScale.value.y)
        u.uPersonUvScale.value.set(sx, sy)
        u.uF.value.set(opts.personFloor.F[0], opts.personFloor.F[1], opts.personFloor.F[2]); u.uH.value = opts.personFloor.H
        u.uCamPos.value.set(opts.shadowData.cameraPos[0], opts.shadowData.cameraPos[1], opts.shadowData.cameraPos[2])
        const lamps = opts.shadowData.lamps
        u.uNLamps.value = Math.min(3, lamps.length)
        if (lamps[0]) u.uLamp0.value.set(...lamps[0].pos)
        if (lamps[1]) u.uLamp1.value.set(...lamps[1].pos)
        if (lamps[2]) u.uLamp2.value.set(...lamps[2].pos)
        u.uW.value.set(lamps[0]?.weight ?? 0, lamps[1]?.weight ?? 0, lamps[2]?.weight ?? 0)
        u.uStrength.value = opts.shadowCfg.strength
        u.uSoft.value = opts.shadowCfg.softness
        u.uBias.value = opts.shadowCfg.bias
        u.uOpacity.value = opts.mirrorOpacity
        // пасс читает compositeRT и пишет обратно → во временный RT, затем своп
        this.pass(this.roomShadowMat, this.shadowRT)
        this.blitMat.uniforms.tSrc.value = this.shadowRT.texture
        this.pass(this.blitMat, this.compositeRT)
      } else {
        // фолбэк: старая силуэт-тень
        const g = this.groundShadowMat.uniforms
        g.tVideo.value = opts.person; g.uUvScale.value.set(sx, sy)
        g.uOpacity.value = opts.shadowStrength * opts.mirrorOpacity
        g.uLightX.value = opts.lightDirX * 0.015
        this.pass(this.groundShadowMat, this.compositeRT)
      }
    }
```
Добавить `private shadowRT: THREE.WebGLRenderTarget` (полный размер) в конструктор + `setSize`. И прокинуть `cameraPos` в shadowData (в worldScene добавить `cameraPos: lights.camera.pos`).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (после добавления полей). Поправить мелочи типов (spread в .set → `.set(a[0],a[1],a[2])`).

- [ ] **Step 5: Веб-тесты не сломаны**

Run: `npm test`
Expected: 87 passed (юнит-логика не затронута; +2 worldMeta = 89).

- [ ] **Step 6: Commit**

```bash
git add src/lux/compositor.ts src/main.ts src/lux/config.ts src/scenes/worldScene.ts
git commit -m "feat(shadow): физический shadow-пасс по мировым координатам (пол+мебель+стены)"
```

---

## Task 6: meta гостиной + живая приёмка против прокси

**Files:**
- Modify: `public/assets/worlds/living/meta.json`

- [ ] **Step 1: Включить тень в meta**

В `public/assets/worlds/living/meta.json` добавить:
```json
  "shadow": { "lightsFile": "lights.json", "worldPosFile": "roomworld.exr" },
```

- [ ] **Step 2: Живая проверка (capture + рендерер)**

Запросить у пользователя: capture с `--rotate 90`, встать в кадр. Открыть `localhost:5173/?forcePhase=MIRROR&noTracker` (Playwright), снять скриншот. Поставить рядом с Blender-прокси `Human 2` в той же точке.
Ожидание: тень падает от ламп в верную сторону, заползает на пол И диван, по форме силуэта.

- [ ] **Step 3: Тюнинг**

Крутить `LUX_CONFIG.shadow` (strength/softness/bias). При acne — поднять bias. При жёсткости — поднять softness (добавить PCF: несколько сэмплов silAlpha вокруг hit, усреднить).

- [ ] **Step 4: Commit**

```bash
git add public/assets/worlds/living/meta.json src/lux/config.ts
git commit -m "feat(world): гостиная — включена физическая тень от ламп; тюнинг"
```

---

## Self-review заметки

- **Расхождение со спекой §3/§4.3 (учтено):** план использует Cycles **Position-пасс**
  (мировые XYZ пикселя, `roomworld.exr`) вместо `roomdepth`+реконструкция через
  инверсию камеры. Цель спеки (знать мировую точку каждого пикселя-приёмника)
  достигается напрямую и проще; `worldFromDepth`/матрицы камеры в шейдере не нужны.
  Критерии приёмки §10 не меняются.
- PCF-софт (несколько сэмплов в `shadowFromLamp`) добавляется в Task 6 step 3 по живой картинке — заложен в softness.
- Если EXRLoader тяжёл/не грузит — фолбэк: запаковать мир-XYZ в RGBA8 PNG (нормировать XYZ по bbox из lights.json, декодировать в шейдере). Сначала пробуем EXR (проще).
- Фолбэк-ветка (нет shadowData) сохраняет старую силуэт-тень → прочие интерьеры не ломаются.
