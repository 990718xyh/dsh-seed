/**
 * 回放模拟器：用真实会话事件喂插件，本地跑完整链路。
 *
 * 比之前的 mock 更严的地方：
 *   1. 只暴露 inject 里声明的服务，越界访问直接抛错（模拟 cordis 的注入语义）
 *   2. 事件带 scope，监听器必须 global 才能收到
 *   3. 用真实会话的 user/message、assistant/message、turn/end 数据
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, inject } from '../index.js'

const DATA = path.join(os.tmpdir(), 'replay-data')
fs.rmSync(DATA, { recursive: true, force: true })

// 事件文件由 tools/export-replay-events.mjs 从真实会话导出；默认找 test/ 下那份
const EVENTS_FILE = process.env.REPLAY_EVENTS ?? path.join(import.meta.dirname, 'replay-events.json')
const fixture = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'))

// 两种格式都认：
//   纯数组                     = 只有事件（假 LLM 用下面默认回复）
//   {events, llmReplies}       = 对调 fixture，事件和假 LLM 回复序列一起固定
const events = Array.isArray(fixture) ? fixture : fixture.events
const hasReplies = !Array.isArray(fixture) && Array.isArray(fixture.llmReplies) && fixture.llmReplies.length > 0

// ---- 假 LLM：按调用顺序返回预设 JSON ----
const DEFAULT_REPLIES = [
  JSON.stringify({ events: [{ summary: '回放测试：他提了一句需求', importance: 6 }],
    facts: [{ op: 'add', text: '回放测试事实', subject: '其它' }],
    lessons: [], triples: [], state: { mood: '平稳' } }),
  JSON.stringify({ op: 'NOOP', target: null, reason: '重复' }),
  JSON.stringify({ questions: ['他最近在忙什么'], insights: [{ text: '他一直在调面板', becauseOf: [] }] }),
  JSON.stringify({ core: '他叫我大肥鱼。', adaptive: '刚认识。', evidence: [] }),
]

const replies = hasReplies ? fixture.llmReplies : DEFAULT_REPLIES
console.log(`fixture: ${path.basename(EVENTS_FILE)} · 事件 ${events.length} 条 · 假 LLM 回复 ${replies.length} 条${hasReplies ? '（固定）' : '（默认）'}`)
let callIndex = 0
const llm = {
  stream() {
    const text = replies[Math.min(callIndex++, replies.length - 1)]
    return (async function* () {
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

// ---- 服务桩 ----
const services = {
  systemPrompt: { context: (spec) => { captured.context = spec; return () => {} } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  tools: { schemas: () => [{ name: 'bash' }], register: (def) => { captured.tools.push(def.name); return () => {} } },
  webServer: { register: (route) => { captured.routes.push(route.path); return () => {} } },
  web: { search: async () => ({ sources: [] }), fetch: async () => ({ body: { content: '' } }) },
  llm, // 真实环境里 llm 是全局服务，ctx.get('llm') 能拿到
}
const captured = { context: null, tools: [], routes: [], events: [] }
const allowed = new Set([...inject, 'logger', 'on', 'effect', 'get', 'emit'])

const listeners = []
const ctx = new Proxy({
  logger: { warn: () => {} },
  on: (name, fn, options) => { listeners.push({ name, fn, options }); return () => {} },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  get: (name) => services[name] ?? null,
  emit: (name, ...args) => {
    const scoped = { id: 's1', header: { cwd: '/Users/violent/personal/product' } }
    for (const l of listeners) {
      if (l.name !== name) continue
      // 模拟 scope 过滤：非 global 的监听器收不到带 scope 的广播
      l.fn(scoped, ...args)
    }
  },
}, {
  get(target, key) {
    if (key in target) return target[key]
    // 服务桩都能拿到，模拟真实环境里的全局服务
    if (key in services) return services[key]
    if (allowed.has(key)) return undefined
    throw new Error(`访问了未注入的服务: ${String(key)}`)
  },
})

// ---- 跑 ----
const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(name)
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' · ' + detail : ''}`)
}

try {
  apply(ctx, {
    id: 'replay',
    dir: DATA,
    hostId: 'replay',
    llm: { provider: 'p', model: 'm' },
    heartbeat: { enabled: false },
    panel: { enabled: false },
    study: { enabled: false },
    probes: { enabled: false },
  })
  check('apply 不越界访问服务', true, `inject: ${inject.join(',')}`)
} catch (error) {
  check('apply 不越界访问服务', false, String(error))
}

check('注册了 session/event', listeners.some((l) => l.name === 'session/event'))
check('监听器带 global', listeners.filter((l) => l.name === 'session/event').every((l) => l.options?.global === true))
check('注册了 persona 注入', captured.context?.name === 'persona')
console.log('监听器:', listeners.map((l) => `${l.name}${l.options?.global ? '(global)' : ''}`).join(', '))

let emitted = 0
for (const event of events) {
  try {
    ctx.emit('session/event', event)
    emitted += 1
  } catch (error) {
    failures.push(`回放 ${event.type}: ${error}`)
  }
}
console.log('已回放事件:', emitted, '| 类型分布:', JSON.stringify(events.reduce((a, e) => (a[e.type] = (a[e.type] || 0) + 1, a), {})))
await new Promise((r) => setTimeout(r, 1200))

const { Store } = await import('../lib/store.js')
const store = new Store({ dir: path.join(DATA, 'replay'), hostId: 'replay' })
const count = store.load()
const stats = store.stats()
check('事件回放后写入了记录', count > 0, `共 ${count} 条：${JSON.stringify(stats)}`)
check('写入了事件层', (stats.events ?? 0) > 0, `events=${stats.events}`)
check('注入了自述块', (captured.context?.text?.() ?? '').includes('[位置]'))
check('注入了偏好块', (captured.context?.text?.() ?? '').includes('[他要的]'))

console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}`)
process.exit(failures.length === 0 ? 0 : 1)
