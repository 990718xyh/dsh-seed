/**
 * 机械抽取：不经模型的锚点。
 *
 * 调研给的数字很硬：LLM 摘要在「复发细节」上保留率上限约 16%，
 * 机械抽取是 79%。路径、版本号、日期、URL、十六进制标识这类东西
 * 不需要理解，只需要记住，所以完全绕开模型。
 */

const PATTERNS = [
  /https?:\/\/[^\s"'）)>\]]+/g,
  /(?:~|\/Users|\/home|\/opt|\/tmp|\/var)[^\s"'）)>\]，。；：、]*/g,
  /\b[A-Za-z]:\\[^\s"'）)>\]，。；：、]*/g,
  /\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b[0-9a-f]{7,40}\b/g,
  /[A-Za-z_][A-Za-z0-9_]*\.(?:js|ts|mjs|json|yml|yaml|md|py|go|rs|java)\b/g,
]

export function extractAnchors(text) {
  const out = new Set()
  const source = String(text || '')
  if (!source) return []
  for (const pattern of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const value = match[0].trim().replace(/[.,;:]+$/, '')
      if (value.length < 3 || value.length > 200) continue
      out.add(value)
      if (out.size >= 16) break
    }
    if (out.size >= 16) break
  }
  return [...out]
}

/** 把最近几条事件的锚点收成一段，压缩后原样重注入。 */
export function renderAnchors(events, limit = 12) {
  const seen = new Set()
  for (const event of events) {
    for (const anchor of event.anchors ?? []) {
      if (seen.size >= limit) break
      seen.add(anchor)
    }
  }
  if (seen.size === 0) return ''
  return `[锚点]\n${[...seen].map((anchor) => `- ${anchor}`).join('\n')}`
}
