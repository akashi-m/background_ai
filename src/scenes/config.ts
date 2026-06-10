// Все ассеты и габариты — здесь. Замена контента = правка этого файла.
export const SCENE_CONFIG = {
  // Вид от первого лица: посетителя НЕ показываем, он «стоит в квартире»
  // и смотрит на комнату. true — вернуть режим зеркала с вырезанной фигурой.
  showPerson: false,

  // Фон режима «Зеркало»:
  //  'photo'      — реальное фото комнаты с 2.5D-параллаксом по карте глубины (по умолчанию)
  //  'procedural' — процедурная спальня (см. bedroom.ts), запасной вариант
  mirrorBackground: 'photo' as 'photo' | 'procedural',

  // Фото: ре-рендеры Gemini (nano banana) от заказчика КАК ЕСТЬ, без апскейла —
  // пере-обработка мылит детали. Карты глубины: scripts/gen-depth.mjs
  photoRoom: { url: '/assets/bedroom_eye.png', depthUrl: '/assets/bedroom_eye_depth.png', aspect: 1058 / 992 },
  cityView: { url: '/assets/city_wide.png', depthUrl: '/assets/city_wide_depth.png', aspect: 1584 / 672 },

  // Габариты процедурной спальни (см): 3 × 4.5 м, потолок 2.7 м (по референсу).
  // Экран = «зеркало» на передней стене z=0, комната уходит в z<0.
  room: { width: 300, height: 270, depth: 450 },

  // Если появится GLTF-интерьер от заказчика — путь сюда, фото/спальня отключатся.
  interiorGltfUrl: null as string | null,
}
