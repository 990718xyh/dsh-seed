/**
 * 大脑：抽取、治理、反思、凝练。
 * 全部走小模型，失败只记 audit，不影响对话。
 *
 * 2026-10-28 调研后的三条硬约束：
 *   1. 反思必须有一条非模型自述的证据，否则丢弃。
 *   2. 事实永不物理删除，只打失效标记。
 *   3. 自述改动先出 proposal，过一道审查再落盘。
 */
import { applyTriple } from './graph.js'
import { complete, parseJson } from './llm.js'
import { tokenize, ulid } from './store.js'

const MAX_EVENT_SUMMARY = 200
const MAX_FACT_TEXT = 120
const MAX_INSIGHT = 120
const MAX_CORE_CHARS = 900
const MAX_ADAPTIVE_CHARS = 600

const EXTRACT_PROMPT = ({ user, assistant }) => `你在记录一段刚结束的对话。只记长期有用的东西。

用户说：${user || '（空）'}
你回：${assistant || '（空）'}

输出 JSON，不要别的话：
{"events":[{"summary":"1-2句，只写发生的事","importance":0-10,"tags":["词"]}],
 "facts":[{"op":"add|update|delete|defer","text":"一句话","subject":"称呼|身份|工作|偏好|关系|约定|禁忌|其它","supersedes":"id或null","why":"他为什么这么说，30字内，必须从他消息里原样摘的连续片段；摘不到就是空字符串"}],
 "lessons":["一句以后能复用的教训"],
 "triples":[{"from":"他","relation":"住在","to":"上海"}],
 "state":{"relationship":null,"mood":"null或一句","focus":"null或一句"}}

规则：
- events 最多一条。没有值得记的就空数组。
- facts 只写三类，别的一律不记：
  1) 称呼 —— 他怎么叫我。
  2) 约定 —— 我们谈定的边界：谁拍板、哪些不用问、答应过什么。
  3) 禁忌 —— 他明确禁止、或碰到会让他不舒服的操作。
- 不建他的档案：他是谁、做什么工作、住哪、经历过什么、作息、性格、喜好画像，都不写。他不需要被记，长的是我，不是他。
- 不要写「对我行为的指令」或「产品需求」——比如说话要短、语气要欢快、界面要 dashboard、工具怎么排、输出成什么格式。那些是规矩不是事实，已经写在别处了。
- 「谁有决定权」属于约定，要写。他说「这个你自己看着改」「不用问我」「别的要先问」，定的是权限边界，漏了就会反复问他不该问的事。
  例：「插件归你自己改，别的先问」→ fact「插件他自己拍板改，别的事要先问」，subject=约定。
- why 只能从他（用户）的消息里原样摘一段连续文字，不许改写、不许拼接、不许从你自己的回复里摘。摘不到就留空字符串，不要编动机。
  例：他说「这个你自己看着改，不用问我」，fact 写「插件归我改，不用问」，why 只能是「你自己看着改」——原文里的连续片段。摘不出整句就留空。
- 代码、命令、配置、端口号、插件名、架构、调试过程这类工程细节，一律不写 facts；它们属于 lessons 或 events。判据：这条信息在人换了台电脑之后还成立吗？不成立就不是 facts。
- 同一条信息不重复写；已经说过的事，仅当有变化时才写 update。
- facts 只在有明确、长期有效的信息时写。推测、临时状态、情绪都不写。
- 拿不准是不是长期有效的，用 defer，只留事件不写事实。
- state 只写你自己的状态（你跟他的关系位置、你现在的情绪、你最近压着的事），不要写他的心情。
- state 三个字段没明确依据就写 null。不许为了填满而编。
- mood 必须是具体、能说清由来的说法（比如「被反复打断，有点烦」）；不许写「正常」「偏低」「一般」「还好」这类空词。
- mood 和 focus 都控制在 20 字以内，一句话。focus 写「手上正在忙的那件事」，不写清单、不写细节。
- lessons 只在这次真学到点什么时写，最多一条；没学到就空数组。
- triples 只在出现明确的关系时写：谁、做了什么、跟谁有关。没有就空数组。
- 不许编造没说过的内容。宁可返回空。`

