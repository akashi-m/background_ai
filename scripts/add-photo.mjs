// Добавление нового фото в прототип ОДНОЙ командой:
//   node scripts/add-photo.mjs <файл> <имя>
// Пример:
//   node scripts/add-photo.mjs ~/Downloads/living.png living
// Скрипт: создаёт папку worlds/<имя>/, копирует фото как photo<ext>,
// генерирует карту глубины depth.png и записывает meta.json.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { extname, resolve } from 'node:path'

const [, , src, name] = process.argv
if (!src || !name || !existsSync(resolve(src))) {
  console.error('usage: node scripts/add-photo.mjs <файл-фото> <короткое-имя>')
  process.exit(1)
}

const srcResolved = resolve(src)
const ext = extname(srcResolved).toLowerCase() || '.png'

const worldDir = `public/assets/worlds/${name}`
const photoFile = `photo${ext}`
const photoOut  = `${worldDir}/${photoFile}`
const depthFile = 'depth.png'
const depthOut  = `${worldDir}/${depthFile}`

// Создаём папку мира
mkdirSync(worldDir, { recursive: true })

// Копируем фото
copyFileSync(srcResolved, photoOut)
console.log(`фото:     ${photoOut}`)

// Генерируем карту глубины (первый раз скачает модель)
console.log('генерирую карту глубины (первый раз скачает модель)...')
execFileSync('node', ['scripts/gen-depth.mjs', photoOut, depthOut], { stdio: 'inherit' })

// Размеры для aspect — через sips (macOS)
const sipsOut = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', photoOut], { encoding: 'utf8' }).stdout
const w = Number(sipsOut.match(/pixelWidth:\s*(\d+)/)?.[1])
const h = Number(sipsOut.match(/pixelHeight:\s*(\d+)/)?.[1])
const aspect = w && h ? Math.round((w / h) * 10000) / 10000 : null

// Записываем meta.json
const meta = {
  title: name,
  format: 'photo25d',
  file: photoFile,
  depthFile,
  aspect,
  dollyMaxCm: 25,
  source: 'add-photo.mjs',
}
writeFileSync(`${worldDir}/meta.json`, JSON.stringify(meta, null, 2) + '\n')

console.log(`\nготово: ${worldDir}/ — добавь '${name}' в worlds в src/scenes/config.ts`)
