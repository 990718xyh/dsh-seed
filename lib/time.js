/**
 * 时间感知。
 *
 * 为什么要有这个：模型不知道现在几点，说「今天」「明天」「早上」全是猜。
 * 这里把时间和时段都算成结论词，直接注入上下文，模型拿来就用，不用自己推。
 *
 * 时段用结论词（上午/中午/下午/晚上/夜里），不是给个 `08:53` 让它自己判断——
 * 给数字它推错过，给结论它不会错。
 */

const BUCKET_CN = {
  morning: '上午',
  noon: '中午',
  afternoon: '下午',
  evening: '晚上',
  night: '夜里',
}

/** 一天里的时段。返回 key，取中文用 BUCKET_CN。 */
export function timeBucket(date = new Date()) {
  const hour = date.getHours()
  if (hour >= 5 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 13) return 'noon'
  if (hour >= 13 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'night'
}

/** 时段的中文结论词。注入时用这个，别让模型自己从小时数推。 */
export function timeBucketText(date = new Date()) {
  return BUCKET_CN[timeBucket(date)] ?? '未知'
}

/** 本地时区的完整时间：`2026-11-01 10:03 周六（Asia/Shanghai）`。 */
export function formatNow(date = new Date()) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')} ${pick('weekday')}（${timeZone}）`
}

/** 注入用的整行：`[现在] 上午 · 2026-11-01 10:03 周六（Asia/Shanghai）`。 */
export function nowLine(date = new Date()) {
  return `[现在] ${timeBucketText(date)} · ${formatNow(date)}`
}

/**
 * 从用户这句话里抽出他说的时段词，用来核对。
 *
 * 这是个兜底：模型可能照着注入的时间算对了，也可能没看注入就自己编。
 * 后者靠 timeBucket 对比就能抓到，不用等它自觉。
 */
export function spokenBucket(text) {
  const source = String(text || '')
  if (/今晚|晚上|夜里|半夜|深夜|傍晚/.test(source)) return 'evening'
  if (/早上|上午|早晨|一大早/.test(source)) return 'morning'
  if (/中午/.test(source)) return 'noon'
  if (/下午/.test(source)) return 'afternoon'
  return null
}
