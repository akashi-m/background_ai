# Staged Mirror — Phase 4: Unify whole-frame LUT (S10) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Применять интерьерный 3D-LUT **ко всему кадру** (комната + тень + человек), а не только к человеку — чтобы фон и фигура читались как **одна текстура** (цель-стадия 8 спеки §7). LUT уходит из `personMat` в новую whole-frame стадию `unifyLut`.

**Architecture:** Новый GLSL3-материал `unifyMat` (sampler3D) применяет LUT с силой `look.unify.lutStrength` ко всему `compositeRT`. Новая стадия `unifyLut` идёт **после `person`, до `bloom`** (пинг-понг через `shadowRT2` → блит обратно в `compositeRT`), так что bloom извлекается уже из грейженого кадра. `personMat` LUT выключается (`uLutOn = 0` всегда). Зерно/блум уже whole-frame.

**Tech Stack:** TypeScript, three.js (GLSL3 sampler3D), vitest, Vite.

## Это НАМЕРЕННАЯ смена картинки (не byte-equal)
P4 — первая фаза, меняющая пиксели. Golden-хэш **перезапишется** (новый baseline). Нюанс: `living` имеет identity-LUT → визуально кадр почти не меняется (возможен суб-перцептивный сдвиг от LUT-интерполяции на комнате), но хэш может измениться — это ОК. Проверка: (а) записать новый golden-хэш; (б) визуально `living` выглядит так же; (в) на мире с реальным LUT — комната теперь грейдится заодно с фигурой (единая текстура).

## Design decisions
- **Порядок:** `unifyLut` ПОСЛЕ person, ДО bloom → bloom извлекается из LUT'нутого кадра (единый грейд). enabled = `mirrorVisible && toggles.lut`.
- **Источник LUT:** существующий `opts.lut`/`opts.lutSize` (загружается в main.ts из meta.lut; living → identity). `look.unify.lut` (имя файла) пока НЕ грузим — отложено; используем уже загруженный `opts.lut`.
- **Сила:** `look.unify.lutStrength` (дефолт 1.0) → `mix(c, lut(c), strength)`.
- **person LUT off:** `personMat.uLutOn = 0` всегда (LUT теперь whole-frame). F1 (`toggles.lut`) теперь гейтит `unifyLut`.
- **Пинг-понг:** `compositeRT → unifyMat → shadowRT2 → blit → compositeRT` (read+write одного RT нельзя; `shadowRT2` свободен на этой точке кадра — тени уже отработали).
- **IDLE не трогаем:** `unifyLut` гейтится `mirrorVisible` → слайдшоу без whole-frame LUT (как сейчас).

## File Structure
- **Modify `src/lux/stages.ts`** — `StageId` += `'unifyLut'`; `STAGE_ORDER` вставка после `person`, до `bloom`; `StageInputs.toggles` += `lut`; `stageEnabled('unifyLut') = f.mirrorVisible && o.toggles.lut`.
- **Modify `src/lux/stages.test.ts`** — `inputs()` toggles += `lut: true`; ожидания сценариев += `unifyLut` (где mirrorVisible && lut).
- **Modify `src/lux/compositor.ts`** — `unifyMat` (GLSL3 LUT-пасс) + `runStage('unifyLut')` + `personMat.uLutOn=0`.

---

### Task 1: `unifyLut` в контроль конвейера (stages.ts) — TDD

**Files:** Modify `src/lux/stages.ts`, `src/lux/stages.test.ts`

