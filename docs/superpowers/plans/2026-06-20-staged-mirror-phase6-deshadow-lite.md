# Staged Mirror — Phase 6: de-shadow lite (S3 slot) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ввести стадию-слот де-шэдоу (`deshadow`) как ОТДЕЛЬНЫЙ пре-пасс: из SBS-человека (`opts.person`) делает де-шэдоутую копию `personA`, person-стадия читает её при `look.deshadow.mode != 'off'`. v0 = тональное выравнивание (lift теней + roll-off пересветов). По умолчанию `mode='off'` → рендер не меняется (golden `7ca9e210` держится). Контракт слота готов под v1 (локально-яркостный блюр) и relight.

**Architecture:** Новый RT `personA` (canvas-size). Новый `deshadowMat` (GLSL3): full-screen, читает SBS `opts.person`, для ЛЕВОЙ (RGB) половины применяет тон-кривую (`shadowLift`/`highlightKnee`/`strength`), ПРАВУЮ (альфа) копирует без изменений, пишет `personA` (UV-сохраняюще: `personA[uv]=deshadow(person[uv])`). Стадия `deshadow` (перед `person` в STAGE_ORDER) рендерит это когда `mode!='off'`. Стадия `person` ставит `tVideo = personA` когда де-шэдоу активна, иначе `opts.person`.

**Tech Stack:** TypeScript, three.js (GLSL3), vitest.

**Guards:** `stages.test` (порядок + новый предикат) + golden. **mode='off' по умолчанию** → `deshadow` стадия не запускается → person читает `opts.person` → golden **держится `7ca9e210`** (текущий lobby-baseline). Это финальный гард Task 2.

**look.deshadow** (уже в look.ts, P1): `{ mode:'off', strength:0.5, localLumaRadius:0.04, highlightKnee:0.8, shadowLift:0.1 }`. v0 использует strength/shadowLift/highlightKnee; localLumaRadius — v1 (не используется сейчас).

---

### Task 1: Стадия `deshadow` в контроль конвейера (stages.ts) — TDD

**Files:** Modify `src/lux/stages.ts`, `src/lux/stages.test.ts`

- [ ] **Step 1: Тест (падающий)** — в `stages.test.ts`:
  - `inputs()` добавить `deshadowMode: 'off'` в дефолт.
  - В ожидания: `deshadow` появляется СРАЗУ ПЕРЕД `person`, когда `mirrorVisible && person && deshadowMode!='off'`. Все текущие сценарии используют дефолт `deshadowMode:'off'` → `deshadow` там НЕ появляется (ожидания НЕ меняются — это держит обратную совместимость).
  - Обновить тест STAGE_ORDER: 13 стадий, `deshadow` перед `person`.
  - Добавить тест: `frame(true, { person: PERSON, deshadowMode: 'lite' })` → ожидание включает `deshadow` перед `person`: `[...,'fallbackSilhouette','deshadow','person','unifyLut','grainPresent']` (при дефолтных shadowData null + toggles).

- [ ] **Step 2: Запустить — падает** (`npx vitest run src/lux/stages.test.ts`).

- [ ] **Step 3: `stages.ts`**:
```ts
// StageId — добавить 'deshadow' (перед 'person')
//   ... 'blobContact' | 'deshadow' | 'person' | 'unifyLut' | ...
// STAGE_ORDER — вставить 'deshadow' прямо перед 'person'
// StageInputs — добавить поле: deshadowMode: 'off' | 'lite' | 'relight'
// stageEnabled — добавить:
//   case 'deshadow': return f.mirrorVisible && !!o.person && o.deshadowMode !== 'off'
```

- [ ] **Step 4: Запустить — проходит** + `npx vitest run`.

