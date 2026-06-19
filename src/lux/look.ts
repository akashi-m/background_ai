// Пер-интерьерный look-конфиг (спека §3). Чистая логика: типы, дефолты, мёрж, загрузчик.
// НЕ импортирует compositor.ts (чтобы тесты не тянули GPU-код). Потребитель — позже (P2+).

export interface ColorMatchLook { cast: number; exposure: number }
export interface MatteLook { erode: number; feather: [number, number] }
export interface DeShadowLook {
  mode: 'off' | 'lite' | 'relight'
  strength: number; localLumaRadius: number; highlightKnee: number; shadowLift: number
}
export interface CropLook { edgeFade: number; sbsSeamGuard: number }
export interface GeomLook {
  anchorMode: 'coverfit' | 'height'
  mirrorMag: number; photo25dHeightFudge: number; footAnchorRaise: number; heightTrust: number
}
export interface GradeLook {
  colorMatch: ColorMatchLook
  contrast: number; temp: number; saturation: number; shade: number; wrapStrength: number
}
export interface ShadowBakedLook { feetUV: [number, number]; raise: number }
export interface ShadowProxyLook {
  centerDark: number; edgeDark: number; blur: number; shrinkK: number; feetCutR: number
}
export interface ShadowBlobLook { opacity: number; raise: number; ratioY: number }
export interface ShadowContactLook {
  enabled: boolean
  footLenCm: number; footWidthCm: number; darkness: number; edgeCm: number
  liftCm: [number, number]; visMin: number
}
export interface ShadowMultiplyLook {
  tint: [number, number, number]
  centerDark: number; edgeDark: number; blur: number; maxShadow: number
}
export interface ShadowLook {
  strength: number
  baked: ShadowBakedLook; proxy: ShadowProxyLook; blob: ShadowBlobLook
  contact: ShadowContactLook; multiply: ShadowMultiplyLook
  softness: number; bias: number
}
export interface UnifyLook {
  lut: string | null; lutStrength: number; grain: number; bloom: number
  bloomThreshold: number; vignette: number
}

export interface ResolvedLook {
  matte: MatteLook
  deshadow: DeShadowLook
  crop: CropLook
  geom: GeomLook
  grade: GradeLook
  shadow: ShadowLook
  unify: UnifyLook
}

export type DeepPartial<T> =
  T extends (infer _U)[] ? T :
  T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } :
  T
export type Look = DeepPartial<ResolvedLook>

// Дефолты БАЙТ-РАВНЫ текущим источникам (config.ts LUX_CONFIG + дефолты шейдер-материалов).
// Новые ветки (deshadow/contact/geom/unify.lut/saturation) — в NO-OP значениях, чтобы при
// будущей проводке (P2+) поведение не изменилось: deshadow.mode='off', contact.enabled=false,
// geom.anchorMode='coverfit', saturation=1.0, unify.lut=null.
export const LOOK_DEFAULTS: ResolvedLook = {
  matte: { erode: 0.0025, feather: [0.4, 0.8] },
  deshadow: { mode: 'off', strength: 0.5, localLumaRadius: 0.04, highlightKnee: 0.8, shadowLift: 0.1 },
  crop: { edgeFade: 0.03, sbsSeamGuard: 0.0015 },
  geom: { anchorMode: 'coverfit', mirrorMag: 1.0, photo25dHeightFudge: 1.0, footAnchorRaise: 0.04, heightTrust: 1.0 },
  grade: {
    colorMatch: { cast: 0.35, exposure: 0.15 },
    contrast: 1.08, temp: 0.02, saturation: 1.0, shade: 0.18, wrapStrength: 0.85,
  },
  shadow: {
    strength: 0.5,
    baked: { feetUV: [0.233, 0.161], raise: 0.05 },
    proxy: { centerDark: 0.12, edgeDark: 0.03, blur: 0.014, shrinkK: 0.89, feetCutR: 0.16 },
    blob: { opacity: 0.36, raise: 0.04, ratioY: 0.3 },
    contact: { enabled: false, footLenCm: 26, footWidthCm: 10, darkness: 0.85, edgeCm: 1.0, liftCm: [4, 12], visMin: 0.5 },
    multiply: { tint: [0.40, 0.35, 0.28], centerDark: 0.36, edgeDark: 0.072, blur: 0.009, maxShadow: 0.5 },
    softness: 1.6, bias: 0.005,
  },
  unify: { lut: null, lutStrength: 1.0, grain: 0.07, bloom: 0.5, bloomThreshold: 0.72, vignette: 0.0 },
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Рекурсивный per-leaf мёрж: объекты сливаются, массивы/скаляры заменяются целиком,
// override побеждает. Не мутирует входы (свежий объект на каждом уровне-объекте).
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const key of Object.keys(override)) {
    const o = (override as Record<string, unknown>)[key]
    if (o === undefined) continue
    const b = (base as Record<string, unknown>)[key]
    out[key] = isPlainObject(b) && isPlainObject(o) ? deepMerge(b, o) : o
  }
  return out as T
}

export function resolveLook(defaults: ResolvedLook, override: Look | null | undefined): ResolvedLook {
  return structuredClone(deepMerge(defaults, override ?? {}))
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

// Загрузка пер-мирового look.json. Толерантна: нет файла / сеть упала / мусор → чистые дефолты.
export async function loadLook(
  worldName: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<ResolvedLook> {
  try {
    const res = await fetchFn(`/assets/worlds/${worldName}/look.json`)
    if (!res.ok) return resolveLook(LOOK_DEFAULTS, null)
    const json = (await res.json()) as unknown
    return resolveLook(LOOK_DEFAULTS, isPlainObject(json) ? (json as Look) : null)
  } catch {
    return resolveLook(LOOK_DEFAULTS, null)
  }
}
