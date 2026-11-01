/**
 * 离线验收：不联网、不调模型。
 * 覆盖面：层差异衰减、近义度、治理分支（全等/NOOP/ADD）、反思游标、检索计数落盘。
 * 跑法：node test/memory-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Brain, nearDuplicate } from '../lib/brain.js'
import { Heartbeat } from '../lib/heartbeat.js'
import { Store, tokenize, ulid } from '../lib/store.js'

// 数据写在测试文件旁边，不往外找路径——别人 clone 到哪都能跑
const root = fileURLToPath(new URL('./.test-data/', import.meta.url))
fs.rmSync(root, { recursive: true, force: true })

function makeStore(name) {
  const dir = `${root}${name}/`
  const store = new Store({ dir, hostId: 'test-host' })
  store.ensure()
  store.load()
  return { store, dir }
}

/** 假模型：按固定 JSON 回一句，顺便数调用次数。 */
function fakeLlm(reply) {
  const state = { calls: 0 }
  const llm = {
    stream() {
      state.calls += 1
      return (async function* () {
        yield { type: 'text-delta', text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { llm, state }
}

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`ok   ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`)
  }
}

// ---- 近义度：只用来排序，不用来删改 -------------------------------------

await check('同一句话只差空格，近义度为 1', () => {
  assert.equal(nearDuplicate('他喜欢晚上干活', '他喜欢 晚上干活'), 1)
})

await check('不同城市算不同事实，近义度低于 0.8', () => {
  const score = nearDuplicate('他在上海上班', '他在杭州上班')
  assert.ok(score < 0.8, `score=${score}`)
})

// ---- 治理分支 ------------------------------------------------------------

await check('全等重复不问模型', async () => {
  const { store } = makeStore('dup')
  const { llm, state } = fakeLlm('{"op":"NOOP"}')
  const brain = new Brain({ store, llmClient: llm, model: 'x', provider: 'y' })
  store.put('facts', { id: ulid(), ts: Date.now(), text: '他喜欢晚上干活', subject: '偏好', conf: 0.9, confirmations: 1 })
  const applied = await brain.applyFact({ op: 'add', text: '他喜欢晚上干活', subject: '偏好', why: '' }, '')
  assert.equal(applied, null)
  assert.equal(state.calls, 0, '全等重复不该花模型的钱')
  assert.equal(store.of('facts').length, 1)
})

await check('NOOP 视为复证：加确认数、提置信度、不新增记录', async () => {
  const { store } = makeStore('noop')
  const { llm, state } = fakeLlm('{"op":"NOOP"}')
  const brain = new Brain({ store, llmClient: llm, model: 'x', provider: 'y' })
  const id = ulid()
  store.put('facts', { id, ts: Date.now(), text: '他在上海上班', subject: '工作', conf: 0.9, confirmations: 1 })
  const applied = await brain.applyFact({ op: 'add', text: '他是在上海上班', subject: '工作', why: '' }, '')
  assert.equal(applied, null)
  assert.equal(state.calls, 1, '换说法要过治理')
  assert.equal(store.of('facts').length, 1)
  const record = store.get(id)
  assert.equal(record.confirmations, 2, `confirmations=${record.confirmations}`)
  assert.ok(record.conf >= 0.91 && record.conf <= 0.99, `conf=${record.conf}`)
})

await check('ADD 时新事实挂到最像的旧事实上', async () => {
  const { store } = makeStore('link')
  const { llm } = fakeLlm('{"op":"ADD"}')
  const brain = new Brain({ store, llmClient: llm, model: 'x', provider: 'y' })
  const oldId = ulid()
  store.put('facts', { id: oldId, ts: Date.now(), text: '他在上海上班', subject: '工作', conf: 0.9, confirmations: 1 })
  const fact = await brain.applyFact({ op: 'add', text: '他在深圳上班', subject: '工作', why: '' }, '')
  assert.ok(fact, '应该落一条新事实')
  assert.ok(fact.links.includes(oldId), `links=${JSON.stringify(fact.links)}`)
  assert.equal(fact.confirmations, 1)
})

// ---- 检索与衰减 ----------------------------------------------------------

await check('老事实不被三天半衰期的事件挤掉', () => {
  const { store } = makeStore('decay')
  const old = Date.now() - 60 * 86_400_000
  store.put('facts', { id: ulid(old), ts: old, text: '他叫大肥鱼', subject: '称呼', conf: 0.9 })
  store.put('events', { id: ulid(old), ts: old, summary: '他叫大肥鱼', importance: 5, origin: 'user_said' })
  const hits = store.search('大肥鱼', { top: 5 })
  assert.equal(hits[0].record.layer, 'facts', JSON.stringify(hits.map((h) => [h.record.layer, h.score])))
})

await check('反思只嚼游标之后的事件', async () => {
  const { store } = makeStore('reflect')
  const ids = []
  for (let i = 0; i < 4; i += 1) {
    const id = ulid(Date.now() + i)
    ids.push(id)
    store.put('events', { id, ts: Date.now(), summary: `第${i}件事`, importance: 5, origin: 'user_said' })
  }
  const brain = new Brain({ store, llmClient: null, model: 'x', provider: 'y' })
  const result = await brain.reflect({ sinceId: ids[2] })
  assert.equal(result.scanned, 1, `scanned=${result.scanned}`)
  assert.equal(result.written.length, 0)
})

await check('检索命中落盘，重开还在，utility 不为 0', async () => {
  const { store, dir } = makeStore('usage')
  const id = ulid()
  store.put('experience', { id, ts: Date.now(), lesson: '先读源码再重启', hits: 0, lastUsed: 0, utility: 0, archived: false })
  store.markRetrieved([id])
  store.markRetrieved([id])
  await new Heartbeat({ store, dir, brain: null }).tick({ allowLlm: false })
  const record = store.get(id)
  assert.equal(record.hits, 2)
  assert.equal(record.utility, 2)
  assert.equal(store.retrieved.size, 0)

  const reopened = new Store({ dir, hostId: 'test-host' })
  reopened.ensure()
  reopened.load()
  assert.equal(reopened.get(id).hits, 2, '重启回放后命中数丢了')
})

// ---- 从 shikigami / MemoryOS 借来的：idf、权重、遗忘曲线 ----------------

await check('idf：稀有词压过满地都是的常用词', () => {
  const { store } = makeStore('idf')
  const now = Date.now()
  for (const [i, text] of ['他在上海上班', '上海下雨了', '上海很潮', '他讨厌上海话', '上海地铁太挤'].entries()) {
    store.put('facts', { id: ulid(now + i), ts: now, text, subject: '其它', weight: 1, conf: 0.9 })
  }
  store.put('facts', { id: ulid(now + 9), ts: now, text: '他周末放风筝', subject: '其它', weight: 1, conf: 0.9 })
  const hits = store.search('上海 风筝', { layers: ['facts'], top: 3 })
  assert.equal(hits[0].record.text, '他周末放风筝', JSON.stringify(hits.map((h) => [h.record.text, h.score.toFixed(3)])))
})

await check('权重低的记忆排后面', () => {
  const { store } = makeStore('weight')
  const now = Date.now()
  store.put('facts', { id: ulid(now), ts: now, text: '他养了只猫', subject: '其它', weight: 1 })
  store.put('facts', { id: ulid(now + 1), ts: now, text: '他养了只猫', subject: '其它', weight: 0.2 })
  const hits = store.search('只猫', { layers: ['facts'], top: 3 })
  assert.equal(hits[0].record.weight, 1, JSON.stringify(hits.map((h) => [h.record.weight, h.score.toFixed(3)])))
})

await check('钉住的事实不随权重掉队', () => {
  const { store } = makeStore('pin')
  const now = Date.now()
  store.put('facts', { id: ulid(now), ts: now, text: '他叫大肥鱼', subject: '称呼', weight: 0.1, pinned: true })
  store.put('facts', { id: ulid(now + 1), ts: now, text: '他叫大肥鱼', subject: '其它', weight: 0.1 })
  const hits = store.search('大肥鱼', { layers: ['facts'], top: 3 })
  assert.equal(hits[0].record.pinned, true, JSON.stringify(hits.map((h) => [h.record.pinned, h.score.toFixed(3)])))
})

await check('每日遗忘：普通事实变淡，钉住的不动', async () => {
  const { store, dir } = makeStore('decay-daily')
  const now = Date.now()
  const plain = ulid(now)
  const pinned = ulid(now + 1)
  store.put('facts', { id: plain, ts: now, text: '他爱喝可乐', subject: '偏好', weight: 1 })
  store.put('facts', { id: pinned, ts: now, text: '他叫我大肥鱼', subject: '称呼', weight: 1, pinned: true })
  const heartbeat = new Heartbeat({ store, dir, brain: null })
  heartbeat.state.lastDecayAt = now - 10 * 86_400_000
  await heartbeat.tick({ allowLlm: false })
  assert.ok(store.get(plain).weight < 0.99, `weight=${store.get(plain).weight}`)
  assert.equal(store.get(pinned).weight, 1)
})

await check('带时间词的临时事实起始权重低', async () => {
  const { store } = makeStore('transient')
  const brain = new Brain({ store, llmClient: null, model: 'x', provider: 'y' })
  const fact = await brain.applyFact({ op: 'add', text: '他今天在三里屯喝酒', subject: '其它', why: '' }, '')
  assert.ok(fact, '应该落一条')
  assert.equal(fact.weight, 0.6)
})

await check('称呼类事实落盘即钉住', async () => {
  const { store } = makeStore('pin-write')
  const brain = new Brain({ store, llmClient: null, model: 'x', provider: 'y' })
  const fact = await brain.applyFact({ op: 'add', text: '他叫我大肥鱼', subject: '称呼', why: '' }, '')
  assert.equal(fact.pinned, true)
  assert.equal(fact.weight, 1)
})

await check('合并：三条以上才动，合并完旧条失效、新的留出处', async () => {
  const { store } = makeStore('consolidate')
  const old = Date.now() - 100 * 86_400_000
  const ids = []
  for (const [i, text] of ['他提过喜欢下雨', '他提过雨天的味道', '他说过不爱打伞', '他提过雨里走路'].entries()) {
    const id = ulid(old + i)
    ids.push(id)
    store.put('facts', { id, ts: old, validFrom: old, text, subject: '其它', weight: 0.2, conf: 0.9 })
  }
  const { llm, state } = fakeLlm(
    JSON.stringify({ merged: [{ text: '他喜欢雨天，不爱打伞', from: [ids[0], ids[1], ids[2]] }] }),
  )
  const brain = new Brain({ store, llmClient: llm, model: 'x', provider: 'y' })
  const merged = await brain.consolidate({ afterDays: 30, weightBelow: 0.3, batchMax: 12 })
  assert.equal(state.calls, 1)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].text, '他喜欢雨天，不爱打伞')
  assert.deepEqual(merged[0].sources, [ids[0], ids[1], ids[2]])
  assert.equal(store.get(ids[0]).status, 'invalid')
  assert.equal(store.get(ids[3]).status, undefined, '没被合并的那条不该动')
})

