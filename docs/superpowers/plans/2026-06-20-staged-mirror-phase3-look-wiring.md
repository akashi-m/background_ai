# Staged Mirror — Phase 3: wire per-interior `look` into the compositor + dev-save — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать `look.json` каждого мира **реальным источником** ручек грейда/тона тени: подать `ResolvedLook` мира в `compositor.render()` и кормить юниформы из `look.*` (заменив конструкторный `tuning` и хардкоды в `render()`), **байт-равно** (golden-хэш `f0d99a94` не меняется). Затем переключить dev-панель на правку look активного мира и **запись `look.json` на диск** через Vite dev-эндпоинт.

**Architecture:** `RenderOpts` получает поле `look: ResolvedLook`. `render()` перед циклом стадий вызывает `applyLook(opts.look)` (статичные пер-мир юниформы), а стадии proxy/baked/blob берут свои константы из `opts.look.*`. `main.ts` грузит `loadLook(world)` на каждый мир в массив `worldLooks[]` и передаёт `worldLooks[switcher.index]` в render. Dev-панель правит `worldLooks[active]` (не юниформы — их перезапишет render), Save POST'ит на `/__look/:world` (Vite serve-only плагин, allowlist).

**Tech Stack:** TypeScript, three.js, vitest, Vite (новый `vite.config.ts`).

**Guard:** golden `?golden` (baseline `f0d99a94`) + `look.test.ts` (пинит дефолты) + `stages.test.ts` (порядок). После каждой задачи: `npx tsc --noEmit`, `npx vitest run`, и перезагрузка `?golden` → хэш обязан остаться `f0d99a94`.

---

## Verified mapping (что вшиваем) — сверено adversarial-проверкой

`look-поле → юниформ` (все дефолты байт-равны, пинятся `look.test.ts`):

| look-поле | юниформ / константа | дефолт | стадия |
|---|---|---|---|
| `grade.wrapStrength` | `personMat.uWrapStrength` | 0.85 | person |
| `matte.erode` | `personMat.uErode` | 0.0025 | person |
| `matte.feather` | `personMat.uFeather` (.x,.y) | [0.4,0.8] | person |
| `grade.colorMatch.cast` | `personMat.uCast` | 0.35 | person |
| `grade.colorMatch.exposure` | `personMat.uExp` | 0.15 | person |
| `grade.contrast` | `personMat.uContrast` | 1.08 | person |
| `grade.temp` | `personMat.uTemp` | 0.02 | person |
| `grade.shade` | `personMat.uShade` | 0.18 | person |
| `unify.grain` | `grainMat.uGrain` | 0.07 | grainPresent |
| `unify.bloom` | `grainMat.uBloom` | 0.5 | grainPresent |
| `unify.bloomThreshold` | `bloomBrightMat.uThreshold` | 0.72 | bloom |
| `shadow.proxy.centerDark` | `multiplyBlitMat.uCenterDark` (override в proxy) | 0.12 | proxyShadow |
| `shadow.proxy.edgeDark` | `multiplyBlitMat.uEdgeDark` (override) | 0.03 | proxyShadow |
| `shadow.proxy.blur` | `multiplyBlitMat.uBlur` (override) | 0.014 | proxyShadow |
| `shadow.proxy.feetCutR` | `multiplyBlitMat.uFeetCutR` (если feetUV, иначе 0) | 0.16 | proxyShadow |
| `shadow.multiply.tint` | `multiplyBlitMat.uShadowTint` (.setRGB) | [0.40,0.35,0.28] | proxyShadow |
| `shadow.multiply.maxShadow` | **`bakedShadowMat.uMaxShadow`** (НЕ uShadowFloorK!) | 0.5 | bakedShadow |
| `shadow.baked.feetUV` | `BAKED_FEET_U/V` (offset) + `bakedShadowMat.uFeetMask` | [0.233,0.161] | bakedShadow |
| `shadow.baked.raise` | `BAKED_RAISE` (offset) | 0.05 | bakedShadow |
| `shadow.blob.opacity` | blob `uOpacity` (× mirrorOpacity) | 0.36 | blobContact |
| `shadow.blob.raise` | blob `uCenter.y` смещение | 0.04 | blobContact |
| `shadow.blob.ratioY` | blob `uRadius.y = rx*ratioY` | 0.3 | blobContact |

