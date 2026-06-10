// Все ассеты и габариты — здесь. Замена контента = правка этого файла.
export const SCENE_CONFIG = {
  // Фон режима «Зеркало»:
  //  'photo'      — реальное фото комнаты с 2.5D-параллаксом по карте глубины (по умолчанию)
  //  'procedural' — процедурная спальня (см. bedroom.ts), запасной вариант
  mirrorBackground: 'photo' as 'photo' | 'procedural',

  // Реальные фото заказчика (из images/) + карты глубины (scripts/gen-depth.mjs)
  photoRoom: { url: '/assets/bedroom.jpg', depthUrl: '/assets/bedroom_depth.png', aspect: 736 / 690 },
  cityView: { url: '/assets/city.jpg', depthUrl: '/assets/city_depth.png', aspect: 736 / 981 },

  // Габариты процедурной спальни (см): 3 × 4.5 м, потолок 2.7 м (по референсу).
  // Экран = «зеркало» на передней стене z=0, комната уходит в z<0.
  room: { width: 300, height: 270, depth: 450 },

  // Если появится GLTF-интерьер от заказчика — путь сюда, фото/спальня отключатся.
  interiorGltfUrl: null as string | null,
}
