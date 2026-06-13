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
  wrapStrength: 0.6,  // сила light wrap 0..1
  grainAmount: 0.04,  // сила зерна 0..1
  shadowStrength: 0.5,// дефолтная плотность контактной тени
  feather: [0.4, 0.8] as [number, number], // smoothstep краёв альфы: поджато, убирает «дымку» (A/B на S24)
  colorMatch: { cast: 0.35, exposure: 0.15 }, // перенос цвета/экспозиции сцены на фигуру
  shadeAmount: 0.18, // сила направленного света на фигуре (сторона к свету ярче)
  shadow: { strength: 0.7, softness: 1.0, bias: 0.03 },
}
