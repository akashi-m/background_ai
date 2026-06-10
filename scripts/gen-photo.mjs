// Генерация/ре-рендер фото через Gemini (Nano Banana Pro) с референс-изображениями.
// Использование:
//   node scripts/gen-photo.mjs --ref images/bedroom.jpg --prompt "..." \
//     --out public/assets/bedroom_eye.png --aspect 16:9 --size 4K
// Ключ: переменная окружения GEMINI_API_KEY или строка GEMINI_API_KEY=... в .env
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// --- аргументы ---
const args = process.argv.slice(2)
function flag(name, fallback = null) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const refs = []
for (let i = 0; i < args.length; i++) if (args[i] === '--ref') refs.push(args[i + 1])
const prompt = flag('prompt')
const out = flag('out')
const aspect = flag('aspect', '16:9')
const size = flag('size', '4K')
if (!prompt || !out) {
  console.error('usage: node scripts/gen-photo.mjs --ref <img> [--ref <img2>] --prompt "..." --out <file> [--aspect 16:9] [--size 4K]')
  process.exit(1)
}

// --- ключ: env или .env ---
let apiKey = process.env.GEMINI_API_KEY
if (!apiKey && existsSync('.env')) {
  const m = readFileSync('.env', 'utf8').match(/^GEMINI_API_KEY=(.+)$/m)
  if (m) apiKey = m[1].trim().replace(/^["']|["']$/g, '')
}
if (!apiKey) {
  console.error('Нет ключа: задай GEMINI_API_KEY в окружении или в .env')
  process.exit(1)
}

// --- запрос ---
const parts = [{ text: prompt }]
for (const ref of refs) {
  const mime = ref.endsWith('.png') ? 'image/png' : 'image/jpeg'
  parts.push({ inline_data: { mime_type: mime, data: readFileSync(ref).toString('base64') } })
}

// Порядок: Pro (платный тир) → Nano Banana 2 (4K, flash) → Nano Banana 1 (до 2K).
// Можно явно задать: --model <имя>
const MODELS = flag('model')
  ? [flag('model')]
  : ['gemini-3-pro-image', 'gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image']

async function generate(model) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: aspect, imageSize: size },
        },
      }),
    },
  )
  const json = await res.json()
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} — ${JSON.stringify(json.error ?? json).slice(0, 500)}`)
  const imagePart = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data)
  if (!imagePart) throw new Error(`${model}: в ответе нет изображения — ${JSON.stringify(json).slice(0, 500)}`)
  const data = (imagePart.inlineData ?? imagePart.inline_data).data
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.log(`ok: ${out} (модель ${model}, ${aspect}, ${size})`)
}

let lastErr
for (const model of MODELS) {
  try {
    await generate(model)
    process.exit(0)
  } catch (e) {
    lastErr = e
    console.error(`не вышло: ${e.message}`)
  }
}
console.error('Обе модели не сработали. Последняя ошибка выше.')
process.exit(1)
