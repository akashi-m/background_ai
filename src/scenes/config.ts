// Список миров = папки public/assets/worlds/<имя>/ с meta.json внутри.
// Сейчас грузится только lobby (стиль light); прочие папки миров остаются на диске
// для будущих стилей, но не подключаются.
export const SCENE_CONFIG = {
  worlds: ['lobby'],
}

// Стили интерьера в UI-селекторе (порядок = порядок кнопок). Только light имеет мир
// (lobby); modern/classic/ferre — пустышки: контента ещё нет, показываются тусклыми
// и некликабельными. Когда появится мир — выставить его имя в поле world.
export interface StyleDef {
  key: string
  label: string
  world: string | null // имя мира из SCENE_CONFIG.worlds, либо null = пустышка
}

export const STYLES: StyleDef[] = [
  { key: 'light',   label: 'LIGHT',   world: 'lobby' },
  { key: 'modern',  label: 'MODERN',  world: null },
  { key: 'classic', label: 'CLASSIC', world: null },
  { key: 'ferre',   label: 'FERRÉ',   world: null },
]