- [ ] **Step 1: Обновить тест порядка (падающий)**
В `src/lux/stages.test.ts`:
- В `inputs()` добавить `lut: true` в `toggles`: `toggles: { shadow: true, bloom: false, lut: true }`.
- В ожидания сценариев вставить `'unifyLut'` СРАЗУ после `'person'` там, где сцена видима (mirrorVisible=true) И `toggles.lut` (по умолчанию true). Конкретно:
  - сценарий «baked+floor+pose+feetUV+bloom on»: `[...,'person','unifyLut','bloom','grainPresent']`
  - «shadowData+personFloor null → фолбэк+фигура»: `[...,'fallbackSilhouette','person','unifyLut','grainPresent']`
  - «нет shadowData+feetUV»: `[...,'blobContact','person','unifyLut','grainPresent']`
  - «shadowData без baked+floor+pose»: `[...,'proxyShadow','person','unifyLut','grainPresent']`
  - «baked+floor, pose null, feetUV»: `[...,'blobContact','person','unifyLut','grainPresent']`
  - «shadow OFF+feetUV+bloom on+fade>0»: `[...,'person','unifyLut','bloom','grainPresent','fadeCurtain']`
  - IDLE (mirror invisible): `unifyLut` НЕ добавляется (mirrorVisible=false) → без изменений.
- Обновить тест «STAGE_ORDER — канонический порядок»: теперь 12 стадий с `'unifyLut'` после `'person'`.
- Добавить тест: `toggles.lut=false` при mirrorVisible+person → `unifyLut` отсутствует.

- [ ] **Step 2: Запустить — падает**
Run: `npx vitest run src/lux/stages.test.ts` → FAIL (unifyLut нет в STAGE_ORDER; toggles.lut нет в типе).

- [ ] **Step 3: Обновить `src/lux/stages.ts`**
```ts
// StageId — добавить 'unifyLut'
export type StageId =
  | 'sceneBackground' | 'compositeBase' | 'idleSlides'
  | 'bakedShadow' | 'proxyShadow' | 'fallbackSilhouette' | 'blobContact'
  | 'person' | 'unifyLut' | 'bloom' | 'grainPresent' | 'fadeCurtain'

// STAGE_ORDER — вставить 'unifyLut' после 'person', до 'bloom'
export const STAGE_ORDER: StageId[] = [
  'sceneBackground', 'compositeBase', 'idleSlides',
  'bakedShadow', 'proxyShadow', 'fallbackSilhouette', 'blobContact',
  'person', 'unifyLut', 'bloom', 'grainPresent', 'fadeCurtain',
]

// StageInputs.toggles — добавить lut
//   toggles: { shadow: boolean; bloom: boolean; lut: boolean }

// stageEnabled — добавить case
//   case 'unifyLut': return f.mirrorVisible && o.toggles.lut
```