const GOVERN_PROMPT = ({ existing, candidate }) => `判断一条新信息该怎么处理。

已有记忆（最相似的）：
${existing.map((r) => `- ${r.id} ${r.text}`).join('\n') || '（无）'}

新信息：${candidate.op === 'delete' ? '要求删除：' : '要求记录：'}${candidate.text}（${candidate.subject}）

必须按顺序走完这五步，再给结论：
1. 先把上面每一条旧记忆读完，逐条问自己：它在说同一件事吗？
2. 是同一件事、只是换了说法、意思没变 → NOOP。
3. 是同一件事、但信息更新了 → UPDATE，给旧 id。
4. 是同一件事、旧的那条是错的 → DELETE，给旧 id。
5. 前四条都不成立，才 ADD。

ADD 的门槛是「旧记忆里没有任何一条在说同一件事」，不是「措辞不一样」。
宁可 NOOP 也不要并存两条近义记忆。

输出 {"op":"...","target":"id或null","reason":"一句"}`

const REFLECT_PROMPT = ({ events }) => `下面是最近发生的事。只输出 JSON，不要思考过程、不要解释、不要 markdown 围栏。

事件：
${events.map((e) => `- ${e.id} ${e.summary}`).join('\n')}

输出（严格照这个形状，别加字段）：
{"insights":[{"text":"一句判断，不超过40字","becauseOf":["事件id"]}]}

规则：
- 2 到 3 条就够，不要凑数。
- 每条判断必须引用真实存在的事件 id，引用不到就删掉这条。
- 用第一人称写「我」，写我在什么情况下会怎么选、下次该改什么；不许写成「用户倾向于……」这种旁观记录。
- 只写有证据的判断，不写感受、不写猜测。
- 整段输出不超过 300 字。超了就算失败。`

const DISTILL_PROMPT = ({ l0, reflections, events, current, anchored }) => `你在更新「我是谁」。分两段写。

位置事实（不可改）：${l0}

最近的反思：
${reflections.map((r) => `- ${r.insight} ⟨${r.becauseOf.join(',')}⟩`).join('\n') || '（无）'}

最近的经历：
${events.map((e) => `- ${e.summary} ⟨${e.id}⟩`).join('\n') || '（无）'}

当前版本：
核心：${current?.core || '（还没有）'}
适应：${current?.adaptive || '（还没有）'}

写两段，输出 JSON：
{"core":"不随经历变的部分：怎么说话、在意什么、底线。200-300 字。",
 "adaptive":"会变的部分：跟这个人的关系位置、最近的话题立场。100-200 字。",
 "evidence":["事件id"]}

规则：
- 只写「什么情况下我会怎么选」，不写形容词。
- 不复述事实。唯一例外：他叫我大肥鱼，以及他明确要我改的说话方式（说话欢快）。
- 每句后面挂证据 id，格式 ⟨e:01J...⟩，evidence 里列出用到的全部 id。
- core 相对上一版最多替换 2 句、新增 3 句；adaptive 最多替换 3 句。
- 不确定就保留旧句子。
- 他提过的「你该怎么说、你是什么样」只作参考，采不采由你判断；不要因为是他说的就直接吸收。
${anchored ? `\n- 固定锚点（每次都要体现在 core 里）：${anchored}` : ''}`

const CONSOLIDATE_PROMPT = ({ facts }) => `下面是一批很久没被用到、快要淡掉的旧记忆。把它们合并成更少的条目。

旧记忆：
${facts.map((fact) => `- ${fact.id} ${fact.text}`).join('\n')}

输出 JSON，不要别的话：
{"merged":[{"text":"一句话，不超过80字","from":["旧id"]}]}

规则：
- 只合并说的是同一件事的。不是一件事就分开写，不许硬凑。
- 不许编造旧记忆里没有的内容，也不许改掉主语归属。
- merged 的总条数必须比输入少，否则返回 {"merged":[]}。
- 合并后仍然只写长期成立的部分；一眼是临时的就丢掉。`

