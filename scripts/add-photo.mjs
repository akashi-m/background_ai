// Добавление нового фото в прототип ОДНОЙ командой:
//   node scripts/add-photo.mjs <файл> <имя>
// Пример:
//   node scripts/add-photo.mjs ~/Downloads/living.png living
// Скрипт: копирует фото в public/assets/, генерирует карту глубины,
// печатает готовую строку для src/scenes/config.ts.
import { copyFileSync, existsSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { extname } from 'node:path'

const [, , src, name] = process.argv
if (!src || !name || !existsSync(src)) {
  console.error('usage: node scripts/add-photo.mjs <файл-фото> <короткое-имя>')
  process.exit(1)
}

const ext = extname(src).toLowerCase() || '.png'
const photoOut = `public/assets/${name}${ext}`
const depthOut = `public/assets/${name}_depth.png`

copyFileSync(src, photoOut)
console.log(`фото:     ${photoOut}`)

console.log('генерирую карту глубины (первый раз скачает модель)...')
execFileSync('node', ['scripts/gen-depth.mjs', photoOut, depthOut], { stdio: 'inherit' })

// размеры для aspect — через sips (macOS)
const out = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', photoOut], { encoding: 'utf8' }).stdout
const w = Number(out.match(/pixelWidth: (\d+)/)?.[1])
const h = Number(out.match(/pixelHeight: (\d+)/)?.[1])

console.log(`\nготово! добавь в src/scenes/config.ts (photoRoom или cityView):`)
console.log(`  { url: '/assets/${name}${ext}', depthUrl: '/assets/${name}_depth.png', aspect: ${w} / ${h} },`)