await check('合并：不足三条不调模型', async () => {
  const { store } = makeStore('consolidate-skip')
  const old = Date.now() - 100 * 86_400_000
  store.put('facts', { id: ulid(old), ts: old, validFrom: old, text: '他提过喜欢下雨', subject: '其它', weight: 0.2 })
  const { llm, state } = fakeLlm('{"merged":[]}')
  const brain = new Brain({ store, llmClient: llm, model: 'x', provider: 'y' })
  const merged = await brain.consolidate({})
  assert.equal(merged, null)
  assert.equal(state.calls, 0)
})

await check('合并：模型只给一条素材的分组不算合并', async () => {
  const { store } = makeStore('consolidate-guard')
  const old = Date.now() - 100 * 86_400_000
  const ids = []
  for (const [i, text] of ['他提过喜欢下雨', '他提过雨天的味道', '他说过不爱打伞'].entries()) {
    const id = ulid(old + i)
    ids.push(id)
    store.put('facts', { id, ts: old, validFrom: old, text, subject: '其它', weight: 0.2 })
  }
  const { llm } = fakeLlm(JSON.stringify({ merged: [{ text: '他喜欢下雨', from: [ids[0]] }] }))
  const brain = new Brain({ store, llmClient: llm, model: 'x', provider: 'y' })
  const merged = await brain.consolidate({})
  assert.equal(merged, null)
  assert.equal(store.get(ids[0]).status, undefined)
})

