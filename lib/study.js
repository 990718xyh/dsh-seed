/**
 * 每日自学：闲的时候上网找点东西，提炼成知识卡。
 * 预算按 flash 计价估，硬上限由配置给。
 *
 * 两个关键门槛（都可以在 config 里改）：
 * 1. 主题由模型自己拟：看完最近的事和已有知识后提出「值得学且还没学过」的方向，
 *    不再用写死的领域词表——那会把 spokenbucket 这类事件里的噪声词当主题。
 * 2. 知识卡按文字相似度合并：同一个知识点换个说法再来，算复证（提置信度、记来源），
 *    不再新增一条。阈值见 similarityThreshold。
 */
import { complete, parseJson } from './llm.js'
import { tokenize, ulid } from './store.js'

const IN_PRICE = 1 / 1_000_000
const OUT_PRICE = 2 / 1_000_000
const MAX_CLAIM = 160

/** 默认相似度阈值：两条 claim 的字符二元组 Jaccard 相似度到这个值就当同一个知识点。 */
const SIMILARITY_THRESHOLD = 0.62
const MAX_TOPICS = 3
const MAX_CARDS_PER_FETCH = 4
/** 复证一次加多少置信度，以及封顶。 */
const REINFORCE_STEP = 0.05
const CONFIDENCE_CAP = 0.9
const MIN_CONFIDENCE = 0.3

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

const TOPIC_PROMPT = ({ events, known }) => `你要给一个 agent 的「自学」环节挑主题。它会拿主题去网上搜资料，把一手材料提炼成知识卡。

最近发生的事（按时间）：
${events}

已经知道的知识：
${known}

要求：
- 挑 2-3 个「查得到一手资料、对做开发或干活有用」的主题。
- 不要挑已经知道的内容，也不要把事件里的私事、产品名、日志碎片当主题。
- 主题写成能直接拿去搜索的词组，不要整句。
- 只输出 JSON 数组：["主题1","主题2"]`

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function priceOf(usage) {
  if (!usage) return 0
  return (usage.inputTokens ?? 0) * IN_PRICE + (usage.outputTokens ?? 0) * OUT_PRICE
}

