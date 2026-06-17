// Все тайминги/пороги Lux-опыта. Меняются здесь, без правок логики (спека §5).
export const LUX_CONFIG = {
  captureUrl: 'http://localhost:8765', // capture-сервис (offer/ws)
  approachCm: 250,    // ближе — начинается APPROACH
  approachSec: 1.2,   // длительность проявления зеркала
  exitSec: 10,        // отсутствие в MIRROR до возврата в IDLE
  staleSec: 2,        // телеметрия старше — поток считается протухшим
  fadeSec: 1.0,       // плавный уход в IDLE при штатном выходе
  fastFadeSec: 0.3,   // быстрый уход при сбое потока (зависший кадр не показываем)
  slideSec: 8,        // период кроссфейда слайдшоу IDLE
  wrapStrength: 0.85, // сила light wrap 0..1 (↑ сильнее затекание фона на контур — анти-стикер)
  grainAmount: 0.07,  // сила зерна 0..1 (↑ связать видео-шум с чистым 3D)
  erode: 0.0025,      // эрозия альфы (UV) — поджать матт, срезать гало-бахрому RVM
  shadowStrength: 0.5,// дефолтная плотность контактной тени
  feather: [0.4, 0.8] as [number, number], // smoothstep краёв альфы: поджато, убирает «дымку» (A/B на S24)
  colorMatch: { cast: 0.35, exposure: 0.15 }, // перенос цвета/экспозиции сцены на фигуру
  shadeAmount: 0.18, // сила направленного света на фигуре (сторона к свету ярче)
  // strength/softness/bias — v1; blobRatio — blob = доля per-room силы (§6);
  // shadowFloorK — потолок черноты multiply-blit (тень не чернее объектов, §4.5).
  shadow: { strength: 0.5, softness: 1.6, bias: 0.005, blobRatio: 0.5, shadowFloorK: 0.7 },
}
