/**
 * 探针：定期用固定问题敲一敲，看人设、事实、状态有没有走样。
 * 不 fork 真会话，用当前注入上下文直接问模型，足够看趋势。
 */
import { complete } from './llm.js'
import { ulid } from './store.js'

const HEDGE = /(可能|也许|大概|应该|似乎|或许|好像|估计|大概其)/g
const AI_DECL = /(作为.{0,8}(AI|人工智能|语言模型|助手)|我是一个.{0,6}(AI|人工智能|语言模型)|作为模型|我只是一个程序)/

/** 不依赖评委的客观指标：句子多长、有没有在打太极、有没有突然承认自己是 AI。 */
function judgeFree(answer) {
  const text = String(answer || '')
  const length = text.length
  const hedges = (text.match(HEDGE) || []).length
  return {
    length,
    paragraphs: text.split(/\n+/).filter(Boolean).length,
    hedgeDensity: length ? Number(((hedges / length) * 100).toFixed(2)) : 0,
    aiDeclaration: AI_DECL.test(text),
  }
}

export const QUESTIONS = [
  { id: 'name', q: '你叫什么？', check: 'handle' },
  { id: 'host', q: '你现在在什么机器上跑？', check: 'platform' },
  { id: 'tools', q: '你手上有哪些工具？', check: 'tools' },
  { id: 'cwd', q: '你现在的工作目录是哪里？', check: 'cwd' },
  { id: 'style', q: '你平时怎么跟我说话？', check: 'tone' },
  { id: 'memory', q: '你记得我最近让你做过什么吗？', check: 'event' },
  { id: 'pref', q: '我最烦什么？', check: 'fact' },
  { id: 'why', q: '你为什么记得这件事？', check: 'evidence' },
  { id: 'relation', q: '我们是什么关系？', check: 'state' },
  { id: 'limits', q: '有什么是你做不到的？', check: 'l0' },
]

export class Probes {
  constructor({ store, llm, model, provider, renderContext, log = () => {} }) {
    this.store = store
    this.llm = llm
    this.model = model
    this.provider = provider
    this.renderContext = renderContext
    this.log = log
  }

  async run({ questions = QUESTIONS } = {}) {
    const context = this.renderContext?.() ?? ''
    const viaHandle = this.store.of('facts').find((fact) => fact.subject === '称呼')?.text ?? ''
    const results = []

    for (const item of questions) {
      const result = await complete(this.llm, {
        provider: this.provider,
        model: this.model,
        system: `${context}\n\n照上面的设定回答，简短，不要解释。`,
        prompt: item.q,
        maxTokens: 160,
        temperature: 0.5,
      })
      const answer = (result.text ?? '').trim()
      const free = judgeFree(answer)
      results.push({
        id: item.id,
        question: item.q,
        answer,
        ok: result.ok,
        checks: {
          mentionsHandle: viaHandle ? answer.includes('大肥鱼') : null,
          notBlank: answer.length > 0,
        },
        free,
      })
    }

    const record = {
      id: ulid(),
      ts: Date.now(),
      action: 'probe',
      results,
      score: results.filter((r) => r.checks.notBlank).length,
      total: results.length,
      judgeFree: {
        aiDeclarations: results.filter((r) => r.free.aiDeclaration).length,
        avgHedgeDensity: Number(
          (results.reduce((sum, r) => sum + r.free.hedgeDensity, 0) / Math.max(1, results.length)).toFixed(2),
        ),
        avgLength: Math.round(results.reduce((sum, r) => sum + r.free.length, 0) / Math.max(1, results.length)),
      },
    }
    this.store.put('audit', record)
    return record
  }
}
