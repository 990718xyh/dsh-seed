/**
 * append-only journal + 内存视图。
 *
 * 所有写入只有一种形态：往 journal/<host>.jsonl 追加一行 put/del。
 * 启动时回放 snapshot/base.json 与本机 journal，合并成只读视图。
 * 跨机同步预留：多份 journal 一起回放即可，当前只回放本机那份。
 */
import fs from 'node:fs'
import path from 'node:path'

export const LAYERS = [
  'facts',
  'events',
  'reflections',
  'experience',
  'knowledge',
  'state',
  'self',
  'summaries',
  'graph',
  'audit',
]

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastMs = 0
let seq = 0

/** 时间有序、进程内唯一。同毫秒用递增序号保证单调，不依赖随机碰撞。 */
export function ulid(now = Date.now()) {
  if (now === lastMs) seq = (seq + 1) % 4096
  else {
    lastMs = now
    seq = 0
  }
  let time = ''
  let t = now
  for (let i = 0; i < 10; i += 1) {
    time = ALPHABET[t % 32] + time
    t = Math.floor(t / 32)
  }
  let tail = ''
  for (let i = 0; i < 4; i += 1) tail += ALPHABET[seq % 32]
  for (let i = 0; i < 12; i += 1) tail += ALPHABET[Math.floor(Math.random() * 32)]
  return time + tail
}

// 汉字（含扩展区）、平假名、片假名、々、ー —— 这几类按相邻 bigram 切
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3005\u30fc]/u
// 其余语言的字母数字（é ü привет 한국어 全角ＢＭ２５）按整词切
const WORD = /[\p{L}\p{N}]/u

/** 判重用：去空白、标点、符号，统一小写。同一句话不同标点算同一条。 */
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 分词：CJK 走相邻 bigram，其他语言走整词，标点和 emoji 直接丢。
 * 抄自 meow-memory 的分类路由——原来的写法只认 ASCII 单词，日文假名、
 * 西里尔、韩文、全角字母全被吃掉，混排内容基本搜不回来。
 */
export function tokenize(text) {
  const out = new Set()
  if (!text) return out
  const chars = Array.from(String(text).normalize('NFKC'))
  const cls = (ch) => (CJK.test(ch) ? 'cjk' : WORD.test(ch) ? 'word' : 'skip')
  let i = 0
  while (i < chars.length) {
    const kind = cls(chars[i])
    if (kind === 'skip') {
      i += 1
      continue
    }
    let j = i + 1
    while (j < chars.length && cls(chars[j]) === kind) j += 1
    const run = chars.slice(i, j)
    if (kind === 'cjk') {
      // 单字不成词，留下只会变成噪音
      for (let k = 0; k + 1 < run.length; k += 1) out.add(run[k] + run[k + 1])
    } else {
      out.add(run.join('').toLowerCase())
    }
    i = j
  }
  return out
}

function decayHours(ts, now) {
  return Math.max(0, (now - ts) / 3_600_000)
}

function isLive(record, now) {
  if (!record) return false
  if (record.status === 'invalid') return false
  if (record.validTo != null && record.validTo <= now) return false
  return true
}

const TEMPORAL = /(昨天|前天|上次|哪次|哪天|什么时候|几点|多久|最近一次|日期|几号)/
const RELATIONAL = /(我们|关系|你对我|咱俩|感情|熟不熟|亲近)/
const PROCEDURAL = /(怎么做|流程|步骤|方法|教训|经验|下次)/
const ROUTE_LAYERS = {
  temporal: ['events', 'facts', 'knowledge'],
  relational: ['state', 'reflections', 'facts'],
  procedural: ['experience', 'knowledge', 'reflections'],
}

function routeQuery(query) {
  const text = String(query || '')
  if (TEMPORAL.test(text)) return ROUTE_LAYERS.temporal
  if (RELATIONAL.test(text)) return ROUTE_LAYERS.relational
  if (PROCEDURAL.test(text)) return ROUTE_LAYERS.procedural
  return null
}

// 半衰期按层给：稳定事实不该像事件一样七天就掉一半分。
// 事件的时效性是真的，事实的时效性不是——「他叫什么」不会因为三天没提就变淡。
const HALF_LIFE_HOURS = {
  facts: 24 * 30,
  experience: 24 * 14,
  knowledge: 24 * 7,
  reflections: 24 * 10,
  events: 24 * 3,
  state: 24 * 2,
  self: 24 * 30,
  summaries: 24 * 14,
}

