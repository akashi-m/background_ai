import { defineConfig, type Plugin } from 'vite'
import { writeFile } from 'node:fs/promises'

function lookWriterPlugin(): Plugin {
  return {
    name: 'look-writer',
    apply: 'serve', // НИКОГДА в build
    configureServer(server) {
      server.middlewares.use('/__look', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        const m = /^\/([A-Za-z0-9_-]+)$/.exec(req.url || '')
        // allowlist: имя мира должно существовать в public/assets/worlds
        const world = m?.[1]
        if (!world) { res.statusCode = 400; res.end('bad world'); return }
        let body = ''
        req.on('data', (c: Buffer) => { body += c })
        req.on('end', async () => {
          try {
            JSON.parse(body) // валидный JSON
            // защита path-traversal: только [A-Za-z0-9_-], проверено regex выше
            await writeFile(`public/assets/worlds/${world}/look.json`, body)
            res.statusCode = 200; res.end('ok')
          } catch { res.statusCode = 400; res.end('bad json') }
        })
      })
    },
  }
}

export default defineConfig({ plugins: [lookWriterPlugin()] })
