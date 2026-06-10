# Скрипт оператора: генерация контента для прототипа

Как генерить фоны в Gemini (gemini.google.com) и подключать их в прототип.
Один кадр = ~2 минуты работы.

## Общие правила для ЛЮБОЙ генерации

- В конце каждого промпта проси максимальное разрешение: фраза уже вшита в промпты ниже.
- Скачивай результат в **максимальном качестве** (PNG, не превью).
- **Без людей в кадре** — посетитель «стоит в комнате» сам.
- Если в углу картинки появился значок-звёздочка (вотермарк Gemini) — не страшно,
  скажи Claude, он обрежет край при подключении.
- Не апскейль ничего сторонними тулами — кладём оригинал как есть.

## 1. Интерьер (режим «Комната», клавиша M)

Загрузи референс комнаты (фото/рендер от застройщика) и отправь:

```
Re-render this exact room from a standing eye-level viewpoint (camera height
150 cm), frontal wide view as if standing at the entrance wall looking into
the room. Keep every piece of furniture, decor, lighting and the color palette
identical and recognizable. Photorealistic interior photograph, natural
perspective, 24mm lens, sharp details, no people, no text. Generate at the
highest resolution available, landscape orientation 3:2.
```

Если ракурс не понравился — итерируй в том же чате:
- «move the camera lower / higher»
- «step back, show more of the room»
- «make the lighting warmer / more evening mood»

## 2. Вид из окна / балкона (режим «Балкон», клавиша W)

Загрузи фото вида (или опиши локацию) и отправь:

```
Expand this exact view into a wide panoramic photograph (21:9). Keep the same
city, the same buildings, the same sky mood and glowing windows. Keep the
balcony railing across the bottom foreground. Extend the cityscape naturally
to the left and right. Photorealistic, sharp details, no people, no text.
Generate at the highest resolution available.
```

Передний план с перилами/подоконником — важен: он красиво параллаксится
на фоне далёкого города.

## 3. Подключение в прототип (одна команда)

```bash
node scripts/add-photo.mjs ~/Downloads/живущая.png living
```

Скрипт сам: положит фото в `public/assets/`, сгенерирует карту глубины,
напечатает готовую строку — вставь её в `src/scenes/config.ts`
(`photoRoom:` для комнаты, `cityView:` для вида) и обнови страницу.

## 4. Тонкая настройка ощущения (по желанию)

| Ручка | Где | Что делает |
|---|---|---|
| `depthAmountCm` | `mirrorScene.ts` (28), `windowScene.ts` (40) | сила объёма: больше = драматичнее, но тянет края объектов |
| `parallaxGain` | `main.ts` (мин. 0.25) | отклик на движение головы; на проде с экраном 120 см станет 1:1 сам |
| `overscan` | вызовы `fitCoverCm` | запас кадра по краям под параллакс |

## 5. Миры-сплаты (максимальное качество, Stellar Window 2.0)

Полноценный 3D-мир из одной картинки (Marble World API, ключ WORLDLABS_API_KEY в .env,
платный план для экспорта):

    node scripts/gen-world.mjs --image фото.png --name living

~5 минут генерации → папка public/assets/worlds/living/ готова. Дальше:
1. Добавь 'living' в worlds в src/scenes/config.ts
2. Запусти приложение, переключись на мир, нажми `A` — выровняй стрелками
   (масштаб: - =, поворот: [ ]), transform скопируй из консоли в meta.json
3. Если позже появится съёмка реальной квартиры — Postshot/Luma → world.spz
   в ту же папку, код не меняется