**Откладываем (объявлены в look, но НЕ вшиваем этой фазой — как deshadow/contact/geom):**
- `shadow.proxy.shrinkK` (0.89) — живёт в `shadowScene3D.ts:127` (`const k`), вне юниформ компоновщика; проводка требует параметра в `ShadowScene3D`. Остаётся хардкодом, поле в look — на будущее.
- `shadow.softness` (1.6), `shadow.bias` (0.005) — конфиг-бэкед, идут в setup `ShadowScene3D`; тоже отложено.
- `grade.lightDirX` — поля нет; `lightDirX` остаётся пер-фрейм из `opts` (meta). `shadow.strength` — оставляем из `opts.shadowStrength` (meta) этой фазой (НЕ из look), чтобы не трогать per-world meta-путь. (Перевод lightDirX/shadowStrength в look — отдельная мелкая фаза.)

**НЕ трогать (ездят на shader-дефолтах; перезапись сдвинет пиксели):** `uShadowOffset`(-0.03,0.05), `bakedShadowMat.uCutR`(0.12)/`uCutFloor`(0.0), `groundShadowMat.uDrop`(0.022). **Вестигиальные** (не в формуле шейдера, не трогаем): `multiplyBlitMat.uShadowStrength`, `uShadowFloorK`. **Material-дефолты `multiplyBlitMat.uCenterDark/uEdgeDark/uBlur`** (0.36/0.072/0.009) оставить захардкоженными в `makeMultiplyBlitMat` — они **перетираются** proxy-override'ом каждый кадр, рантайму безразличны (НЕ кормить из look во избежание путаницы).

**Byte-equal watchouts:** сохранить `if(opts.feetUV)`-гейт у `uFeetCutR` (0.16/0.0); блоб `uOpacity = look.shadow.blob.opacity * opts.mirrorOpacity`; groundShadow `uOpacity = opts.shadowStrength * opts.mirrorOpacity` (множитель mirrorOpacity не ронять); `feetUV` — всегда пер-фрейм из opts, НИКОГДА из look.

## File Structure
- **Modify `src/lux/compositor.ts`** — `RenderOpts.look: ResolvedLook`; `applyLook(look)` перед циклом; proxy/baked/blob стадии читают `opts.look.*`; удалить конструкторный `tuning`-параметр и `setTuning` (логика уходит в look-правку панели). 
- **Modify `src/main.ts`** — `worldLooks: ResolvedLook[]` через `loadLook`; передать `worldLooks[switcher.index]` в render; dev-панель `onChange` правит `worldLooks[active]` по пути, Save POST'ит look.
- **Modify `src/lux/devPanel.ts`** — слайдеры по схеме look (путь), кнопка Save.
- **Create `vite.config.ts`** — `lookWriterPlugin` (serve-only, allowlist, `POST /__look/:world`).
- **Create `public/assets/worlds/living/look.json`** — identity (пустой `{}` или дефолты) → мир без оверрайдов == golden.

---

### Task 1: Подать `look` в `render()` и кормить юниформы из него (byte-equal, golden-guarded)

**Files:** Modify `src/lux/compositor.ts`, `src/main.ts`

- [ ] **Step 1: `RenderOpts.look` + `applyLook`**
В `RenderOpts` (экспорт из P2) добавить `look: import('./look').ResolvedLook`. В `compositor.ts` импортировать `type { ResolvedLook }` из `./look`. Добавить приватный метод:
```ts
private applyLook(look: ResolvedLook): void {
  const p = this.personMat.uniforms
  const g = look.grade
  p.uWrapStrength.value = g.wrapStrength
  p.uErode.value = look.matte.erode
  p.uFeather.value.set(look.matte.feather[0], look.matte.feather[1])
  p.uCast.value = g.colorMatch.cast
  p.uExp.value = g.colorMatch.exposure
  p.uContrast.value = g.contrast
  p.uTemp.value = g.temp
  p.uShade.value = g.shade
  this.grainMat.uniforms.uGrain.value = look.unify.grain
  this.grainMat.uniforms.uBloom.value = look.unify.bloom
  this.bloomBrightMat.uniforms.uThreshold.value = look.unify.bloomThreshold
  this.multiplyBlitMat.uniforms.uShadowTint.value.setRGB(
    look.shadow.multiply.tint[0], look.shadow.multiply.tint[1], look.shadow.multiply.tint[2])
  this.bakedShadowMat.uniforms.uMaxShadow.value = look.shadow.multiply.maxShadow
  this.bakedShadowMat.uniforms.uFeetMask.value.set(look.shadow.baked.feetUV[0], look.shadow.baked.feetUV[1])
}
```
В `render()` вызвать `this.applyLook(opts.look)` СРАЗУ после вычисления `mirrorVisible`/`sx`/`sy`, ДО цикла `activeStages`.