- [ ] **Step 4: Запустить — проходит**
Run: `npx vitest run src/lux/stages.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lux/stages.ts src/lux/stages.test.ts
git commit -m "feat(stages): стадия unifyLut (whole-frame LUT) после person, до bloom + toggles.lut

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `unifyMat` + стадия `unifyLut` в компоновщике, LUT с человека → на весь кадр

**Files:** Modify `src/lux/compositor.ts`

- [ ] **Step 1: Материал `unifyMat` (GLSL3 LUT whole-frame)**
В конструкторе `LuxCompositor` добавить поле `private unifyMat: THREE.ShaderMaterial` и создать (рядом с другими материалами):
```ts
this.unifyMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: {
    tSrc: { value: null }, tLut: { value: null },
    uLutSize: { value: 16 }, uLutStrength: { value: 1 },
  },
  vertexShader: VERT3,
  fragmentShader: /* glsl */ `
    precision highp float;
    precision highp sampler3D;
    in vec2 vUv;
    uniform sampler2D tSrc; uniform sampler3D tLut;
    uniform float uLutSize; uniform float uLutStrength;
    out vec4 fragColor;
    void main() {
      vec3 c = clamp(texture(tSrc, vUv).rgb, 0.0, 1.0);
      vec3 lutUv = c * (uLutSize - 1.0) / uLutSize + 0.5 / uLutSize;
      vec3 graded = texture(tLut, lutUv).rgb;
      fragColor = vec4(mix(c, graded, uLutStrength), 1.0);
    }
  `,
  depthTest: false,
})
```
(Использует общий `VERT3` — тот же, что у personMat. Формула LUT идентична personMat-блоку.)

- [ ] **Step 2: Стадия `unifyLut` в `runStage`**
Добавить case (между `person` и `bloom`):
```ts
case 'unifyLut': {
  const u = this.unifyMat.uniforms
  u.tSrc.value = this.compositeRT.texture
  u.tLut.value = opts.lut
  u.uLutSize.value = opts.lutSize
  u.uLutStrength.value = opts.look.unify.lutStrength
  this.pass(this.unifyMat, this.shadowRT2)
  this.blitMat.uniforms.tSrc.value = this.shadowRT2.texture
  this.pass(this.blitMat, this.compositeRT)
  break
}
```

- [ ] **Step 3: Выключить LUT в `personMat`**
LUT теперь whole-frame. В стадии `person` (где ставятся юниформы personMat) заменить routing `u.uLutOn.value = opts.toggles.lut ? 1 : 0` на `u.uLutOn.value = 0` (person больше не применяет LUT). `tLut`/`uLutSize` на personMat можно оставить (не используются при uLutOn=0). НЕ удалять LUT-код из шейдера personMat (просто выключен) — минимальный диф.

- [ ] **Step 3b: Прокинуть `toggles.lut` в `StageFrame`**
В `render()` (где строится `StageFrame f`) `f.opts.toggles` сейчас `{ shadow: opts.toggles.shadow, bloom: opts.toggles.bloom }` — добавить `lut: opts.toggles.lut`, иначе `stageEnabled('unifyLut')` всегда ложь. (Без этого unifyLut никогда не запустится.)

- [ ] **Step 4: tsc + тесты**
Run: `npx tsc --noEmit` → clean. `npx vitest run` → 188+ зелёных (stages.test обновлён).

- [ ] **Step 5: Golden — записать НОВЫЙ baseline + визуальная проверка**
Поднять preview (`renderer`), `?golden=1`, прочитать `window.__goldenHash` — **запиши новый хэш** (это новый baseline для P5+). Скриншот `living`: должен выглядеть **так же** (identity-LUT). Затем для проверки эффекта — временно навести golden на мир с реальным LUT (если есть bedroom/balcony с meta.lut) ИЛИ в живом режиме глянуть LUT'нутый мир: фон теперь грейдится заодно с фигурой (единая текстура), нет рассинхрона «фигура цветная / фон нет».
*Контроллер выполняет этот шаг и фиксирует новый хэш в памяти/плане.*

- [ ] **Step 6: Commit**
```bash
git add src/lux/compositor.ts
git commit -m "feat(unify): LUT на весь кадр (unifyMat/unifyLut) — фон+тень+человек одной текстурой; person LUT off

Намеренная смена картинки (цель §7): LUT уходит из personMat в whole-frame стадию unifyLut
(после person, до bloom), сила look.unify.lutStrength. living(identity LUT) визуально тот же.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (выполнено автором)
**1. Покрытие спеки §7:** LUT whole-frame через S10 unifyLut (Task 2), person-LUT off, `look.unify.lutStrength` (Task 2 Step 2). Зерно/блум уже whole-frame (P2). `look.unify.lut`-filename-загрузка отложена (используем opts.lut). Whole-frame contrast/temp/saturation (спека упоминает) — отложено (нет полей в look.unify; добавим при необходимости).
**2. Плейсхолдеры:** шейдер unifyMat, стадия-case, обновления stages.ts/test — приведены целиком; команды заданы.
**3. Согласованность:** `unifyLut` в StageId/STAGE_ORDER/stageEnabled/тесте; `StageInputs.toggles.lut` добавлен везде; пинг-понг через shadowRT2 (свободен после теней); enabled = mirrorVisible && toggles.lut.
**Риск:** golden ИЗМЕНИТСЯ (намеренно) — записать новый baseline; не путать с регрессом. Проверить, что IDLE (mirror invisible) не зацепило (unifyLut гейтится mirrorVisible). `StageInputs.toggles` теперь нужен `lut` — обновить ВСЕ места создания StageFrame (compositor buildFrame передаёт toggles.lut из opts.toggles.lut).
