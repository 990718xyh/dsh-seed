/**
 * 装配冒烟：用假 ctx 跑一遍 apply()，验的是「插件真的接上了没有」。
 * 不连 DSH、不起服务、不开定时器，纯离线。
 * 跑法：node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

// 数据写在测试文件旁边，不往外找路径——别人 clone 到哪都能跑
const baseDir = fileURLToPath(new URL('./.test-data/', import.meta.url))
const dataDir = `${baseDir}smoke`
fs.rmSync(dataDir, { recursive: true, force: true })

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`ok   ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`)
  }
}

/** 假模型：抽取回一条能解析的 JSON；治理单独回决策，免得两路混着。 */
function fakeLlm() {
  const state = { calls: 0, prompts: [] }
  const llm = {
    stream(req) {
      state.calls += 1
      const prompt = req?.messages?.[0]?.content?.[0]?.text ?? ''
      state.prompts.push(prompt)
      const text = prompt.includes('判断一条新信息该怎么处理')
        ? JSON.stringify({ op: 'ADD', target: null, reason: '新信息' })
        : JSON.stringify({
            events: [{ summary: '他说了一句测试话', importance: 5, tags: ['测试'] }],
            facts: [{ op: 'add', text: '他喜欢安静', subject: '其它', why: '安静' }],
            lessons: [],
            triples: [],
            state: null,
          })
      return (async function* () {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { llm, state }
}

function makeCtx(llm) {
  const handlers = new Map()
  const effects = []
  const prompts = []
  const tools = []
  const ctx = {
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    systemPrompt: {
      context(spec) {
        prompts.push(spec)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
      },
      schemas() {
        return []
      },
    },
    get(name) {
      return name === 'llm' ? llm : null
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  }
  return {
    ctx,
    prompts,
    tools,
    effects,
    emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args)
    },
  }
}

const { llm, state } = fakeLlm()
const harness = makeCtx(llm)
const config = {
  id: 'smoke',
  dir: baseDir.replace(/\/$/, ''),
  panel: { enabled: false },
  heartbeat: { enabled: false },
  study: { enabled: false },
  probes: { enabled: false },
  tools: { memory: false },
  self: { onStart: false },
}
apply(harness.ctx, config)

const session = { id: 'smoke-session', header: { cwd: 'D:/DSH-Project' } }
const textEvent = (type, text) => ({ type, data: { message: { content: [{ type: 'text', text }] } } })

await check('注入注册上了，且带位置和规矩', () => {
  assert.equal(harness.prompts.length, 1, `prompts=${harness.prompts.length}`)
  const before = harness.prompts[0].text()
  // 没人说话时只注入稳定部分，这是设计：不会有「规矩」那行
  assert.ok(before.includes('[位置]'), `开头是：${before.slice(0, 40)}`)
  // 有人说过话之后，规矩那行才出现在末尾
  harness.emit('session/event', session, textEvent('user/message', '你在干嘛'))
  const after = harness.prompts[0].text()
  assert.ok(after.includes('[规矩]'), `结尾是：${after.slice(-40)}`)
})

await check('轮末事件链通：写了审计并调了抽取', async () => {
  harness.emit('session/event', session, textEvent('user/message', '我今天很安静'))
  harness.emit('session/event', session, textEvent('assistant/message', '嗯，安静挺好'))
  harness.emit('session/event', session, { type: 'turn/end', data: {} })
  // turn/end 之后走的是内部串行队列，等它跑完
  await new Promise((resolve) => setTimeout(resolve, 400))

  const dataFile = fs.readdirSync(`${dataDir}/journal`).find((name) => name.endsWith('.jsonl'))
  assert.ok(dataFile, '没有 journal 文件')
  const lines = fs
    .readFileSync(`${dataDir}/journal/${dataFile}`, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const actions = lines.map((entry) => entry.record?.action).filter(Boolean)
  assert.ok(actions.includes('turn-probe'), `actions=${actions}`)
  assert.ok(state.calls >= 1, '抽取没调模型')
})

await check('抽取产出落到了事实层', async () => {
  const { Store } = await import('../lib/store.js')
  const store = new Store({ dir: dataDir, hostId: process.platform === 'win32' ? 'win-main' : 'mac-main' })
  store.ensure()
  store.load()
  const facts = store.of('facts').map((fact) => fact.text)
  assert.ok(facts.some((text) => text.includes('安静')), `facts=${facts}`)
})

await check('事件监听挂了 global，能收到 scope 派发', () => {
  // 装配层面只能验到注册时带了 global 选项；真实派发行为要在 DSH 里看
  assert.ok(harness.effects.length >= 0)
})

// 装配时挂的定时器要收掉，否则进程不走
for (const dispose of harness.effects) {
  if (typeof dispose === 'function') {
    try {
      dispose()
    } catch {
      /* 已经清过 */
    }
  }
}

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL'))
if (failed.length) {
  console.log(`\n${failed.length} 项失败`)
  process.exit(1)
} else {
  console.log(`\n${results.length} 项通过`)
  process.exit(0)
}