- [ ] **Step 2: Стадии читают look (proxy/baked/blob)**
В `runStage`:
- `proxyShadow`: заменить хардкоды `mbu.uCenterDark.value = 0.12` → `= opts.look.shadow.proxy.centerDark`; `uEdgeDark` → `.edgeDark`; `uBlur` → `.blur`; в ветке `if (opts.feetUV)` `mbu.uFeetCutR.value = 0.16` → `= opts.look.shadow.proxy.feetCutR` (ветка-else `=0` без изменений).
- `bakedShadow`: в расчёте `uOffset` заменить `BAKED_FEET_U/BAKED_FEET_V/BAKED_RAISE` на `opts.look.shadow.baked.feetUV[0]/[1]` и `opts.look.shadow.baked.raise`. (Удалить module-консты `BAKED_FEET_U/V/RAISE` или оставить неиспользуемыми — лучше удалить.)
- `blobContact`: `b.uOpacity.value = 0.36 * opts.mirrorOpacity` → `= opts.look.shadow.blob.opacity * opts.mirrorOpacity`; смещение `+ 0.04` (в `uCenter.y`) → `+ opts.look.shadow.blob.raise`; `rx * 0.3` (`uRadius.y`) → `rx * opts.look.shadow.blob.ratioY`.

- [ ] **Step 3: Удалить конструкторный `tuning` и `setTuning`**
Убрать параметр `tuning` из конструктора `LuxCompositor` и инициализацию юниформов из него (теперь их каждый кадр ставит `applyLook`). Оставить юниформы с любыми инициализаторами (перезапишутся). Удалить метод `setTuning` (его роль — у dev-панели через look, Task 2). Обновить вызов `new LuxCompositor(...)` в `main.ts` (убрать tuning-аргумент).
**NB:** инициализаторы юниформов в `makeMultiplyBlitMat`/`personMat`/etc. оставить как есть (байт-равны look-дефолтам, пинятся look.test).

- [ ] **Step 4: `main.ts` — грузить look и подать в render**
После сборки `worlds`/`luts` добавить: `const worldLooks = await Promise.all(SCENE_CONFIG.worlds.map((n) => loadLook(n)))` (импорт `loadLook` из `./lux/look`). В вызове `compositor.render({...})` добавить `look: worldLooks[switcher.index]`. В golden-ветке (`runGolden`) — передать `worldLooks[0]` (обновить `runGolden` сигнатуру: принять `look`, прокинуть в opts).

- [ ] **Step 5: tsc + тесты + GOLDEN-ГАРД**
```
npx tsc --noEmit            # clean
npx vitest run              # 188 зелёных (look/stages/devFlags не сломаны)
```
Затем preview: `?golden=1` → прочитать `window.__goldenHash` → **обязан быть `f0d99a94`**. Если нет — найти, какой uniform-feed разошёлся с дефолтом (сверить с таблицей), исправить до совпадения.

- [ ] **Step 6: Commit**
```bash
git add src/lux/compositor.ts src/main.ts
git commit -m "feat(look): render() кормит юниформы из ResolvedLook (applyLook + proxy/baked/blob), убран tuning/setTuning

Байт-равно (golden f0d99a94 сохранён): look — единственный источник грейда/тона тени.
maxShadow→uMaxShadow (bakedShadowMat). shrinkK/softness/bias/lightDirX отложены.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Dev-панель правит look активного мира + Save на диск (Vite-эндпоинт)

**Files:** Create `vite.config.ts`, `public/assets/worlds/living/look.json`; Modify `src/lux/devPanel.ts`, `src/main.ts`

- [ ] **Step 1: Vite serve-only плагин записи look**
Создать `vite.config.ts`:
```ts
import { defineConfig, type Plugin } from 'vite'
import { writeFile } from 'node:fs/promises'

