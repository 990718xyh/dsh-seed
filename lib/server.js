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
    study = null,
    onReady,
    onError,
  } = options

  const candidates = Array.from({ length: fallback + 1 }, (_, i) => port + i)
  // 手动触发自学时防并发：定时器 30 分钟一次，人点的时候可能撞上
  let studyRunning = false

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
      // 手动触发一次自学：POST <route>/study，跑完回一份摘要。
      // 定时器 30 分钟一次、还受空闲和预算限制，想当场验证改动时用它。
      if (url.pathname === `${route}/study`) {
        if (req.method !== 'POST') return json(res, 405, { error: '用 POST 触发' })
        if (!study) return json(res, 503, { error: '自学没启用（study.enabled=false 或 web 不可用）' })
        if (studyRunning) return json(res, 429, { error: '上一轮自学还在跑' })
        studyRunning = true
        ;(async () => {
          try {
            const result = await study.run({ foreignOk: opts?.net?.overseas ?? true })
            json(res, 200, {
              skipped: result?.skipped ?? null,
              topics: result?.topics ?? [],
              written: (result?.written ?? []).map((item) => item.claim),
              reinforced: (result?.reinforced ?? []).map((item) => item.claim),
              optimizations: (result?.optimizations ?? []).map((item) => item.claim),
              failures: (result?.failures ?? []).map((item) => ({
                topic: item.topic ?? null,
                error: String(item.error ?? '').slice(0, 200),
              })),
            })
          } catch (error) {
            json(res, 500, { error: String(error).slice(0, 400) })
          } finally {
            studyRunning = false
          }
        })()
        return
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