- [ ] **Step 5: Commit**
```bash
git add src/lux/stages.ts src/lux/stages.test.ts
git commit -m "feat(stages): стадия deshadow (слот S3) перед person + deshadowMode предикат

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `deshadowMat` + стадия `deshadow` + person читает personA

**Files:** Modify `src/lux/compositor.ts`

- [ ] **Step 1: RT `personA`**
В конструкторе: `private personA: THREE.WebGLRenderTarget` = `new THREE.WebGLRenderTarget(width, height)`; в `setSize` добавить `this.personA.setSize(width, height)`.

- [ ] **Step 2: `deshadowMat` (GLSL3, тон-выравнивание SBS-RGB)**
```ts
this.deshadowMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: {
    tVideo: { value: null }, uStrength: { value: 0.5 },
    uShadowLift: { value: 0.1 }, uHighlightKnee: { value: 0.8 },
  },
  vertexShader: VERT3,
  fragmentShader: /* glsl */ `
    precision highp float;
    in vec2 vUv;
    uniform sampler2D tVideo;
    uniform float uStrength; uniform float uShadowLift; uniform float uHighlightKnee;
    out vec4 fragColor;
    void main() {
      vec4 src = texture(tVideo, vUv);
      if (vUv.x >= 0.5) { fragColor = src; return; }   // альфа-половина SBS — без изменений
      vec3 c = src.rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float lifted = l + uShadowLift * (1.0 - l);        // открыть тени
      float tamed = lifted < uHighlightKnee
        ? lifted
        : uHighlightKnee + (lifted - uHighlightKnee) * 0.5; // мягкий roll-off пересветов
      float ratio = l > 1e-3 ? tamed / l : 1.0;
      vec3 flat = clamp(c * ratio, 0.0, 1.0);
      fragColor = vec4(mix(c, flat, uStrength), src.a);   // сила; альфа сохранена
    }
  `,
  depthTest: false,
})
```
(Поле `private deshadowMat: THREE.ShaderMaterial` объявить.)

- [ ] **Step 3: Стадия `deshadow` в `runStage`** (перед `person`):
```ts
case 'deshadow': {
  const d = this.deshadowMat.uniforms
  d.tVideo.value = opts.person
  d.uStrength.value = opts.look.deshadow.strength
  d.uShadowLift.value = opts.look.deshadow.shadowLift
  d.uHighlightKnee.value = opts.look.deshadow.highlightKnee
  this.pass(this.deshadowMat, this.personA)
  break
}
```

- [ ] **Step 4: person читает personA когда де-шэдоу активна**
В стадии `person`, где `u.tVideo.value = opts.person`, заменить на:
```ts
u.tVideo.value = opts.look.deshadow.mode !== 'off' ? this.personA.texture : opts.person
```
(personA заполнена стадией deshadow, которая в STAGE_ORDER идёт ПЕРЕД person и enabled при том же условии. Когда mode='off' → person читает opts.person, как сейчас → golden цел.)

- [ ] **Step 5: `deshadowMode` в StageFrame**
В `render()` где строится `StageFrame f`: добавить `deshadowMode: opts.look.deshadow.mode` в `f.opts` (иначе `stageEnabled('deshadow')` не сработает / tsc упадёт на отсутствии поля).

- [ ] **Step 6: tsc + тесты + GOLDEN-ГАРД**
`npx tsc --noEmit` clean; `npx vitest run` зелёные. Затем preview `?golden=1` → `window.__goldenHash` **обязан остаться `7ca9e210`** (lobby look.deshadow.mode='off' по умолчанию → стадия deshadow не идёт, person читает opts.person). Если хэш сменился — значит deshadow зря активна при mode='off' или person читает personA при off; исправить гейт.

- [ ] **Step 7: Commit**
```bash
git add src/lux/compositor.ts
git commit -m "feat(deshadow): стадия-слот deshadow lite (тон-выравнивание SBS-RGB → personA), default off

Слот S3: отдельный пре-пасс, person читает personA при look.deshadow.mode!='off'. v0 —
lift теней + roll-off пересветов; localLumaRadius (локальный блюр) и relight — позже,
контракт готов. mode='off' по умолчанию → golden 7ca9e210 держится.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Golden-гард + визуальная проверка эффекта (контроллер)

- [ ] **Step 1: Golden держится** — `?golden=1` → хэш `7ca9e210` (mode='off' дефолт). Подтвердить.
- [ ] **Step 2: Визуальная проверка (опц., живой режим)** — выставить `look.deshadow.mode='lite'` (через look.json lobby или dev-панель) → на живом человеке тени на коже/одежде мягче, пересветы сжаты, без артефактов края (альфа не тронута → матт-край как был). Подобрать strength/shadowLift/highlightKnee по вкусу, сохранить в lobby/look.json. *(Полная оценка — на живом capture.)*

---

## Self-Review (выполнено автором)
**1. Покрытие спеки §5:** S3 как ОТДЕЛЬНАЯ стадия-слот (не фьюз в person-мегашейдер), v0 lite = тон-выравнивание (lift/knee/strength), альфа не трогается (инвариант графа §5), контракт готов под v1 (localLumaRadius блюр) и relight (mode-свитч). personA RT добавлен (был отложен в P2 по YAGNI — теперь нужен).
**2. Плейсхолдеры:** shader, стадия-case, person-правка, StageFrame-поле, тесты — приведены; golden-гард задан.
**3. Согласованность:** `deshadow` в StageId/STAGE_ORDER (перед person)/stageEnabled/StageInputs.deshadowMode/тесте; `f.opts.deshadowMode` из `opts.look.deshadow.mode`; person tVideo гейтится на mode; uniforms из look.deshadow.
**Риск:** mode='off' дефолт обязан держать golden 7ca9e210 (финальный гард Step 6). personA — canvas-size RT, SBS рендерится UV-сохраняюще (лёгкий ресэмпл, для lite ок). Эффект тон-выравнивания глобальный (не локальный) — честный lite v0; локальный блюр — v1.
