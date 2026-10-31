/**
 * 独立面板服务：固定端口，不跟着 DSH 的随机端口变。
 * 只在 127.0.0.1 上监听，不对外。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { renderFragments, renderPage } from './panel.js'

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

export function startPanelServer(options) {
  const {
    store,
    dir,
    opts = {},
    getLive,
    pending,
    port = 8787,
    fallback = 4,
    route = '/persona',
    onReady,
    onError,
  } = options

  const candidates = Array.from({ length: fallback + 1 }, (_, i) => port + i)

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === `${route}/live`) {
        return json(res, 200, typeof getLive === 'function' ? getLive() : {})
      }
      if (url.pathname === `${route}/frag`) {
        const waiting = typeof pending === 'function' ? pending() : (pending ?? [])
        const frags = renderFragments(store, { dir, opts, pending: waiting })
        const live = typeof getLive === 'function' ? getLive() : {}
        return json(res, 200, { ...frags, status: live.status ?? 'idle', lastAction: live.lastAction ?? null })
      }
      if (url.pathname === route || url.pathname === `${route}/`) {
        const waiting = typeof pending === 'function' ? pending() : (pending ?? [])
        return html(res, 200, renderPage(store, { dir, opts, pending: waiting }))
      }
      return html(res, 404, 'not found')
    } catch (error) {
      return html(res, 500, `面板渲染失败: ${String(error)}`)
    }
  })

  let index = 0
  let listening = false

  const attempt = () => {
    if (index >= candidates.length) {
      onError?.(new Error('所有候选端口都被占用'))
      return
    }
    const candidate = candidates[index]
    server.once('error', (error) => {
      if (listening) return
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        index += 1
        attempt()
        return
      }
      onError?.(error)
    })
    server.listen(candidate, '127.0.0.1', () => {
      listening = true
      try {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'panel-url.txt'), `http://127.0.0.1:${candidate}${route}\n`)
      } catch {
        /* 地址文件写不进去不影响服务 */
      }
      onReady?.({ port: candidate, url: `http://127.0.0.1:${candidate}${route}` })
    })
  }

  attempt()
  return server
}
