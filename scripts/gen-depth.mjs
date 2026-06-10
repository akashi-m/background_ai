// Генерация карты глубины для 2.5D-параллакса фотографий.
// Использование: node scripts/gen-depth.mjs <вход.jpg> <выход_depth.png>
// Модель: Depth Anything V2 Small (onnx), скачивается с HuggingFace при первом запуске.
import { pipeline, RawImage } from '@huggingface/transformers'

const [, , input, output] = process.argv
if (!input || !output) {
  console.error('usage: node scripts/gen-depth.mjs <input.jpg> <output_depth.png>')
  process.exit(1)
}

const depth = await pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small')
const result = await depth(input)
// result.depth — RawImage в градациях серого: светлее = ближе
await result.depth.save(output)
console.log(`ok: ${output} (${result.depth.width}x${result.depth.height})`)
