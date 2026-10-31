/**
 * 小模型调用：走 ctx.llm.stream，只用 flash 之类的廉价路由。
 * 失败不抛给对话，返回 { ok:false }，由调用方记 audit。
 */

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('')
}

export async function complete(llm, {
  provider,
  model,
  system,
  prompt,
  maxTokens = 800,
  temperature = 0.2,
  signal,
}) {
  if (!llm) return { ok: false, error: 'llm-unavailable', text: '', usage: null }
  try {
    const stream = llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      temperature,
      signal,
    })
    let text = ''
    let usage = null
    let failure = null
    for await (const chunk of stream) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') {
        if (chunk.reason?.kind === 'error') failure = chunk.reason.failure
        else if (chunk.reason?.kind === 'aborted') failure = chunk.reason.failure
      }
    }
    if (failure) return { ok: false, error: failure.message ?? 'llm-failed', text, usage }
    return { ok: true, text, usage }
  } catch (error) {
    return { ok: false, error: String(error), text: '', usage: null }
  }
}

/** 从模型输出里抠出第一个 JSON 值；失败返回 null。 */
export function parseJson(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[[{]/)
  if (start < 0) return null
  for (let end = body.length; end > start; end -= 1) {
    const slice = body.slice(start, end)
    try {
      return JSON.parse(slice)
    } catch {
      /* 继续缩 */
    }
  }
  return null
}

export { textOf }