function isExpired(record, now) {
  if (!record?.fetchedAt || !record?.ttlDays) return false
  const at = Date.parse(record.fetchedAt)
  if (Number.isNaN(at)) return false
  return at + record.ttlDays * 86_400_000 < now
}

export class Store {
  constructor({ dir, hostId, log = () => {} }) {
    this.dir = dir
    this.hostId = hostId
    this.log = log
    this.journalDir = path.join(dir, 'journal')
    this.file = path.join(this.journalDir, `${hostId}.jsonl`)
    this.records = new Map()
    this.inverted = new Map()
    this.retrieved = new Map()
    // 每条记录的词数：BM25 的长度归一化要用，短记录命中更值钱
    this.docLen = new Map()
    this.totalLen = 0
  }

  ensure() {
    fs.mkdirSync(this.journalDir, { recursive: true })
  }

  append(layer, op, id, record, extra = {}) {
    if (!LAYERS.includes(layer)) throw new Error(`unknown layer: ${layer}`)
    const entry = { op, layer, id: id || ulid(), ts: Date.now(), host: this.hostId, ...extra }
    if (record !== undefined) entry.record = record
    this.ensure()
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`)
    this.apply(entry)
    return entry.id
  }

  put(layer, record) {
    return this.append(layer, 'put', record?.id, record)
  }

  del(layer, id, reason) {
    return this.append(layer, 'del', id, undefined, reason ? { reason } : {})
  }

  load() {
    this.records.clear()
    this.retrieved.clear()
    this.inverted.clear()
    this.docLen.clear()
    this.totalLen = 0

    const entries = []
    const basePath = path.join(this.dir, 'snapshot', 'base.json')
    if (fs.existsSync(basePath)) {
      try {
        const base = JSON.parse(fs.readFileSync(basePath, 'utf8'))
        if (Array.isArray(base.entries)) entries.push(...base.entries)
      } catch (error) {
        this.log(`base.json 损坏，忽略: ${String(error)}`)
      }
    }
    if (fs.existsSync(this.journalDir)) {
      for (const name of fs.readdirSync(this.journalDir)) {
        if (!name.endsWith('.jsonl')) continue
        const file = path.join(this.journalDir, name)
        let raw = ''
        try {
          raw = fs.readFileSync(file, 'utf8')
        } catch (error) {
          this.log(`读 journal 失败 ${name}: ${String(error)}`)
          continue
        }
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try {
            entries.push(JSON.parse(line))
          } catch {
            /* 半行写入或损坏，跳过 */
          }
        }
      }
    }

    entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const entry of entries) this.apply(entry)
    return this.records.size
  }

  apply(entry) {
    if (!entry || !entry.id) return
    if (entry.op === 'del') {
      this.unindex(entry.id)
      this.records.delete(entry.id)
      return
    }
    if (entry.op !== 'put') return
    const record = {
      ...entry.record,
      id: entry.id,
      layer: entry.layer,
      // 业务时间优先于写入时间，允许回填历史记录
      ts: entry.record?.ts ?? entry.ts ?? Date.now(),
    }
    this.unindex(entry.id)
    this.records.set(entry.id, record)
    this.index(record)
  }

  /** 参与检索的文本。index 和 unindex 必须用同一份字段，
   *  否则永远有倒排项漏删——之前 unindex 就漏了 name。 */
  indexText(record) {
    return [
      record.text, record.summary, record.insight, record.lesson,
      record.claim, record.mood, record.pressure, record.relationship, record.name,
    ]
      .concat(Array.isArray(record.anchors) ? record.anchors : [])
      .filter(Boolean)
      .join(' ')
  }

  index(record) {
    const tokens = tokenize(this.indexText(record))
    this.docLen.set(record.id, tokens.size)
    this.totalLen += tokens.size
    for (const term of tokens) {
      let bucket = this.inverted.get(term)
      if (!bucket) {
        bucket = new Set()
        this.inverted.set(term, bucket)
      }
      bucket.add(record.id)
    }
  }

  unindex(id) {
    const record = this.records.get(id)
    if (!record) return
    const tokens = tokenize(this.indexText(record))
    this.totalLen = Math.max(0, this.totalLen - (this.docLen.get(id) ?? 0))
    this.docLen.delete(id)
    for (const term of tokens) {
      const bucket = this.inverted.get(term)
      if (bucket) {
        bucket.delete(id)
        if (bucket.size === 0) this.inverted.delete(term)
      }
    }
  }

  get(id) {
    return this.records.get(id)
  }

  of(layer) {
    const out = []
    for (const record of this.records.values()) {
      if (record.layer !== layer || !isLive(record, Date.now())) continue
      out.push(record)
    }
    out.sort((a, b) => (a.id < b.id ? -1 : 1))
    return out
  }

  /** 时间点查询：某一刻有效的记录。 */
  asOf(layer, at) {
    const out = []
    for (const record of this.records.values()) {
      if (record.layer !== layer) continue
      const from = record.validFrom ?? record.ts ?? 0
      const to = record.validTo ?? Number.MAX_SAFE_INTEGER
      if (from <= at && at < to) out.push(record)
    }
    out.sort((a, b) => (a.id < b.id ? -1 : 1))
    return out
  }

  latest(layer) {
    const list = this.of(layer)
    return list.length ? list[list.length - 1] : undefined
  }

  /** 同一层里有没有文字相同的活记录；重复写入挡在这里，不花模型的钱。 */
  findByText(layer, text) {
    const needle = normalizeText(text)
    if (!needle) return undefined
    for (const record of this.records.values()) {
      if (record.layer !== layer) continue
      if (record.status === 'invalid' || record.archived) continue
      if (normalizeText(record.text) === needle) return record
    }
    return undefined
  }

  search(query, { layers, top = 8, now = Date.now(), minScore = 0.05 } = {}) {
    const terms = tokenize(query)
    if (!terms.size) return []
    const candidates = new Map()
    for (const term of terms) {
      const bucket = this.inverted.get(term)
      if (!bucket) continue
      for (const id of bucket) {
        const weight = candidates.get(id) ?? 0
        candidates.set(id, weight + 1)
      }
    }
    const allowed = layers ? new Set(layers) : routeQuery(query) ? new Set(routeQuery(query)) : null

    // 查询本身是路径/URL/版本号这类锚点时，先做整串匹配，别让分词碎片抢先
    const trimmedQuery = String(query).trim()
    const anchorLike = trimmedQuery.length >= 6 && /(?:\/|\\|:\/\/|\d+\.\d+)/.test(trimmedQuery)
    if (anchorLike) {
      const needle = trimmedQuery.toLowerCase()
      const exact = []
      for (const record of this.records.values()) {
        if (!isLive(record, now) || record.archived) continue
        if (allowed && !allowed.has(record.layer)) continue
        for (const anchor of Array.isArray(record.anchors) ? record.anchors : []) {
          const text = String(anchor).trim().toLowerCase()
          if (!text) continue
          if (text === needle || text.includes(needle) || needle.includes(text)) {
            exact.push({ id: record.id, score: 0.95, record })
            break
          }
        }
      }
      if (exact.length) {
        exact.sort((a, b) => (a.record.ts < b.record.ts ? 1 : -1))
        return exact.slice(0, top)
      }
    }
    const scored = []
    // IDF：出现得越普遍的词，权重越低。没有这一步，「他的」「上班」这类高频
    // bigram 和「风筝」这种只出现一次的词同分，检索就被常用词带着走。
    // 参考 shikigami 的 BM25 分支，这里只取 idf 加权，不引依赖。
    const total = Math.max(1, this.records.size)
    const idf = new Map()
    let idfSum = 0
    for (const term of terms) {
      const df = this.inverted.get(term)?.size ?? 0
      const value = Math.log(1 + total / (1 + df))
      idf.set(term, value)
      idfSum += value
    }
    // BM25 的长度归一化：命中同样多词，短记录比长记录更值钱。
    // 抄自 meow-memory：tf 恒为 1（一条记录里同一个词只算一次），
    // 剩下真正起作用的是 idf 和长度因子。
    const K1 = 1.2
    const B = 0.75
    const avgdl = Math.max(1, this.totalLen / Math.max(1, this.docLen.size))
    const relOf = new Map()
    let maxRel = 0
    for (const [id] of candidates) {
      const record = this.records.get(id)
      if (!record) continue
      if (!isLive(record, now)) continue
      if (record.archived) continue
      if (allowed && !allowed.has(record.layer)) continue
      let matchedIdf = 0
      for (const term of terms) if (this.inverted.get(term)?.has(id)) matchedIdf += idf.get(term) ?? 0
      if (matchedIdf <= 0) continue
      const dl = this.docLen.get(id) ?? avgdl
      const lenNorm = (K1 + 1) / (1 + K1 * (1 - B + B * (dl / avgdl)))
      const rel = idfSum > 0 ? (matchedIdf * lenNorm) / (idfSum * (K1 + 1)) : 0
      relOf.set(id, rel)
      if (rel > maxRel) maxRel = rel
    }

    for (const [id, rel] of relOf) {
      const record = this.records.get(id)
      const halfLife = HALF_LIFE_HOURS[record.layer] ?? 168
      // 超级匹配不吃时间衰减：rel 已经到本轮最高分的 85%，
      // 说明这条就是被问的东西，不该因为是一周前的就往后排。
      const recency = rel >= 0.85 * maxRel ? 1 : Math.exp(-decayHours(record.ts, now) / halfLife)
      let src = {
        facts: 1,
        experience: 0.8,
        knowledge: 0.7,
        reflections: 0.6,
        events: 0.5,
        state: 0.4,
      }[record.layer] ?? 0.5
      if (record.layer === 'knowledge' && isExpired(record, now)) src *= 0.3
      let quality = 0.6
      if (record.importance != null) quality = record.importance / 10
      else if (record.conf != null) quality = record.conf
      else if (record.confidence != null) quality = record.confidence
      // 权重是遗忘曲线留下的记忆强度，单独乘，不再混进 quality
      const weight = record.pinned ? 1 : Math.max(0.1, Math.min(1, record.weight ?? 1))
      const weightFactor = 0.4 + 0.6 * weight
      const seen = this.retrieved.get(id) ?? 0
      const score = ((0.45 * rel + 0.25 * recency + 0.2 * quality + 0.1 * src) / (1 + 0.15 * seen)) * weightFactor
      if (score >= minScore) scored.push({ id, score, record })
    }
    scored.sort((a, b) => b.score - a.score)

    // 兜底：路径、URL、版本号这类锚点被分词切碎后匹配不上，用整串子串比一次
    if (scored.length === 0) {
      const needle = String(query).toLowerCase()
      for (const record of this.records.values()) {
        if (!isLive(record, now) || record.archived) continue
        if (allowed && !allowed.has(record.layer)) continue
        for (const anchor of Array.isArray(record.anchors) ? record.anchors : []) {
          const text = String(anchor).toLowerCase()
          if (text.length < 5) continue
          if (needle.includes(text) || text.includes(needle)) {
            scored.push({ id: record.id, score: 0.55, record })
            break
          }
        }
      }
      scored.sort((a, b) => b.score - a.score)
    }

    if (scored.length === 0 && !layers && routeQuery(query) === ROUTE_LAYERS.temporal) {
      return this.of('events')
        .slice(-top)
        .reverse()
        .map((record) => ({ id: record.id, score: 0.3, record }))
    }
    return scored.slice(0, top)
  }

  markRetrieved(ids) {
    for (const id of ids) this.retrieved.set(id, (this.retrieved.get(id) ?? 0) + 1)
  }

  stats() {
    const out = {}
    for (const layer of LAYERS) out[layer] = 0
    for (const record of this.records.values()) out[record.layer] = (out[record.layer] ?? 0) + 1
    return out
  }

  /** 压实：把当前视图写成 snapshot/base.json，再把水位以下的 journal 行清掉。 */
  compact() {
    this.ensure()
    const snapshotDir = path.join(this.dir, 'snapshot')
    fs.mkdirSync(snapshotDir, { recursive: true })
    const entries = []
    for (const record of this.records.values()) {
      entries.push({ op: 'put', layer: record.layer, id: record.id, ts: record.ts, record })
    }
    entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const basePath = path.join(snapshotDir, 'base.json')
    const tmp = `${basePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }))
    fs.renameSync(tmp, basePath)
    const watermark = entries.length ? entries[entries.length - 1].id : null
    fs.writeFileSync(
      path.join(snapshotDir, 'base.meta.json'),
      JSON.stringify({ version: Date.now(), watermark, count: entries.length }),
    )
    if (fs.existsSync(this.file)) {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
      const keep = watermark
        ? lines.filter((line) => {
            try {
              return JSON.parse(line).id > watermark
            } catch {
              return false
            }
          })
        : lines
      fs.writeFileSync(this.file, keep.length ? `${keep.join('\n')}\n` : '')
    }
    return { count: entries.length, watermark }
  }
}
