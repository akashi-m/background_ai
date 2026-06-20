// Контроль конвейера компоновщика (спека §2). ЧИСТЫЙ модуль — без three.js,
// чтобы порядок/условия стадий тестировались без GPU. GL-исполнение — в compositor.ts.

export type StageId =
  | 'sceneBackground' | 'compositeBase' | 'idleSlides'
  | 'bakedShadow' | 'proxyShadow' | 'fallbackSilhouette' | 'blobContact'
  | 'person' | 'unifyLut' | 'bloom' | 'grainPresent' | 'fadeCurtain'

// Канонический порядок исполнения (строгий). fadeCurtain — опц. эпилог.
export const STAGE_ORDER: StageId[] = [
  'sceneBackground', 'compositeBase', 'idleSlides',
  'bakedShadow', 'proxyShadow', 'fallbackSilhouette', 'blobContact',
  'person', 'unifyLut', 'bloom', 'grainPresent', 'fadeCurtain',
]

// Фича-флаг прокси-тени (перенесён сюда из compositor.ts как pipeline-config).
export const PROXY_SHADOW_ENABLED = true

// Только поля, от которых зависят предикаты (textures — как unknown|null, проверяем !!).
export interface StageInputs {
  toggles: { shadow: boolean; bloom: boolean; lut: boolean }
  person: unknown | null
  shadowData: { bakedShadow?: unknown | null } | null
  personFloor: unknown | null
  pose: unknown | null
  feetUV: unknown | null
  slides: { visible: number; a: unknown | null }
  fade: number
}

export interface StageFrame {
  opts: StageInputs
  mirrorVisible: boolean   // = mirrorOpacity > 0.001 (вычисляет compositor)
  sx: number               // cover-fit фигуры/тени
  sy: number
}

export function stageEnabled(id: StageId, f: StageFrame): boolean {
  const o = f.opts
  const shadowBase = f.mirrorVisible && o.toggles.shadow && !!o.person
  switch (id) {
    case 'sceneBackground': return f.mirrorVisible
    case 'compositeBase': return true
    case 'idleSlides': return o.slides.visible > 0.001 && !!o.slides.a
    case 'bakedShadow': return shadowBase && !!o.shadowData && !!o.personFloor && !!o.shadowData.bakedShadow
    case 'proxyShadow': return shadowBase && !!o.shadowData && !!o.personFloor && PROXY_SHADOW_ENABLED && !!o.pose
    case 'fallbackSilhouette': return shadowBase && !(o.shadowData && o.personFloor)
    case 'blobContact': return shadowBase && !!o.feetUV
    case 'person': return f.mirrorVisible && !!o.person
    case 'unifyLut': return f.mirrorVisible && o.toggles.lut
    case 'bloom': return o.toggles.bloom
    case 'grainPresent': return true
    case 'fadeCurtain': return o.fade > 0.001
  }
}

export function activeStages(f: StageFrame): StageId[] {
  return STAGE_ORDER.filter((id) => stageEnabled(id, f))
}
