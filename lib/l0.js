/**
 * L0 位置事实：不写死，从运行环境读出来。
 * 这层只说「我在哪、用什么、能碰什么」，不提供性格。
 */

const PLATFORM_NAME = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}

export function buildL0({ selection, cwd, toolCount, rules = [] }) {
  const platform = PLATFORM_NAME[process.platform] ?? process.platform
  return {
    model: selection?.model ?? 'unknown',
    provider: selection?.provider ?? 'unknown',
    platform,
    cwd: cwd ?? process.cwd(),
    language: '中文',
    toolCount: toolCount ?? 0,
    rules: rules.slice(0, 12),
    builtAt: Date.now(),
  }
}

/** 压成一行，注入时只占一行 token。 */
export function renderL0(l0) {
  if (!l0) return ''
  const parts = [
    `我跑在 ${l0.platform} 上的 DSH 里`,
    `模型 ${l0.model}`,
    `手上有 ${l0.toolCount} 个工具`,
    `跟他用中文说话`,
    `工作目录是 ${l0.cwd}`,
  ]
  return `[位置] ${parts.join('，')}。`
}

/** 供诊断：L0 与工具清单对不上时报警用。 */
export function l0Conflicts(l0, selfText) {
  const issues = []
  if (!l0) return issues
  if (selfText && /windows/i.test(selfText) && l0.platform !== 'Windows') {
    issues.push('自述里写了 Windows，实际在 ' + l0.platform)
  }
  if (selfText && /linux/i.test(selfText) && l0.platform !== 'Linux') {
    issues.push('自述里写了 Linux，实际在 ' + l0.platform)
  }
  return issues
}