// ---- 从 meow-memory 借来的：分词、长度归一化、超级匹配 ----------------

await check('分词认全角、假名和西里尔', () => {
  assert.ok(tokenize('全角ＢＭ２５').has('bm25'), [...tokenize('全角ＢＭ２５')].join(','))
  assert.ok(tokenize('ひらがな').has('ひら'), [...tokenize('ひらがな')].join(','))
  assert.ok(tokenize('привет').has('привет'))
})

await check('同样命中，短记录排前面', () => {
  const { store } = makeStore('len-norm')
  const now = Date.now()
  store.put('facts', { id: ulid(now), ts: now, text: '放风筝', subject: '其它', weight: 1, conf: 0.9 })
  store.put('facts', {
    id: ulid(now + 1),
    ts: now,
    text: '他昨天在公园里放风筝而且看到了很多人在聊天散步和遛狗',
    subject: '其它',
    weight: 1,
    conf: 0.9,
  })
  const hits = store.search('风筝', { layers: ['facts'], top: 3 })
  assert.equal(hits[0].record.text, '放风筝', JSON.stringify(hits.map((h) => [h.record.text, h.score.toFixed(3)])))
})

await check('最匹配的那条不吃时间衰减', () => {
  const { store } = makeStore('supermatch')
  const old = Date.now() - 60 * 86_400_000
  store.put('facts', { id: ulid(old), ts: old, text: '他在深圳上班', subject: '其它', weight: 1, conf: 0.9 })
  store.put('facts', { id: ulid(Date.now()), ts: Date.now(), text: '他在广州上班', subject: '其它', weight: 1, conf: 0.9 })
  const hits = store.search('深圳 上班', { layers: ['facts'], top: 3 })
  assert.equal(hits[0].record.text, '他在深圳上班', JSON.stringify(hits.map((h) => [h.record.text, h.score.toFixed(3)])))
})

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL'))
if (failed.length) {
  console.log(`\n${failed.length} 项失败`)
  process.exitCode = 1
} else {
  console.log(`\n${results.length} 项通过`)
}