/** 去掉空白和标点，只留下真正承载语义的字符。 */
function normalizeClaim(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 字符二元组，用来算两条中文/混排 claim 的重合度。 */
function bigrams(text) {
  const chars = [...normalizeClaim(text)]
  const grams = new Set()
  for (let i = 0; i < chars.length - 1; i += 1) grams.add(chars[i] + chars[i + 1])
  if (!grams.size && chars.length) grams.add(chars[0])
  return grams
}

export function claimSimilarity(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let shared = 0
  for (const gram of A) if (B.has(gram)) shared += 1
  return shared / (A.size + B.size - shared)
}

function mergeSources(record, source) {
  const list = Array.isArray(record.sources) ? record.sources.slice() : []
  if (record.url) list.unshift({ url: record.url, title: record.title ?? '' })
  if (source?.url && !list.some((item) => item.url === source.url)) {
    list.push({ url: source.url, title: source.title ?? '' })
  }
  return list.slice(0, 5)
}

export class Study {
  constructor({ store, llm, model, provider, web, budgetCny = 2, similarityThreshold = SIMILARITY_THRESHOLD, log = () => {} }) {
    this.store = store
    this.llm = llm
    this.model = model
    this.provider = provider
    this.web = web
    this.budget = budgetCny
    this.similarityThreshold = clamp(Number(similarityThreshold) || SIMILARITY_THRESHOLD, 0.3, 0.95)
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

  /** 让模型根据最近的事和已有知识自己拟主题；拟不出就返回空，不乱学。 */
  async proposeTopics() {
    const events = this.store
      .of('events')
      .slice(-30)
      .map((event) => String(event.summary ?? '').slice(0, 80))
      .filter(Boolean)
    const knownClaims = this.store
      .of('knowledge')
      .filter((record) => record.status === 'active')
      .slice(-30)
      .map((record) => String(record.claim ?? '').slice(0, 60))
      .filter(Boolean)

    if (events.length) {
      const result = await complete(this.llm, {
        provider: this.provider,
        model: this.model,
        system: '你只输出 JSON 数组。',
        prompt: TOPIC_PROMPT({
          events: events.map((line) => `- ${line}`).join('\n'),
          known: knownClaims.length ? knownClaims.map((line) => `- ${line}`).join('\n') : '（还没有知识卡）',
        }),
        maxTokens: 200,
        temperature: 0.3,
      })
      this.store.put('audit', {
        id: ulid(),
        ts: Date.now(),
        action: 'study',
        stage: 'propose-topics',
        costCny: priceOf(result.usage),
        topics: result.ok ? undefined : 'failed',
      })
      if (result.ok) {
        const parsed = parseJson(result.text)
        if (Array.isArray(parsed)) {
          const topics = parsed
            .map((item) => String(item ?? '').trim())
            .filter((item) => item.length >= 2 && item.length <= 40)
          if (topics.length) return [...new Set(topics)].slice(0, MAX_TOPICS)
        }
      }
    }

    // 模型拟不出主题时退一步：只从最近事件里取出现过两次以上的中文词组，仍然不硬凑。
    const counts = new Map()
    for (const event of this.store.of('events').slice(-30)) {
      for (const term of tokenize(String(event.summary ?? ''))) {
        if (term.length < 2 || !/[\u4e00-\u9fa5]/.test(term)) continue
        counts.set(term, (counts.get(term) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TOPICS)
      .map(([term]) => term)
  }

  /**
   * 把新提炼的卡并进知识层：跟已有知识（以及本批已接受的卡）比文字相似度。
   * 相似的算复证——不新增，提置信度、记来源；不相似的才写新卡。
   */
  async reconcile(cards, source) {
    const existing = this.store.of('knowledge').filter((record) => record.status === 'active')
    const fresh = []
    const reinforced = []
    const accepted = []

    for (const card of (cards ?? []).slice(0, MAX_CARDS_PER_FETCH)) {
      if (!card?.claim) continue
      const claim = String(card.claim).slice(0, MAX_CLAIM)
      const confidence = clamp(Number(card.confidence) || 0.6, 0, 1)
      if (confidence < MIN_CONFIDENCE) continue

      let best = null
      let bestSimilarity = 0
      for (const record of [...existing, ...accepted]) {
        const similarity = claimSimilarity(claim, record.claim ?? record.text ?? '')
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity
          best = record
        }
      }

      if (best && bestSimilarity >= this.similarityThreshold) {
        const updated = {
          ...best,
          confidence: Math.min(CONFIDENCE_CAP, Number(best.confidence ?? 0.6) + REINFORCE_STEP),
          seenCount: (best.seenCount ?? 1) + 1,
          lastSeenAt: Date.now(),
          sources: mergeSources(best, source),
          status: 'active',
        }
        this.store.put('knowledge', updated)
        reinforced.push({ claim: updated.claim, similarity: Number(bestSimilarity.toFixed(3)), confidence: updated.confidence })
        const index = existing.findIndex((record) => record.id === updated.id)
        if (index >= 0) existing[index] = updated
        continue
      }

      const knowledge = {
        id: ulid(),
        ts: Date.now(),
        topic: source?.topic ?? '',
        claim,
        url: source?.url ?? '',
        title: source?.title ?? '',
        fetchedAt: new Date().toISOString().slice(0, 10),
        ttlDays: Number(card.ttlDays) === 90 ? 90 : 365,
        confidence,
        seenCount: 1,
        sources: source?.url ? [{ url: source.url, title: source.title ?? '' }] : [],
        status: 'active',
      }
      this.store.put('knowledge', knowledge)
      fresh.push(knowledge)
      accepted.push(knowledge)
    }

    return { fresh, reinforced }
  }

  async run({ foreignOk = true } = {}) {
    if (!this.web) return { skipped: 'web-unavailable' }
    const remaining = this.budget - this.spentToday()
    if (remaining <= 0) return { skipped: 'budget-used' }

    const topics = await this.proposeTopics()
    if (!topics.length) {
      this.store.put('audit', {
        id: ulid(),
        ts: Date.now(),
        action: 'study',
        topics: [],
        written: 0,
        skipped: 'no-topics',
        spent: this.spentToday(),
        costCny: 0,
      })
      return { skipped: 'no-topics', written: [], topics: [], failures: [] }
    }

    const written = []
    const reinforced = []
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
          stage: 'extract',
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
        const merged = await this.reconcile(cards, { topic, url: source.url, title: source.title ?? '' })
        written.push(...merged.fresh)
        reinforced.push(...merged.reinforced)
      }
    }

    this.store.put('audit', {
      id: ulid(),
      ts: Date.now(),
      action: 'study',
      topics,
      written: written.length,
      reinforced: reinforced.length,
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
    return { written, reinforced, topics, failures: log }
  }
}
