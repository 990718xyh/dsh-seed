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
import { ulid } from './store.js'

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

const TOPIC_PROMPT = ({ events, keywords, known }) => `你要给一个 agent 的「自学」环节挑主题。它会拿主题去网上搜资料，把一手材料提炼成知识卡。

它最近在做的事（按时间）：
${events}

从这些事里提炼出的关键词：
${keywords}

它已经知道的知识：
${known}

要求：
- 主题要贴着它最近在做的事走：每个主题都能从上面的关键词里追到来源。
- 主题写成能直接拿去搜索的词组（2-6 个词），不要整句，也不要空泛的大类。
- 不要挑已经知道的内容；不把私事、产品名、日志碎片当主题。
- 只输出 JSON 数组：["主题1","主题2"]`

const OPTIMIZE_PROMPT = ({ cards, known }) => `你在给一个会读论文、会自学的 agent（dsh-seed）做「学了之后怎么改自己」的判断。

这轮从论文里学到的：
${cards}

它已经知道的：
${known}

它当前的已知薄弱点：知识去重弱、审计没有血统、自学只读网页。
要求：
- 从这轮学到的东西里，指出 1-2 条 dsh-seed 自己可以落地的改进（具体到改哪个机制，不要泛泛的「加强记忆」）。
- claim 一句话，不超过 60 字，必须是动作。
- why 一句话，说明依据哪条知识。
- 没有确实值得改的就返回 []。
- 只输出 JSON 数组：[{"claim":"...","why":"..."}]`

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function priceOf(usage) {
  if (!usage) return 0
  return (usage.inputTokens ?? 0) * IN_PRICE + (usage.outputTokens ?? 0) * OUT_PRICE
}

const STOPWORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '就是', '还是', '因为', '所以', '可以', '没有', '一个',
  '什么', '怎么', '现在', '然后', '已经', '需要', '应该', '如果', '虽然', '但是', '并且', '以及',
  '进行', '时间', '今天', '明天', '昨天', '刚才', '这样', '那样', '之后', '之前', '时候', '东西',
  '事情', '问题', '一起', '一直', '可能', '比较', '非常', '真的', '确实', '感觉', '觉得', '知道',
  '看看', '一下', '有些', '这些', '那些', '主要', '根据', '通过', '的话', '不是', '两个', '三个',
])

/**
 * 从最近行为里提关键词：英文按词、中文按二元组统计频次，去虚词和纯数字。
 * 只用于给主题拟定的提示，不要求精确——它是「最近在做什么」的粗粒度信号。
 */
function pickKeywords(text, limit = 12) {
  const counts = new Map()
  const bump = (word) => {
    if (word.length < 2) return
    if (/^[0-9]+$/.test(word)) return
    if (STOPWORDS.has(word)) return
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  const raw = String(text ?? '').toLowerCase()
  for (const word of raw.match(/[a-z][a-z0-9_-]{1,}/g) ?? []) bump(word)
  for (const run of raw.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) bump(run.slice(index, index + 2))
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word)
    .join('、')
}

