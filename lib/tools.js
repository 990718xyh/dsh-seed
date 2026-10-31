/**
 * 给模型的两个记忆工具：
 *   persona_search  主动查
 *   persona_note    主动记
 * 自动抽取是兜底，这两个让它在对话中自己决定要查什么、要记什么。
 */
import { ulid } from './store.js'

const LAYER_NAMES = ['facts', 'knowledge', 'reflections', 'experience', 'events']

function pick(record) {
  return record.text ?? record.summary ?? record.insight ?? record.claim ?? record.lesson ?? ''
}

export function registerTools(ctx, { store, log = () => {}, study = null, foreignOk = false }) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'persona_search',
    description: '在自己的长期记忆里检索。查之前发生过什么、记过什么、学过什么、总结出过什么。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的内容，用自然语言' },
        layer: { type: 'string', enum: LAYER_NAMES, description: '只查某一层，不填就全查' },
        top: { type: 'integer', minimum: 1, maximum: 20, description: '返回几条，默认 8' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, count: { type: 'integer' } },
        required: ['text', 'count'],
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args) => {
      const query = String(args?.query ?? '')
      const hits = store.search(query, {
        layers: args?.layer ? [args.layer] : undefined,
        top: Number(args?.top) || 8,
      })
      if (hits.length === 0) return { text: '（没有找到相关的记忆）', count: 0 }
      const text = hits
        .map((hit) => {
          const body = pick(hit.record)
          const when = new Date(hit.record.ts).toISOString().slice(0, 10)
          return `- [${hit.record.layer} ${when}] ${body}`
        })
        .join('\n')
      store.markRetrieved(hits.map((hit) => hit.id))
      return { text, count: hits.length }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'persona_note',
    description: '记一条长期有用的事实。只记明确说过、以后会用到的；推测和临时状态不要记。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一句话，不超过 120 字' },
        subject: {
          type: 'string',
          enum: ['称呼', '身份', '工作', '偏好', '关系', '约定', '禁忌', '其它'],
          description: '这条属于哪一类',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, duplicated: { type: 'boolean' } },
        required: ['id', 'duplicated'],
        additionalProperties: false,
      },
      render: (args, value) => [
        { type: 'text', text: value.duplicated ? '这条已经记过了，没重复写。' : `记下了（${value.id}）。` },
      ],
    },
    execute: async (args) => {
      const text = String(args?.text ?? '').slice(0, 120).trim()
      if (!text) return { id: '', duplicated: true }
      const hits = store.search(text, { layers: ['facts'], top: 1 })
      if (hits.length && hits[0].score > 0.8) return { id: hits[0].id, duplicated: true }
      const id = ulid()
      store.put('facts', {
        id,
        ts: Date.now(),
        text,
        subject: args?.subject || '其它',
        supersedes: null,
        sourceEvent: null,
        conf: 0.8,
        by: 'assistant',
      })
      return { id, duplicated: false }
    },
  }))

  // 手动触发一次自学。定时器一天只给几次机会，出问题时没法当场复现。
  if (study) {
    disposers.push(ctx.tools.register({
      name: 'persona_study',
      description: '立刻跑一次自学，返回写了什么、失败在哪。平时不用调，只在要排查自学为什么不产出时用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            written: { type: 'integer' },
            failures: { type: 'integer' },
          },
          required: ['text', 'written', 'failures'],
          additionalProperties: false,
        },
        render: (args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async () => {
        let result
        try {
          result = await study.run({ foreignOk })
        } catch (error) {
          return { text: `自学抛错：${String(error).slice(0, 300)}`, written: 0, failures: 1 }
        }
        if (result?.skipped) return { text: `没跑：${result.skipped}`, written: 0, failures: 0 }
        const written = result?.written ?? []
        const failures = result?.failures ?? []
        const detail = failures
          .slice(0, 3)
          .map((f) => `- ${f.topic ?? '?'}：${String(f.error ?? '').slice(0, 160)}`)
          .join('\n')
        const head = `写了 ${written.length} 条，失败 ${failures.length} 条`
        return { text: detail ? `${head}\n${detail}` : head, written: written.length, failures: failures.length }
      },
    }))
  }

  log('记忆工具已注册')
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        log(`卸载工具失败: ${String(error)}`)
      }
    }
  }
}