function lookWriterPlugin(): Plugin {
  return {
    name: 'look-writer',
    apply: 'serve', // НИКОГДА в build
    configureServer(server) {
      server.middlewares.use('/__look', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        const m = /^\/([A-Za-z0-9_-]+)$/.exec(req.url || '')
        // allowlist: имя мира должно существовать в public/assets/worlds
        const world = m?.[1]
        if (!world) { res.statusCode = 400; res.end('bad world'); return }
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', async () => {
          try {
            JSON.parse(body) // валидный JSON
            // защита path-traversal: только [A-Za-z0-9_-], проверено regex выше
            await writeFile(`public/assets/worlds/${world}/look.json`, body)
            res.statusCode = 200; res.end('ok')
          } catch { res.statusCode = 400; res.end('bad json') }
        })
      })
    },
  }
}

export default defineConfig({ plugins: [lookWriterPlugin()] })
```
**NB:** allowlist строгий — regex `^[A-Za-z0-9_-]+$` исключает `/`, `..`; запись только в `public/assets/worlds/<world>/look.json`.

- [ ] **Step 2: identity look.json для living**
Создать `public/assets/worlds/living/look.json` с `{}` (пустой оверрайд → resolveLook вернёт чистые дефолты → golden неизменен). *Проверка:* `?golden` хэш всё ещё `f0d99a94`.

- [ ] **Step 3: dev-панель — правка look + Save**
`devPanel.ts`: слайдеры остаются, но `onChange(key, value)` теперь зовёт переданный коллбэк `setLookValue(path, value)` (вместо compositor.setTuning). Маппинг slider-key → look-path (wrapStrength→grade.wrapStrength, grain→unify.grain, и т.д. по таблице). Добавить кнопку **«Save look.json»**.
`main.ts`: коллбэк `setLookValue(path, value)` мутирует `worldLooks[switcher.index]` по пути (мелкий `setPath(obj, 'grade.wrapStrength', v)` хелпер); render следующего кадра подхватит. Save: `fetch('/__look/' + worlds[switcher.index].name, { method:'POST', body: JSON.stringify(worldLooks[switcher.index]) })`. При смене мира — пере-сидировать слайдеры из `worldLooks[active]`.

- [ ] **Step 4: tsc + тесты + golden + ручная проверка Save**
`npx tsc --noEmit`; `npx vitest run`; `?golden` хэш = `f0d99a94`. Ручно (preview, живой режим): `G` → подвигать слайдер → картинка меняется → Save → проверить, что `public/assets/worlds/living/look.json` обновился; перезагрузка → значение подхватилось. Эндпоинт на неизвестный мир (`POST /__look/../etc`) → отказ (regex).

- [ ] **Step 5: Commit**
```bash
git add vite.config.ts public/assets/worlds/living/look.json src/lux/devPanel.ts src/main.ts
git commit -m "feat(look): dev-панель правит look активного мира + Save look.json (Vite serve-плагин)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (выполнено автором)

**1. Покрытие спеки P3:** look.json пер-мир грузится (Task 1 Step 4) и потребляется компоновщиком (Task 1 Step 1-2) — §3; dev-save через Vite serve-плагин + кнопка (Task 2) — §3.3; identity look.json == golden (Task 2 Step 2) — §3.2. Мэппинг сверен и исправлен (maxShadow→uMaxShadow). Отложенные поля (shrinkK/softness/bias/lightDirX) явно перечислены.

**2. Плейсхолдеры:** код applyLook/плагина/маппинга приведён; шаги proxy/baked/blob — точные замены хардкодов на look-поля со ссылкой на таблицу; команды и golden-гард заданы.

**3. Согласованность:** look-поля ↔ юниформы из verified-таблицы (look.test пинит дефолты). `RenderOpts` расширяется полем `look`; `runGolden` и живой render оба передают look; golden остаётся f0d99a94 (Step 5/Step 4 — обязательный гард).

**Риск-нюанс:** byte-equality критична — любой feed, разошедшийся с дефолтом, ломает golden f0d99a94. look.test.ts уже пинит дефолты; golden — финальный гард. НЕ кормить «спящие»/material-дефолт юниформы (см. «НЕ трогать»). Удаление tuning/setTuning — проверить, что main.ts и devPanel перестроены, иначе tsc упадёт.