/** 从模型输出里取主题数组：容忍它是数组、或被包在对象里、或元素是 {topic} 对象。 */
function extractTopics(text) {
  const parsed = parseJson(text)
  let list = parsed
  if (!Array.isArray(list) && parsed && typeof parsed === 'object') {
    list = Object.values(parsed).find((value) => Array.isArray(value)) ?? []
  }
  if (!Array.isArray(list)) return []
  return [
    ...new Set(
      list
        .map((item) => (typeof item === 'string' ? item : (item?.topic ?? item?.name ?? '')))
        .map((item) => String(item ?? '').trim())
        .filter((item) => item.length >= 2 && item.length <= 60),
    ),
  ].slice(0, MAX_TOPICS)
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

/** 论文站：一手材料优先于二手博客。 */
function isPaperUrl(url) {
  try {
    const host = new URL(String(url), 'https://x').hostname
    return /(^|\.)arxiv\.org$/i.test(host) || /(^|\.)aclanthology\.org$/i.test(host) || /(^|\.)openreview\.net$/i.test(host)
  } catch {
    return false
  }
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
      .slice(-40)
      .map((event) => String(event.summary ?? '').slice(0, 100))
      .filter(Boolean)
    const keywords = pickKeywords(events.join('\n'))
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
          keywords: keywords || '（没有明显关键词）',
          known: knownClaims.length ? knownClaims.map((line) => `- ${line}`).join('\n') : '（还没有知识卡）',
        }),
        // 200 不够：模型带思考时，思考 token 会把额度吃光，返回空文本。
        maxTokens: 1200,
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
        const topics = extractTopics(result.text)
        if (topics.length) return topics
      }
      // 拟不出就这一轮不学：宁可空着，也不拿「提交」「用户」这类事件高频词凑数。
      this.store.put('audit', {
        id: ulid(),
        ts: Date.now(),
        action: 'study',
        stage: 'propose-topics',
        failed: true,
        raw: String(result.text ?? '').slice(0, 300),
      })
    }
    return []
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

  /**
   * 学完顺手做一次优化判断：让模型看着这轮从论文里学到的东西，
   * 给出 1-2 条 dsh-seed 自己能落地的改进，写进 experience 层。
   * 这样「学习」和「拿学习结果改自己」是同一轮里完成的。
   */
  async suggestOptimizations(written, reinforced) {
    const learned = [...written, ...reinforced].map((item) => String(item.claim ?? '').slice(0, 70)).filter(Boolean)
    if (!learned.length) return []

    const known = this.store
      .of('knowledge')
      .filter((record) => record.status === 'active')
      .slice(-20)
      .map((record) => String(record.claim ?? '').slice(0, 50))
      .filter(Boolean)

    const result = await complete(this.llm, {
      provider: this.provider,
      model: this.model,
      system: '你只输出 JSON 数组。',
      prompt: OPTIMIZE_PROMPT({
        cards: learned.map((line) => `- ${line}`).join('\n'),
        known: known.length ? known.map((line) => `- ${line}`).join('\n') : '（还没有知识卡）',
      }),
      // 同拟主题：带思考时额度给小了会返回空文本，给足。
      maxTokens: 1200,
      temperature: 0.3,
    })
    this.store.put('audit', {
      id: ulid(),
      ts: Date.now(),
      action: 'study',
      stage: 'optimize',
      costCny: priceOf(result.usage),
      ok: Boolean(result.ok),
      textLen: String(result.text ?? '').length,
      raw: String(result.text ?? '').slice(0, 300),
    })
    if (!result.ok) return []

    const parsed = parseJson(result.text)
    if (!Array.isArray(parsed)) {
      this.store.put('audit', {
        id: ulid(),
        ts: Date.now(),
        action: 'study',
        stage: 'optimize-unparsed',
        preview: String(result.text ?? '').slice(0, 300),
      })
      return []
    }

    const out = []
    for (const item of parsed.slice(0, 2)) {
      const claim = String(item?.claim ?? '').trim().slice(0, 120)
      if (!claim) continue
      const record = {
        id: ulid(),
        ts: Date.now(),
        claim,
        why: String(item?.why ?? '').trim().slice(0, 160),
        source: 'study-optimize',
        status: 'active',
      }
      this.store.put('experience', record)
      out.push(record)
    }
    return out
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

    this.store.put('audit', {
      id: ulid(),
      ts: Date.now(),
      action: 'study',
      stage: 'topics-accepted',
      topics,
      budget: this.budget,
      spent: this.spentToday(),
    })

    for (const topic of topics) {
      if (this.spentToday() >= this.budget * 0.8) break
      this.store.put('audit', {
        id: ulid(),
        ts: Date.now(),
        action: 'study',
        stage: 'topic-start',
        topic,
      })
      // 论文优先：先按「topic arxiv」搜；搜不到再退回普通搜索。
      // 结果里论文站排前面——一手材料比二手博客转述更值得进知识层。
      let search
      try {
        search = await this.web.search({ query: `${topic} arxiv`, maxResults: 4 })
      } catch (error) {
        log.push({ topic, error: String(error) })
        continue
      }
      let sources = (search.sources ?? []).slice()
      this.store.put('audit', {
        id: ulid(),
        ts: Date.now(),
        action: 'study',
        stage: 'search-result',
        topic,
        count: sources.length,
        keys: Object.keys(search ?? {}).slice(0, 12),
        preview: JSON.stringify(search ?? null).slice(0, 500),
      })
      if (!sources.length) {
        // 搜不到时把返回结构记下来：分得清是后端没结果、字段名变了，还是搜索不可用
        this.store.put('audit', {
          id: ulid(),
          ts: Date.now(),
          action: 'study',
          stage: 'search-empty',
          query: `${topic} arxiv`,
          keys: Object.keys(search ?? {}).slice(0, 12),
          preview: JSON.stringify(search ?? null).slice(0, 400),
        })
        try {
          search = await this.web.search({ query: topic, maxResults: 3 })
          sources = (search.sources ?? []).slice()
        } catch (error) {
          log.push({ topic, error: String(error) })
          continue
        }
      }
      sources.sort((a, b) => Number(isPaperUrl(b.url)) - Number(isPaperUrl(a.url)))
      this.store.put('audit', {
        id: ulid(),
        ts: Date.now(),
        action: 'study',
        stage: 'source-loop-enter',
        count: sources.length,
        first: sources[0]?.url ?? null,
      })
      for (const source of sources.slice(0, 2)) {
        this.store.put('audit', {
          id: ulid(),
          ts: Date.now(),
          action: 'study',
          stage: 'source-enter',
          url: source.url,
          foreignOk,
        })
        // 论文站不受 overseas 限制：学论文是明确目的，且一手材料只在这些站上。
        // overseas=false 仍然挡住境外普通网页（博客、新闻）。
        if (!foreignOk && !isPaperUrl(source.url) && !/\.(cn|com\.cn|net\.cn|org\.cn)$/.test(new URL(source.url, 'https://x').hostname)) {
          this.store.put('audit', {
            id: ulid(),
            ts: Date.now(),
            action: 'study',
            stage: 'source-foreign-skip',
            url: source.url,
          })
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
        if (!body) {
          // 抓到页面但没正文：把返回结构记下来，分得清是抓取失败还是结构变了
          this.store.put('audit', {
            id: ulid(),
            ts: Date.now(),
            action: 'study',
            stage: 'fetch-empty',
            url: source.url,
            keys: Object.keys(page ?? {}).slice(0, 12),
            bodyKeys: Object.keys(page?.body ?? {}).slice(0, 12),
            preview: JSON.stringify(page ?? null).slice(0, 400),
          })
          continue
        }
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

    // 学完顺手做优化：把学到的用于指出自己该改什么，写进 experience 层。
    // 学习与自我改进在同一轮完成，不用等下一次会话。
    let optimizations = []
    try {
      optimizations = await this.suggestOptimizations(written, reinforced)
    } catch (error) {
      log.push({ topic: 'optimize', error: String(error) })
    }

    this.store.put('audit', {
      id: ulid(),
      ts: Date.now(),
      action: 'study',
      topics,
      written: written.length,
      reinforced: reinforced.length,
      optimizations: optimizations.length,
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
    return { written, reinforced, topics, failures: log, optimizations }
  }
}