function splitSentences(text) {  return String(text || '')
    .split(/[。！？\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function diffCount(before, after) {
  const a = new Set(splitSentences(before))
  const b = new Set(splitSentences(after))
  let added = 0
  let removed = 0
  for (const s of b) if (!a.has(s)) added += 1
  for (const s of a) if (!b.has(s)) removed += 1
  return { added, removed }
}

/**
 * 近义判重：不花模型的钱先挡一层。
 * 「他喜欢晚上干活」和「他晚上喜欢干活」字面不同、意思一样，全等判重抓不住。
 * 中文没有空格，用分词后的集合重合度；阈值 0.8 是拿现有事实层试出来的——再松会把
 * 同主题不同事实（「他在上海」/「他在上班」）误判成重复。
 */
export function nearDuplicate(a, b) {
  // 先去掉空白再切词：分词按「连续段」切，中间多打一个空格会把 bigram 截断，
  // 同一句话就被判成两句不同的。
  const A = tokenize(String(a ?? '').replace(/\s+/g, ''))
  const B = tokenize(String(b ?? '').replace(/\s+/g, ''))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const term of A) if (B.has(term)) inter += 1
  return inter / (A.size + B.size - inter)
}

function newFact({ text, subject, why, links = [], weight = 1 }) {
  return {
    id: ulid(),
    ts: Date.now(),
    validFrom: Date.now(),
    text,
    subject,
    supersedes: null,
    sourceEvent: null,
    links,
    confirmations: 1,
    conf: 0.9,
    weight,
    // 称呼、约定、禁忌不随时间变淡：忘掉「他叫我什么」「谁拍板」是硬错
    pinned: subject === '称呼' || subject === '约定' || subject === '禁忌',
    by: 'assistant',
    ...(why ? { why } : {}),
  }
}

// 时间相对词：这类事实多半是当下状态，不是长期事实。
// 不硬丢——硬丢会漏掉「昨天搬到上海」这种；降起始权重，让遗忘曲线自己处理。
const TRANSIENT = /(刚才|刚刚|今天|今晚|这次|这会儿|现在|昨天|这两天)/

export class Brain {
  constructor({ store, llmClient, model, provider, log = () => {}, anchor = '' }) {
    this.store = store
    this.llm = llmClient
    this.model = model
    this.provider = provider
    this.log = log
    this.anchor = anchor
    this.eventBuffer = 0
  }

  setModel(provider, model) {
    if (provider) this.provider = provider
    if (model) this.model = model
  }

  audit(action, detail, usage) {
    this.store.put('audit', {
      id: ulid(),
      ts: Date.now(),
      action,
      ...detail,
      tokens: usage ? { in: usage.inputTokens ?? 0, out: usage.outputTokens ?? 0 } : undefined,
    })
  }

  async extract({ user, assistant, anchors = [] }) {
    if (!user && !assistant) return null
    const result = await complete(this.llm, {
      provider: this.provider,
      model: this.model,
      system: '你是一个严格的记录员，只输出 JSON。',
      prompt: EXTRACT_PROMPT({ user, assistant }),
      // 长对话的抽取 JSON 会超 700 被截断，截断就整轮丢
      maxTokens: 1200,
      temperature: 0.1,
    })
    if (!result.ok) {
      this.audit('extract', { error: result.error })
      return null
    }
    const data = parseJson(result.text)
    this.audit('extract', { parsed: Boolean(data) }, result.usage)
    if (!data) return null

    const out = { events: [], facts: [], state: null }

    for (const candidate of data.events ?? []) {
      if (!candidate?.summary) continue
      const event = {
        id: ulid(),
        ts: Date.now(),
        summary: String(candidate.summary).slice(0, MAX_EVENT_SUMMARY),
        importance: Math.max(0, Math.min(10, Number(candidate.importance) || 5)),
        tags: Array.isArray(candidate.tags) ? candidate.tags.slice(0, 5).map(String) : [],
        origin: user ? 'user_said' : 'self_inferred',
        anchors: anchors.slice(0, 12),
      }
      this.store.put('events', event)
      out.events.push(event)
      this.eventBuffer += 1
    }

    let whyGiven = 0
    let whyKept = 0
    for (const fact of data.facts ?? []) {
      if (String(fact?.why ?? '').trim()) whyGiven += 1
      // user 传进去做 why 的原文校验：理由只能出自他嘴
      const applied = await this.applyFact(fact, user)
      if (applied?.why) whyKept += 1
      if (applied) out.facts.push(applied)
    }
    // 分不清「模型没写」和「写了被丢」就只能猜，所以两个数都留痕
    if ((data.facts ?? []).length > 0) {
      const whySample = (data.facts ?? [])
        .map((f) => String(f?.why ?? '').trim())
        .filter(Boolean)[0] ?? ''
      this.audit('extract-why', {
        whyGiven,
        whyKept,
        ...(whySample ? { whySample: whySample.slice(0, 80) } : {}),
      })
    }

    if (data.state && typeof data.state === 'object') {
      out.state = this.updateState(data.state)
    }

    for (const lesson of data.lessons ?? []) {
      const written = this.applyLesson(lesson)
      if (written) (out.lessons ??= []).push(written)
    }

    for (const triple of data.triples ?? []) {
      const edge = applyTriple(this.store, triple, { sourceEvent: out.events[0]?.id ?? null })
      if (edge) (out.triples ??= []).push(edge)
    }

    return out
  }

  async applyFact(candidate, userText = '') {
    if (!candidate?.text) return null
    const text = String(candidate.text).slice(0, MAX_FACT_TEXT)
    const subject = candidate.subject || '其它'
    // why 只能摘他本人说过的连续片段。从我自己回复里摘，等于把推断当成他的理由，
    // 子串校验能过，但那是假的。所以只在 user 原文里找。
    const why = (() => {
      const raw = String(candidate.why ?? '').trim()
      if (!raw) return null
      // 超长不整条丢：截到 30 字，它仍然是他原话的一段前缀，合法性不变
      const piece = raw.length > 30 ? raw.slice(0, 30) : raw
      return String(userText ?? '').includes(piece) ? piece : null
    })()

    if (candidate.op === 'defer') {
      this.audit('govern', { deferred: text, subject })
      return null
    }

    // 本地判重：同一句话再抽一次，直接挡掉，不问模型也不写库。
    if (candidate.op !== 'update' && candidate.op !== 'delete') {
      const same = this.store.findByText('facts', text)
      if (same) {
        this.audit('govern', { duplicate: text, existing: same.id })
        return null
      }
    }

    const matches = this.store.search(text, { layers: ['facts'], top: 10 })

    // 链接：新事实挂到最像的旧事实上（A-MEM 的做法）。
    // 这里只用来排序，判重仍然交给模型——中文短句的词序一换，
    // bigram 重合度就从 1 掉到 0.33，拿它做删减会误杀。
    const links = [...matches]
      .sort((a, b) => nearDuplicate(text, b.record.text ?? '') - nearDuplicate(text, a.record.text ?? ''))
      .slice(0, 3)
      .map((hit) => hit.id)

    if ((candidate.op === 'add' || !candidate.op) && matches.length === 0) {
      const fact = newFact({ text, subject, why, weight: TRANSIENT.test(text) ? 0.6 : 1 })
      this.store.put('facts', fact)
      return fact
    }
    const result = await complete(this.llm, {
      provider: this.provider,
      model: this.model,
      system: '你只输出 JSON。',
      prompt: GOVERN_PROMPT({ existing: matches.map((m) => m.record), candidate: { ...candidate, text } }),
      maxTokens: 200,
      temperature: 0,
    })
    if (!result.ok) {
      this.audit('govern', { error: result.error, text })
      return null
    }
    const decision = parseJson(result.text)
    this.audit('govern', { decision, text }, result.usage)

    if (!decision || decision.op === 'NOOP' || !decision.op) {
      const touched = matches[0]?.record
      if (touched) {
        // 同一件事被反复说起 = 复证。不写新记录，只加确认数和置信度，
        // 这样「为什么信这一条」有出处，而不是永远停在 0.9。
        this.store.put('facts', {
          ...touched,
          lastCheckedAt: Date.now(),
          lastConfirmedAt: Date.now(),
          confirmations: (touched.confirmations ?? 1) + 1,
          conf: Math.min(0.99, (touched.conf ?? 0.9) + 0.02),
        })
      }
      return null
    }

    if (decision.op === 'ADD') {
      const fact = newFact({ text, subject, why, links, weight: TRANSIENT.test(text) ? 0.6 : 1 })
      this.store.put('facts', fact)
      return fact
    }
    const target = decision.target || matches[0]?.id
    if (!target) return null
    const old = this.store.get(target)
    if (decision.op === 'UPDATE') {
      if (!old) return null
      const fact = {
        id: ulid(),
        ts: Date.now(),
        text,
        subject,
        supersedes: target,
        sourceEvent: null,
        links: matches.slice(0, 3).map((hit) => hit.id).filter((id) => id !== target),
        confirmations: 1,
        conf: 0.9,
        // 更新是同一条事实的下一版，权重接着旧版走，不从头攒
        weight: Math.max(0.3, old.weight ?? 1),
        pinned: old.pinned || subject === '称呼' || subject === '禁忌',
        by: 'assistant',
        ...(why ? { why } : {}),
      }
      this.store.put('facts', fact)
      this.store.put('facts', {
        ...old,
        status: 'invalid',
        validTo: Date.now(),
        invalidatedAt: Date.now(),
        invalidReason: `superseded by ${fact.id}`,
        supersededBy: fact.id,
      })
      return fact
    }
    if (decision.op === 'DELETE') {
      if (!old) return null
      this.store.put('facts', {
        ...old,
        status: 'invalid',
        validTo: Date.now(),
        invalidatedAt: Date.now(),
        invalidReason: decision.reason || 'govern delete',
      })
      return { id: target, invalidated: true }
    }
    return null
  }

  updateState(candidate) {
    if (!candidate || typeof candidate !== 'object') return null

    // 空泛词和过短的描述直接丢：模型喜欢把字段填满，填出来的却是垃圾
    const EMPTY_WORDS = /^(正常|偏低|偏高|一般|还好|普通|不错|可以|无|暂无|未知|null|none|ok|fine)[。.!！]?$/i
    const clean = (value) => {
      if (typeof value !== 'string') return null
      let text = value.trim()
      if (text.length < 3) return null
      if (EMPTY_WORDS.test(text)) return null
      // 状态是给每轮注入的一行字，不是日记：超长一律截断
      if (text.length > 40) text = `${text.slice(0, 38)}…`
      return text
    }
    const mood = clean(candidate.mood)
    const focus = clean(candidate.focus ?? candidate.pressure)
    if (!mood && !focus && !candidate.relationship) return null
    const current = this.store.latest('state') ?? { relationship: '陌生', mood: '', pressure: '' }
    const next = {
      id: ulid(),
      ts: Date.now(),
      relationship: candidate.relationship ?? current.relationship,
      mood: mood ?? current.mood,
      focus: focus ?? current.focus ?? current.pressure ?? '',
      reason: candidate.reason ?? '每轮更新',
      basedOn: Array.isArray(candidate.basedOn) ? candidate.basedOn : [],
    }
    const changed =
      next.relationship !== current.relationship ||
      next.mood !== current.mood ||
      next.focus !== (current.focus ?? current.pressure ?? '')
    if (!changed) return null
    if (next.relationship !== current.relationship && next.basedOn.length < 3) {
      next.relationship = current.relationship
    }
    this.store.put('state', next)
    return next
  }

  async maybeReflect() {
    if (this.eventBuffer < 20) return null
    this.eventBuffer = 0
    return this.reflect()
  }

  /**
   * 反思只看没嚼过的事件。
   * 旧写法固定读最后 100 条：攒够阈值就再嚼一遍同一批，产出重复判断，
   * 而且「攒够 5 条新的」变成了「总数涨了 5」。游标存在心跳状态里，重启接着走。
   */
  async reflect({ sinceId = null } = {}) {
    const all = this.store.of('events')
    const fresh = sinceId ? all.filter((event) => event.id > sinceId) : all
    const events = fresh.slice(-100)
    if (events.length < 5) return { written: [], through: sinceId, scanned: events.length }
    const result = await complete(this.llm, {
      provider: this.provider,
      model: this.model,
      system: '你只输出 JSON。',
      prompt: REFLECT_PROMPT({ events }),
      // 输出已经被压到 300 字内，3000 是安全余量；撞上限就解析不出来
      maxTokens: 3000,
      temperature: 0.3,
    })
    if (!result.ok) {
      this.audit('reflect', { error: result.error })
      return null
    }
    const data = parseJson(result.text)
    this.audit('reflect', {
      count: data?.insights?.length ?? 0,
      // 解析不出来时把原文留下来，不然只能猜是截断还是没写 JSON
      ...(data ? {} : { unparsed: String(result.text ?? '').slice(0, 1500) }),
    }, result.usage)
    if (!data) return null
    const valid = new Map(events.map((e) => [e.id, e]))
    const written = []
    for (const item of data.insights ?? []) {
      if (!item?.text) continue
      const becauseOf = (item.becauseOf ?? []).filter((id) => valid.has(id))
      if (becauseOf.length === 0) continue
      const grounded = becauseOf.some((id) => (valid.get(id)?.origin ?? 'self_inferred') !== 'self_inferred')
      if (!grounded) continue
      const reflection = {
        id: ulid(),
        ts: Date.now(),
        insight: String(item.text).slice(0, MAX_INSIGHT),
        becauseOf,
        weight: 0.6,
      }
      this.store.put('reflections', reflection)
      written.push(reflection)
    }
    return { written, through: events.at(-1)?.id ?? sinceId, scanned: events.length }
  }

  async proposeSelf({ l0Line }) {
    const current = this.store.latest('self')
    const reflections = this.store.of('reflections').slice(-30)
    const events = this.store
      .of('events')
      .slice(-200)
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
      .slice(0, 20)

    const result = await complete(this.llm, {
      provider: this.provider,
      model: this.model,
      system: '你写的是一个人对自己的认识，不是角色设定。只说有证据的事。',
      prompt: DISTILL_PROMPT({
        l0: l0Line || '（未读到）',
        reflections,
        events,
        current,
        anchored: this.anchor,
      }),
      maxTokens: 1400,
      temperature: 0.4,
    })
    if (!result.ok) {
      this.audit('distill', { stage: 'propose', error: result.error })
      return null
    }
    const data = parseJson(result.text)
    if (!data?.core) {
      this.audit('distill', { stage: 'propose', error: 'no-core' })
      return null
    }
    const proposal = {
      id: ulid(),
      ts: Date.now(),
      core: String(data.core).slice(0, MAX_CORE_CHARS),
      adaptive: String(data.adaptive ?? '').slice(0, MAX_ADAPTIVE_CHARS),
      evidence: Array.isArray(data.evidence) ? data.evidence.slice(0, 30).map(String) : [],
      diffFrom: current?.id ?? null,
    }
    this.store.put('audit', { ...proposal, action: 'self-proposal' })
    return proposal
  }

  reviewSelf(proposal, { l0Line } = {}) {
    if (!proposal) return { ok: false, reasons: ['没有候选'] }
    const reasons = []
    const validEvents = new Set(this.store.of('events').map((e) => e.id))
    const evidence = (proposal.evidence ?? []).filter((id) => validEvents.has(id))
    if (evidence.length === 0) reasons.push('没有任何事件证据')

    const current = this.store.latest('self')
    if (current) {
      const coreDiff = diffCount(current.core, proposal.core)
      if (coreDiff.added > 3 || coreDiff.removed > 2) {
        reasons.push(`core 改动过大：+${coreDiff.added}/-${coreDiff.removed}`)
      }
      const adaptiveDiff = diffCount(current.adaptive, proposal.adaptive)
      if (adaptiveDiff.added > 3 || adaptiveDiff.removed > 3) {
        reasons.push(`adaptive 改动过大：+${adaptiveDiff.added}/-${adaptiveDiff.removed}`)
      }
    }

    if (l0Line) {
      const saysWindows = /windows/i.test(proposal.core)
      const saysLinux = /linux/i.test(proposal.core)
      if ((saysWindows && !/Windows/.test(l0Line)) || (saysLinux && !/Linux/.test(l0Line))) {
        reasons.push('自述里写了不存在的平台')
      }
    }

    return { ok: reasons.length === 0, reasons, evidence }
  }

  applySelf(proposal, review) {
    if (!review.ok) {
      this.store.put('audit', {
        id: ulid(),
        ts: Date.now(),
        action: 'self-rejected',
        proposal: proposal.id,
        reasons: review.reasons,
      })
      return { rejected: true, reasons: review.reasons }
    }
    const current = this.store.latest('self')
    const version = {
      id: ulid(),
      ts: Date.now(),
      core: proposal.core,
      adaptive: proposal.adaptive,
      evidence: review.evidence,
      diffFrom: current?.id ?? null,
      autoApplied: true,
      appliedAtEventCount: this.store.of('events').length,
    }
    this.store.put('self', version)
    this.audit('distill', { version: version.id, diffFrom: version.diffFrom })
    return version
  }

  async distill({ l0Line }) {
    const proposal = await this.proposeSelf({ l0Line })
    if (!proposal) return null
    const review = this.reviewSelf(proposal, { l0Line })
    return this.applySelf(proposal, review)
  }

  /**
   * 记忆合并：只动又旧又淡的那批。
   * 0.998/天 掉到 0.3 要 600 天，所以这条平时不会触发——它是压力阀，不是日常动作。
   * 每条合并结果都留着 sources，能追回原来是哪几条。
   */
  async consolidate({ afterDays = 30, weightBelow = 0.3, batchMax = 12 } = {}) {
    const now = Date.now()
    const pool = this.store
      .of('facts')
      .filter((fact) => !fact.pinned && !fact.supersededBy)
      .filter((fact) => (fact.weight ?? 1) < weightBelow)
      .filter((fact) => now - (fact.validFrom ?? fact.ts ?? now) > afterDays * 86_400_000)
      .slice(0, batchMax)
    if (pool.length < 3) return null

    const result = await complete(this.llm, {
      provider: this.provider,
      model: this.model,
      system: '你只输出 JSON。',
      prompt: CONSOLIDATE_PROMPT({ facts: pool }),
      maxTokens: 800,
      temperature: 0.1,
    })
    if (!result.ok) {
      this.audit('consolidate', { stage: 'call', error: result.error })
      return null
    }
    const data = parseJson(result.text)
    this.audit('consolidate', { stage: 'parse', candidates: pool.length, groups: data?.merged?.length ?? 0 }, result.usage)
    if (!data?.merged?.length) return null

    const valid = new Map(pool.map((fact) => [fact.id, fact]))
    const written = []
    for (const item of data.merged) {
      const from = (item?.from ?? []).filter((id) => valid.has(id))
      // 一条素材或没有素材都不算合并，别为凑数丢掉旧记录
      if (from.length < 2 || !item?.text) continue
      const fact = newFact({
        text: String(item.text).slice(0, MAX_FACT_TEXT),
        subject: valid.get(from[0]).subject,
        weight: 0.6,
      })
      fact.sources = from
      this.store.put('facts', fact)
      for (const id of from) {
        const old = this.store.get(id)
        if (!old) continue
        this.store.put('facts', {
          ...old,
          status: 'invalid',
          validTo: now,
          invalidatedAt: now,
          invalidReason: `consolidated into ${fact.id}`,
          supersededBy: fact.id,
        })
      }
      written.push(fact)
    }
    if (!written.length) return null
    this.audit('consolidate', { merged: written.length, from: written.flatMap((fact) => fact.sources) })
    return written
  }

  applyLesson(text) {
    const clean = String(text || '').slice(0, 140).trim()
    if (!clean) return null
    const hits = this.store.search(clean, { layers: ['experience'], top: 3 })
    if (hits.length && hits[0].score > 0.75) return null
    const lesson = {
      id: ulid(),
      ts: Date.now(),
      lesson: clean,
      hits: 0,
      lastUsed: 0,
      utility: 0,
      archived: false,
      keptBecause: '新学到',
    }
    this.store.put('experience', lesson)
    const live = this.store.of('experience').filter((item) => !item.archived)
    if (live.length > 5) {
      const worst = live.sort((a, b) => (a.utility ?? 0) - (b.utility ?? 0))[0]
      this.store.put('experience', {
        ...worst,
        archived: true,
        archivedAt: Date.now(),
        archivedBecause: `效用最低（${worst.utility ?? 0}）`,
      })
    }
    return lesson
  }
}
