// Генерация 3D-мира из одной картинки через Marble World API (World Labs).
//   node scripts/gen-world.mjs --image <фото> --name <имя> [--prompt "..."]
// Ключ: WORLDLABS_API_KEY в окружении или .env
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d }
const image = flag('image')
const name = flag('name')
const prompt = flag('prompt', 'photorealistic interior, keep the scene exactly as in the image')
if (!image || !name || !existsSync(image)) {
  console.error('usage: node scripts/gen-world.mjs --image <фото> --name <имя> [--prompt "..."]')
  process.exit(1)
}

let apiKey = process.env.WORLDLABS_API_KEY
if (!apiKey && existsSync('.env')) {
  const m = readFileSync('.env', 'utf8').match(/^WORLDLABS_API_KEY=(.+)$/m)
  if (m) apiKey = m[1].trim().replace(/^["']|["']$/g, '')
}
if (!apiKey) { console.error('Нет ключа: WORLDLABS_API_KEY в окружении или .env'); process.exit(1) }

const BASE = 'https://api.worldlabs.ai'
const HEADERS = { 'WLT-Api-Key': apiKey, 'Content-Type': 'application/json' }

async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}\n${JSON.stringify(json, null, 2).slice(0, 2000)}`)
  return json
}

// 1. Загрузка картинки
console.log('1/4 загружаю картинку...')
const mime = image.endsWith('.png') ? 'image/png' : 'image/jpeg'
const prep = await api('POST', '/marble/v1/media-assets:prepare_upload', { mime_type: mime })
console.log('   prepare_upload →', JSON.stringify(prep).slice(0, 300))
const uploadUri = prep.upload_uri ?? prep.uploadUri ?? prep.signed_url
const assetId = prep.media_asset_id ?? prep.mediaAssetId ?? prep.id
if (!uploadUri || !assetId) throw new Error('Не нашёл upload_uri/media_asset_id в ответе выше — сверь имена полей с docs.worldlabs.ai/api')
const put = await fetch(uploadUri, { method: 'PUT', headers: { 'Content-Type': mime }, body: readFileSync(image) })
if (!put.ok) throw new Error(`PUT upload: HTTP ${put.status}`)

// 2. Генерация мира
console.log('2/4 запускаю генерацию мира (~5 минут)...')
const op = await api('POST', '/marble/v1/worlds:generate', {
  display_name: name,
  world_prompt: {
    type: 'image',
    image_prompt: { source: 'media_asset', media_asset_id: assetId },
    text_prompt: prompt,
  },
})
const opId = op.operation_id ?? op.name ?? op.id
console.log('   operation:', opId)

// 3. Поллинг
let world = null
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 10_000))
  const st = await api('GET', `/marble/v1/operations/${encodeURIComponent(opId)}`)
  process.stdout.write(`   ...${i * 10}с done=${st.done}\r`)
  if (st.error) throw new Error('Генерация упала: ' + JSON.stringify(st.error))
  if (st.done) { world = st.response; break }
}
if (!world) throw new Error('Таймаут 20 минут — проверь операцию ' + opId)

// 4. Скачивание сплата
console.log('\n3/4 скачиваю сплат...')
const splats = world.assets?.splats?.spz_urls ?? {}
const spzUrl = splats.full_res ?? splats['500k'] ?? splats['100k'] ?? Object.values(splats)[0]
if (!spzUrl) throw new Error('Нет spz_urls в ответе:\n' + JSON.stringify(world, null, 2).slice(0, 2000))
const dir = `public/assets/worlds/${name}`
mkdirSync(dir, { recursive: true })
const spz = await fetch(spzUrl)
if (!spz.ok) throw new Error(`скачивание spz: HTTP ${spz.status}`)
writeFileSync(`${dir}/world.spz`, Buffer.from(await spz.arrayBuffer()))

console.log('4/4 пишу meta.json...')
writeFileSync(`${dir}/meta.json`, JSON.stringify({
  title: name,
  format: 'splat',
  file: 'world.spz',
  transform: { position: [0, 0, 0], rotationYDeg: 0, scale: 100 },
  dollyMaxCm: 150,
  source: `marble:${world.id ?? opId}`,
}, null, 2))

console.log(`готово: ${dir}/ — добавь '${name}' в src/scenes/config.ts и выровняй клавишей A`)
