/**
 * 每日自学：闲的时候上网找点东西，提炼成知识卡。
 * 预算按 flash 计价估，硬上限由配置给。
 */
import { complete, parseJson } from './llm.js'
import { tokenize, ulid } from './store.js'

const IN_PRICE = 1 / 1_000_000
const OUT_PRICE = 2 / 1_000_000
const MAX_CLAIM = 160

const STUDY_PROMPT = ({ topic, page }) => `主题：${topic}
材料：
${page}

提炼 3-5 条知识卡。每条：
- claim：一句结论，不超过 60 字，不含「可能/也许/大概」。
- ttlDays：版本号、API 类 90 天，方法论类 365 天。
- confidence：0-1，材料越一手越高。

没有值得记的就返回 []。不许编，不许把猜测写成结论。
输出 JSON 数组：[{"claim":"...","ttlDays":365,"confidence":0.8}]
不要输出别的。`

const DOMAIN_TOPICS = ['Cordis 插件开发', 'DSH 二次开发', '前端性能', 'LLM 工具调用']

function keywords(text, limit = 12) {
  const counts = new Map()
  for (const term of tokenize(text)) {
    if (term.length < 2) continue
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term)
}

function priceOf(usage) {
  if (!usage) return 0
  return (usage.inputTokens ?? 0) * IN_PRICE + (usage.outputTokens ?? 0) * OUT_PRICE
}

export class Study {
  constructor({ store, llm, model, provider, web, budgetCny = 2, log = () => {} }) {
    this.store = store
    this.llm = llm
    this.model = model
    this.provider = provider
    this.web = web
    this.budget = budgetCny
    this.log = log
  }

  spentToday(now = Date.now()) {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    let total = 0
    for (const record of this.store.of('audit')) {
      if (record.action !== 'study') continue
      if (record.ts < start.getTime()) continue
      total += record.costCny ?? 0
    }
    return total
  }

  pickTopics() {
    const events = this.store.of('events').slice(-30)
    const recent = keywords(events.map((event) => event.summary).join(' '), 8)
    const fromEvents = recent.filter((term) => /[a-z]/.test(term)).slice(0, 2)
    const domain = DOMAIN_TOPICS.filter(() => Math.random() < 0.5).slice(0, 2)
    const topics = [...new Set([...fromEvents, ...domain])]
    if (topics.length === 0) topics.push(DOMAIN_TOPICS[0])
    return topics.slice(0, 4)
  }

  async dedupe(cards) {
    const fresh = []
    for (const card of cards) {
      if (!card?.claim) continue
      const claim = String(card.claim).slice(0, MAX_CLAIM)
      const hits = this.store.search(claim, { layers: ['knowledge'], top: 3 })
      if (hits.length && hits[0].score > 0.8) continue
      fresh.push({ ...card, claim })
    }
    return fresh
  }

  async run({ foreignOk = true } = {}) {
    if (!this.web) return { skipped: 'web-unavailable' }
    const remaining = this.budget - this.spentToday()
    if (remaining <= 0) return { skipped: 'budget-used' }

    const topics = this.pickTopics()
    const written = []
    const log = []

    for (const topic of topics) {
      if (this.spentToday() >= this.budget * 0.8) break
      let search
      try {
        search = await this.web.search({ query: topic, maxResults: 3 })
      } catch (error) {
        log.push({ topic, error: String(error) })
        continue
      }
      for (const source of (search.sources ?? []).slice(0, 2)) {
        if (!foreignOk && !/\.(cn|com\.cn|net\.cn|org\.cn)$/.test(new URL(source.url, 'https://x').hostname)) {
          continue
        }
        if (this.spentToday() >= this.budget * 0.9) break
        let page
        try {
          page = await this.web.fetch({ url: source.url })
        } catch (error) {
          log.push({ topic, url: source.url, error: String(error) })
          continue
        }
        const body = page?.body?.content ?? ''
        if (!body) continue
        const result = await complete(this.llm, {
          provider: this.provider,
          model: this.model,
          system: '你只输出 JSON 数组。',
          prompt: STUDY_PROMPT({ topic, page: body.slice(0, 8000) }),
          maxTokens: 900,
          temperature: 0.2,
        })
        const cost = priceOf(result.usage)
        this.store.put('audit', {
          id: ulid(),
          ts: Date.now(),
          action: 'study',
          topic,
          url: source.url,
          costCny: cost,
          tokens: result.usage
            ? { in: result.usage.inputTokens ?? 0, out: result.usage.outputTokens ?? 0 }
            : undefined,
        })
        if (!result.ok) {
          log.push({ topic, error: result.error })
          continue
        }
        const cards = parseJson(result.text)
        if (!Array.isArray(cards)) continue
        const fresh = await this.dedupe(cards)
        const date = new Date().toISOString().slice(0, 10)
        for (const card of fresh) {
          const knowledge = {
            id: ulid(),
            ts: Date.now(),
            topic,
            claim: card.claim,
            url: source.url,
            title: source.title ?? '',
            fetchedAt: date,
            ttlDays: Number(card.ttlDays) === 90 ? 90 : 365,
            confidence: Math.max(0, Math.min(1, Number(card.confidence) || 0.6)),
            status: 'active',
          }
          this.store.put('knowledge', knowledge)
          written.push(knowledge)
        }
      }
    }

    this.store.put('audit', {
      id: ulid(),
      ts: Date.now(),
      action: 'study',
      topics,
      written: written.length,
      spent: this.spentToday(),
      failures: log.length,
      costCny: 0,
      // 只记条数等于没记：分不清是没网、没 web 服务，还是模型报错
      ...(log.length
        ? {
            firstFailures: log.slice(0, 3).map((item) => ({
              topic: item.topic ?? null,
              error: String(item.error ?? '').slice(0, 200),
            })),
          }
        : {}),
    })
    return { written, topics, failures: log }
  }
}
