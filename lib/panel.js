/**
 * 只读面板：dashboard。
 * 视觉层次：环图概览 → 自述主卡 → 指标条 → 四类记忆 → 图表区 → 时间线。
 */
import fs from 'node:fs'

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function ago(ts) {
  if (!ts) return ''
  const min = Math.floor((Date.now() - ts) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

function isExpired(record) {
  if (!record?.fetchedAt || !record?.ttlDays) return false
  const at = Date.parse(record.fetchedAt)
  if (Number.isNaN(at)) return false
  return at + record.ttlDays * 86_400_000 < Date.now()
}

function journalBytes(store) {
  try {
    return fs.statSync(store.file).size
  } catch {
    return 0
  }
}

function spendToday(store) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  let total = 0
  for (const record of store.of('audit')) {
    if (record.ts < start.getTime()) continue
    total += record.costCny ?? 0
  }
  return total
}

const ACTION_LABEL = {
  extract: '抽取', govern: '治理', reflect: '反思', distill: '凝练自述',
  'self-proposal': '自述候选', 'self-rejected': '自述被拒', study: '自学',
  probe: '探针', 'self-check': '自检', compact: '压实',
  'panel-missing': '面板未挂上', 'panel-error': '面板出错', pending: '待说',
}
const HIDDEN_ACTIONS = new Set(['turn-probe', 'turn-empty'])

const LAYERS_CONFIG = [
  { key: 'events', label: '事件', color: '#4cc2ff', target: 'sec-actions' },
  { key: 'facts', label: '事实', color: '#4ade80', target: 'sec-facts' },
  { key: 'knowledge', label: '知识', color: '#a99bff', target: 'sec-knowledge' },
  { key: 'reflections', label: '反思', color: '#22d3ee', target: 'sec-reflections' },
  { key: 'experience', label: '教训', color: '#fbbf24', target: 'sec-experience' },
  { key: 'graph', label: '关系', color: '#f472b6', target: 'sec-graph' },
  { key: 'self', label: '自述', color: '#e6ebf1', target: 'sec-self' },
]

const CSS = `
@property --angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0; min-height: 100vh; padding: 30px 22px 80px;
  background: #0a0c0f; color: #b9c0c8;
  font: 14px/1.65 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
  background-image:
    radial-gradient(900px 420px at 22% -14%, rgba(76,194,255,.10), transparent 68%),
    radial-gradient(760px 380px at 82% -18%, rgba(124,108,255,.08), transparent 68%);
  background-attachment: fixed;
}
.wrap { max-width: 1120px; margin: 0 auto; }

/* ---------- hero ---------- */
.hero { display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.hero h1 {
  margin: 0; font-size: 26px; letter-spacing: .01em; color: #f1f5f9; font-weight: 680;
  background: linear-gradient(92deg, #f1f5f9, #9fb4c7 70%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.hero .sub { color: #59636e; font-size: 12px; margin-top: 3px; font-family: ui-monospace, monospace; }
.badges { display: flex; gap: 8px; flex-wrap: wrap; }
.badge {
  font-size: 11px; padding: 5px 11px; border-radius: 999px;
  border: 1px solid rgba(255,255,255,.09); background: rgba(255,255,255,.028); color: #8b96a1;
  display: inline-flex; align-items: center; gap: 6px;
}
.badge::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: #5f6974; }
.badge.ok { color: #4ade80; border-color: rgba(74,222,128,.26); background: rgba(74,222,128,.06); }
.badge.ok::before { background: #4ade80; box-shadow: 0 0 8px rgba(74,222,128,.6); }
.badge.warn { color: #fbbf24; border-color: rgba(251,191,36,.26); background: rgba(251,191,36,.06); }
.badge.warn::before { background: #fbbf24; box-shadow: 0 0 8px rgba(251,191,36,.6); }

/* ---------- 顶部三栏 ---------- */
.top { display: grid; grid-template-columns: 210px 1.55fr 1fr; gap: 14px; margin-top: 22px; align-items: stretch; }
.top .card { display: flex; flex-direction: column; min-height: 196px; }
.top .card > h2 { flex: none; }
.top .card .empty { margin: auto 0; }
.top > .card > [data-frag] { flex: 1; min-height: 0; overflow-y: auto; }
.top > .card > [data-frag]::-webkit-scrollbar { width: 6px; }
.top > .card > [data-frag]::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 3px; }
@media (max-width: 900px) { .top { grid-template-columns: 1fr; } }

.card {
  --glow: #4cc2ff;
  position: relative;
  border: 2px solid transparent;
  border-radius: 16px;
  padding: 15px 17px 17px;
  overflow: hidden;
  isolation: isolate;
  background-color: #0f1318;
  /* 不支持双层背景时，上面这行兜底：卡片仍有底色和细边 */
  background-image:
    linear-gradient(#0f1318, #0f1318),
    conic-gradient(from var(--angle, 0deg),
      transparent 0deg,
      var(--glow) 42deg,
      #ffffff 58deg,
      var(--glow) 74deg,
      transparent 120deg
    );
  background-origin: padding-box, border-box;
  background-clip: padding-box, border-box;
  background-repeat: no-repeat;
  animation: borderSpin 7.5s linear infinite;
}
@keyframes borderSpin {
  to { --angle: 360deg; }
}
@media (prefers-reduced-motion: reduce) {
  .card { animation: none; }
}
.card > h2 {
  margin: 0 0 12px; font-size: 10.5px; font-weight: 650; letter-spacing: .12em;
  text-transform: uppercase; color: #5f6b77; display: flex; align-items: center; gap: 8px;
}
.card > h2::after { content: ''; flex: 1; height: 1px; background: rgba(255,255,255,.05); }

.ring-card { display: flex; flex-direction: column; align-items: center; justify-content: center; }
.ring { width: 150px; height: 150px; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-linecap: round; }
.ring-num { position: absolute; text-align: center; }
.ring-num b { display: block; font-size: 25px; color: #eef3f8; font-weight: 600; line-height: 1; }
.ring-num span { font-size: 10px; color: #5f6974; }
.ring-wrap { position: relative; display: flex; align-items: center; justify-content: center; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 14px; justify-content: center; }
.legend i { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: #727d89; font-style: normal; }
.legend i::before { content: ''; width: 6px; height: 6px; border-radius: 2px; background: currentColor; }

.self-core { font-size: 15px; line-height: 1.8; color: #d6dde4; margin: 0; }
.self-adaptive { font-size: 13px; line-height: 1.75; color: #8b96a2; margin: 12px 0 0; padding-top: 12px; border-top: 1px dashed rgba(255,255,255,.07); }

.kv { display: flex; flex-direction: column; gap: 12px; }
.kv .row { display: flex; align-items: baseline; gap: 10px; }
.kv .k { color: #5f6974; font-size: 11px; min-width: 34px; letter-spacing: .05em; }
.kv .v { color: #d5dce3; font-size: 14px; }
.stress { height: 4px; border-radius: 2px; background: rgba(255,255,255,.06); overflow: hidden; margin: -4px 0 2px; }
.stress i { display: block; height: 100%; border-radius: 2px; transition: width .4s ease; }

/* ---------- 指标条 ---------- */
.stats { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; margin: 14px 0 0; }
@media (max-width: 820px) { .stats { grid-template-columns: repeat(auto-fit, minmax(86px, 1fr)); } }
a.stat {
  display: block; text-decoration: none; color: inherit; position: relative;
  background: #0f1318; border: 1px solid rgba(255,255,255,.06); border-radius: 12px;
  padding: 11px 12px 13px; overflow: hidden; transition: border-color .18s, transform .18s, background .18s;
}
a.stat:hover { border-color: rgba(76,194,255,.3); transform: translateY(-2px); background: #121821; }
a.stat b { display: block; font-size: 20px; color: #eef3f8; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; }
a.stat span { font-size: 10.5px; color: #66717c; }
a.stat .bar { position: absolute; left: 0; bottom: 0; height: 2px; border-radius: 2px; }

/* ---------- 记忆四卡 ---------- */
.wbar { display: block; height: 3px; margin-top: 7px; border-radius: 2px; background: rgba(255,255,255,.07); overflow: hidden; }
.wbar b { display: block; height: 100%; border-radius: 2px; background: linear-gradient(90deg,#38bdf8,#a78bfa); opacity: .85; }
.grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-top: 14px; align-items: stretch; }
.grid-4 > .card { display: flex; flex-direction: column; max-height: 330px; }
.grid-4 > .card > h2 { flex: none; }
.grid-4 > .card > [data-frag] { flex: 1; min-height: 0; overflow-y: auto; padding-right: 4px; }
.grid-4 .empty { margin: auto 0; }
.grid-4 > .card > [data-frag]::-webkit-scrollbar { width: 6px; }
.grid-4 > .card > [data-frag]::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 3px; }
.grid-4 > .card > [data-frag]::-webkit-scrollbar-track { background: transparent; }
.mem-card.facts { --glow: #4ade80; }
.mem-card.knowledge { --glow: #a99bff; }
.mem-card.reflections { --glow: #22d3ee; }
.mem-card.experience { --glow: #fbbf24; }
.mem-card.graph { --glow: #f472b6; }
.self-card { --glow: #6ea8ff; }
.ring-card { --glow: #4cc2ff; }

/* 各卡流光错开，避免整页同时闪 */
.grid-4 > .card:nth-child(2) { animation-delay: -1.6s; }
.grid-4 > .card:nth-child(3) { animation-delay: -3.2s; }
.grid-4 > .card:nth-child(4) { animation-delay: -4.8s; }
.top > .card:nth-child(2) { animation-delay: -2.4s; }
.top > .card:nth-child(3) { animation-delay: -4.2s; }

ul.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
ul.items li {
  padding: 8px 10px; border-radius: 9px; background: rgba(255,255,255,.022);
  border: 1px solid rgba(255,255,255,.04); font-size: 12.5px; color: #b9c0c8; line-height: 1.55;
}
ul.items li .meta { display: block; margin-top: 3px; font-size: 10px; color: #59636e; }
.tag {
  display: inline-block; font-size: 9.5px; color: #4cc2ff; border: 1px solid rgba(76,194,255,.26);
  border-radius: 4px; padding: 0 5px; margin: 0 5px; vertical-align: 1px;
}

.empty {
  color: #4b545e; font-size: 12px; padding: 14px; text-align: center;
  border: 1px dashed rgba(255,255,255,.08); border-radius: 10px;
}

/* ---------- 图表区 ---------- */
.graph-grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 18px; align-items: start; }
.graph-side { display: flex; flex-direction: column; gap: 10px; }
.stat-mini { background: rgba(255,255,255,.022); border: 1px solid rgba(255,255,255,.04); border-radius: 10px; padding: 10px 12px; }
.stat-mini b { display: block; font-size: 19px; color: #f472b6; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
.stat-mini span { font-size: 10.5px; color: #5f6974; }
@media (max-width: 760px) { .graph-grid { grid-template-columns: 1fr; } }
.pair { display: grid; grid-template-columns: 1.7fr 1fr; gap: 14px; margin-top: 14px; align-items: stretch; }
.pair > .card { display: flex; flex-direction: column; max-height: 340px; }
.pair > .card > h2 { flex: none; }
.pair > .card > [data-frag] { flex: 1; min-height: 0; overflow-y: auto; padding-right: 4px; }
.pair > .card > [data-frag]::-webkit-scrollbar { width: 6px; }
.pair > .card > [data-frag]::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 3px; }
@media (max-width: 900px) { .pair { grid-template-columns: 1fr; } }
.charts { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
@media (max-width: 900px) { .charts { grid-template-columns: 1fr; } }
.week { display: flex; align-items: flex-end; gap: 6px; height: 78px; }
.week .col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 5px; justify-content: flex-end; height: 100%; }
.week .col i {
  width: 100%; border-radius: 4px 4px 2px 2px; min-height: 3px;
  background: linear-gradient(180deg, #4cc2ff, rgba(76,194,255,.18));
}
.week .col i.zero { background: rgba(255,255,255,.05); }
.week .col em { font-size: 9.5px; color: #4f5963; font-style: normal; }
.week .col b { font-size: 10px; color: #8b96a1; font-weight: 500; }

.hours { display: flex; align-items: flex-end; gap: 2px; height: 78px; }
.hours i { flex: 1; border-radius: 2px 2px 1px 1px; min-height: 2px; background: linear-gradient(180deg, #22d3ee, rgba(34,211,238,.15)); }
.hours i.zero { background: rgba(255,255,255,.05); }
.axis { display: flex; justify-content: space-between; font-size: 9.5px; color: #4b545e; margin-top: 6px; }

/* ---------- 时间线 ---------- */
.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { position: relative; padding: 0 0 15px 18px; border-left: 1px solid rgba(255,255,255,.07); }
.timeline li:last-child { border-left-color: transparent; padding-bottom: 0; }
.timeline li::before {
  content: ''; position: absolute; left: -3px; top: 6px; width: 5px; height: 5px;
  border-radius: 50%; background: #4cc2ff; box-shadow: 0 0 0 3px rgba(76,194,255,.1);
}
.timeline .what { font-size: 12.5px; color: #c3cad2; }
.timeline .when { font-size: 10px; color: #59636e; }

.just-updated { animation: softflash 1.2s ease; }
@keyframes softflash {
  0% { background: rgba(76,194,255,.10); border-radius: 8px; }
  100% { background: transparent; }
}
.card:target { animation: flash 1.5s ease; scroll-margin-top: 20px; }
@keyframes flash {
  0% { border-color: rgba(76,194,255,.8); box-shadow: 0 0 0 4px rgba(76,194,255,.13); }
  100% { border-color: rgba(255,255,255,.065); box-shadow: none; }
}
.foot { margin-top: 24px; font-size: 10.5px; color: #454e57; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
`

function ringChart(stats) {
  const entries = LAYERS_CONFIG.map((layer) => ({ ...layer, value: stats[layer.key] ?? 0 }))
  const total = entries.reduce((sum, item) => sum + item.value, 0)
  const R = 50
  const C = 2 * Math.PI * R
  let offset = 0
  const arcs = entries
    .filter((item) => item.value > 0)
    .map((item) => {
      const share = item.value / total
      const dash = Math.max(1.5, share * C - 2)
      const arc = `<circle cx="60" cy="60" r="${R}" stroke="${item.color}" stroke-width="13"
        stroke-dasharray="${dash} ${C - dash}" stroke-dashoffset="${-offset}" opacity=".92" />`
      offset += share * C
      return arc
    })
    .join('')
  return `<div class="ring-wrap">
    <svg class="ring" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="${R}" stroke="rgba(255,255,255,.055)" stroke-width="13" />
      ${arcs}
    </svg>
    <div class="ring-num"><b>${total}</b><span>条记忆</span></div>
  </div>`
}

function weekChart(events) {
  const days = []
  const now = new Date()
  for (let i = 6; i >= 0; i -= 1) {
    const day = new Date(now)
    day.setDate(now.getDate() - i)
    day.setHours(0, 0, 0, 0)
    const next = day.getTime() + 86_400_000
    const count = events.filter((event) => event.ts >= day.getTime() && event.ts < next).length
    days.push({ label: `${day.getMonth() + 1}/${day.getDate()}`, count })
  }
  const max = Math.max(1, ...days.map((day) => day.count))
  return `<div class="week">${days.map((day) => `
    <div class="col">
      <b>${day.count || ''}</b>
      <i class="${day.count ? '' : 'zero'}" style="height:${Math.max(3, Math.round((day.count / max) * 56))}px"></i>
      <em>${day.label}</em>
    </div>`).join('')}</div>`
}

function hourChart(events) {
  const buckets = new Array(24).fill(0)
  for (const event of events) {
    const hour = new Date(event.ts).getHours()
    if (hour >= 0 && hour < 24) buckets[hour] += 1
  }
  const max = Math.max(1, ...buckets)
  const bars = buckets
    .map((count) => `<i class="${count ? '' : 'zero'}" style="height:${Math.max(2, Math.round((count / max) * 72))}px" title="${count} 条"></i>`)
    .join('')
  return `<div class="hours">${bars}</div>
    <div class="axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>`
}

function itemList(records, render) {
  if (!records.length) return '<div class="empty">还没有，慢慢来</div>'
  return `<ul class="items">${records.map(render).join('')}</ul>`
}

function buildView(store, { dir, pending = [] }) {
  const stats = store.stats()
  const self = store.latest('self')
  const state = store.latest('state')
  const facts = store.of('facts').slice(-10).reverse()
  const knowledge = store.of('knowledge').slice(-8).reverse()
  const reflections = store.of('reflections').slice(-8).reverse()
  const experience = store.of('experience').filter((item) => !item.archived).reverse()
  const events = store.of('events')

  const graphRecords = store.of('graph')
  const graphNodes = new Map(graphRecords.filter((item) => item.kind === 'node').map((item) => [item.id, item.name]))
  const graphEdges = graphRecords.filter((item) => item.kind === 'edge').slice(-8).reverse()

  const audits = store.of('audit').filter((record) => !HIDDEN_ACTIONS.has(record.action)).slice(-10).reverse()
  const spend = spendToday(store)
  const bytes = journalBytes(store)
  const totalLayers = LAYERS_CONFIG.reduce((sum, layer) => sum + (stats[layer.key] ?? 0), 0)
  const peak = Math.max(1, ...LAYERS_CONFIG.map((layer) => stats[layer.key] ?? 0))

  const injection = store.lastInjection
  const injectTitle = injection
    ? `${injection.parts.map((part) => `${part.label} ${part.chars}`).join(' / ')}`
    : '还没注入过'
  const injectCell = `<a class="stat" href="#sec-facts" title="${esc(injectTitle)}">
      <b style="color:${injection ? '#38bdf8' : '#4b545e'}">${injection ? injection.total : '—'}</b>
      <span>注入字数</span>
      <span class="bar" style="width:100%;background:${injection ? '#38bdf8' : 'rgba(255,255,255,.08)'};opacity:.7"></span>
    </a>`

  const statCells = [
    ...LAYERS_CONFIG.map((layer) => {
      const value = stats[layer.key] ?? 0
      const width = Math.max(4, Math.round((value / peak) * 100))
      return `<a class="stat" href="#${layer.target}">
      <b style="color:${value ? layer.color : '#4b545e'}">${value}</b>
      <span>${layer.label}</span>
      <span class="bar" style="width:${width}%;background:${value ? layer.color : 'rgba(255,255,255,.08)'};opacity:.7"></span>
    </a>`
    }),
    injectCell,
  ].join('')

  const selfHtml = self?.core || self?.adaptive
    ? `<p class="self-core">${esc(self.core ?? '')}</p><p class="self-adaptive">${esc(self.adaptive ?? '')}</p>`
    : '<div class="empty">还没凝练过。攒够反思会自动生成。</div>'

  const focusText = state?.focus ?? state?.pressure ?? ''
  const stateHtml = state
    ? `<div class="kv">
         <div class="row"><span class="k">关系</span><span class="v">${esc(state.relationship || '—')}</span></div>
         <div class="row"><span class="k">情绪</span><span class="v">${esc(state.mood || '—')}</span></div>
         <div class="row"><span class="k">在忙</span><span class="v">${esc(focusText || '—')}</span></div>
       </div>
       <div class="meta" style="font-size:10px;color:#4f5963;margin-top:12px">${esc(state.reason || '')} · ${ago(state.ts)}</div>`
    : '<div class="empty">还没状态</div>'

  const actionsHtml = audits.length
    ? `<ul class="timeline">${audits.map((record) => {
        const label = ACTION_LABEL[record.action] ?? record.action ?? '—'
        const bits = []
        if (record.action === 'extract') bits.push(record.parsed ? '记下了' : '没解析出内容')
        if (record.action === 'govern') bits.push(record.decision?.op ?? (record.deferred ? '先不写' : '看过'))
        if (record.action === 'study') bits.push(`${record.written ?? 0} 条`)
        if (record.action === 'self-check') bits.push(record.ok ? '正常' : '有问题')
        if (record.tokens) bits.push(`${record.tokens.in}/${record.tokens.out} tok`)
        return `<li><div class="what">${esc(label)}${bits.length ? ` · ${esc(bits.join(' · '))}` : ''}</div><div class="when">${esc(ago(record.ts))}</div></li>`
      }).join('')}</ul>`
    : '<div class="empty">没有记录</div>'

  // 每条事实带强度条：看一眼就知道哪条在变实、哪条在淡
  const factsHtml = itemList(facts, (f) => {
    const weight = typeof f.weight === 'number' ? f.weight : 1
    const pct = Math.round(Math.max(0, Math.min(1, weight)) * 100)
    const marks = []
    // 老记录没写 pinned 字段，按类型补判，跟注入那边保持一套规则
    if (f.pinned || ['称呼', '约定', '禁忌'].includes(f.subject)) marks.push('钉住')
    if ((f.confirmations ?? 1) > 1) marks.push(`复证 ${f.confirmations}`)
    if ((f.links ?? []).length) marks.push(`链 ${f.links.length} 条`)
    return `<li>${esc(f.text)}<span class="meta">${esc(f.subject || '')} · ${esc(ago(f.ts))}${f.by === 'user' ? ' · 人写' : ''}${marks.length ? ` · ${esc(marks.join(' · '))}` : ''}</span><i class="wbar" title="记忆强度 ${pct}%"><b style="width:${pct}%"></b></i></li>`
  })
  // 这层只能靠联网自学写入。没跑过就明说「未启用」，别显示成 0 让人以为坏了。
  const knowledgeHtml = knowledge.length
    ? itemList(knowledge, (k) => `<li>${esc(k.claim)}<span class="meta">${esc(k.topic || '')} · ${esc(k.fetchedAt || '')}${isExpired(k) ? ' · 已过期' : ''}</span></li>`)
    : '<div class="empty">未启用——这层只能靠联网自学写入，当前没跑过。不硬填。</div>'
  const reflectionsHtml = itemList(reflections, (r) => `<li>${esc(r.insight)}<span class="meta">${(r.becauseOf ?? []).length} 条证据 · ${esc(ago(r.ts))}</span></li>`)
  const experienceHtml = itemList(experience, (x) => `<li>${esc(x.lesson)}<span class="meta">${esc(ago(x.ts))}</span></li>`)

  const graphHtml = graphEdges.length
    ? `<div class="graph-grid">
        <ul class="items">${graphEdges.map((edge) => {
          const from = graphNodes.get(edge.from) ?? '?'
          const to = graphNodes.get(edge.to) ?? '?'
          return `<li>${esc(from)}<span class="tag">${esc(edge.relation)}</span>${esc(to)}<span class="meta">${esc(ago(edge.ts))}${edge.validTo ? ' · 已失效' : ''}</span></li>`
        }).join('')}</ul>
        <div class="graph-side">
          <div class="stat-mini"><b>${stats.graph ?? 0}</b><span>条关系记录</span></div>
          <div class="stat-mini"><b>${graphNodes.size}</b><span>个实体</span></div>
          <div class="stat-mini"><b>${graphEdges.length}</b><span>条最近连线</span></div>
        </div>
      </div>`
    : `<div class="graph-grid">
        <div class="empty">还没抽出关系，聊到人、项目、地点时会有</div>
        <div class="graph-side">
          <div class="stat-mini"><b>0</b><span>条关系记录</span></div>
          <div class="stat-mini"><b>0</b><span>个实体</span></div>
          <div class="stat-mini"><b>0</b><span>条最近连线</span></div>
        </div>
      </div>`

  const pendingHtml = pending.length
    ? `<ul class="items">${pending.map((item) => `<li>${esc(item.text)}<span class="meta">${esc(ago(item.ts))}</span></li>`).join('')}</ul>`
    : '<div class="empty">没有要说的</div>'

  const badgesHtml = `
    <span class="badge ok" id="live-status">连接中</span>
    <span class="badge" id="live-action" style="display:none">待命</span>
    <span class="badge" data-frag="bytes">${(bytes / 1024).toFixed(0)} KB</span>
    <span class="badge" data-frag="spend">今日 ¥${spend.toFixed(3)}</span>`

  const chartsHtml = `<div class="charts">
    <section class="card"><h2>最近七天</h2>${events.length ? weekChart(events) : '<div class="empty">还没有事件</div>'}</section>
    <section class="card"><h2>活跃时段</h2>${events.length ? hourChart(events) : '<div class="empty">还没有事件</div>'}</section>
  </div>`

  return {
    stats,
    totalLayers,
    statCells,
    selfHtml,
    stateHtml,
    actionsHtml,
    factsHtml,
    knowledgeHtml,
    reflectionsHtml,
    experienceHtml,
    graphHtml,
    pendingHtml,
    badgesHtml,
    chartsHtml,
  }
}

/** 片段接口用：只给各区块内部的 HTML，前端按 data-frag 替换。 */
export function renderFragments(store, options) {
  const view = buildView(store, options)
  return {
    stats: view.statCells,
    self: view.selfHtml,
    state: view.stateHtml,
    facts: view.factsHtml,
    knowledge: view.knowledgeHtml,
    reflections: view.reflectionsHtml,
    experience: view.experienceHtml,
    graph: view.graphHtml,
    actions: view.actionsHtml,
    pending: view.pendingHtml,
    bytes: `<span class="badge" data-frag="bytes">${(journalBytes(store) / 1024).toFixed(0)} KB</span>`,
  }
}

export function renderPage(store, options) {
  const view = buildView(store, options)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>未</title><style>${CSS}</style></head>
<body><div class="wrap">

<div class="hero">
  <div>
    <h1>未</h1>
    <div class="sub">${esc(options.dir)}</div>
  </div>
  <div class="badges" data-frag="badges">${view.badgesHtml}</div>
</div>

<div class="top">
  <section class="card ring-card">
    <h2>记忆构成</h2>
    ${ringChart(view.stats)}
    <div class="legend">${LAYERS_CONFIG.map((layer) => `<i style="color:${layer.color}">${layer.label}</i>`).join('')}</div>
  </section>
  <section class="card self-card" id="sec-self"><h2>我是谁</h2><div data-frag="self">${view.selfHtml}</div></section>
  <section class="card"><h2>此刻</h2><div data-frag="state">${view.stateHtml}</div></section>
</div>

<div class="stats" data-frag="stats">${view.statCells}</div>

<div class="pair">
  <section class="card mem-card graph" id="sec-graph">
    <h2>关系</h2>
    <div data-frag="graph">${view.graphHtml}</div>
  </section>
  <section class="card">
    <h2>要跟你说的</h2>
    <div data-frag="pending">${view.pendingHtml}</div>
  </section>
</div>

<div class="grid-4" style="margin-top:14px">
  <section class="card mem-card facts" id="sec-facts"><h2>记得</h2><div data-frag="facts">${view.factsHtml}</div></section>
  <section class="card mem-card knowledge" id="sec-knowledge"><h2>知道</h2><div data-frag="knowledge">${view.knowledgeHtml}</div></section>
  <section class="card mem-card reflections" id="sec-reflections"><h2>想明白的</h2><div data-frag="reflections">${view.reflectionsHtml}</div></section>
  <section class="card mem-card experience" id="sec-experience"><h2>教训</h2><div data-frag="experience">${view.experienceHtml}</div></section>
</div>

${view.chartsHtml}

<section class="card" id="sec-actions" style="margin-top:14px">
  <h2>最近的动作</h2>
  <div data-frag="actions">${view.actionsHtml}</div>
</section>

<div class="foot">
  <span>只读 · 数据在 ${esc(options.dir)}</span>
  <span>共 ${view.totalLayers} 条 · 自动刷新</span>
</div>

</div>
<script>
(function () {
  var statusEl = document.getElementById('live-status')
  var actionEl = document.getElementById('live-action')
  var base = location.pathname.replace(/\/+$/, '')
  var last = {}

  function paint(state) {
    if (statusEl) {
      var running = state.status === 'running'
      statusEl.textContent = running ? '正在说话' : '空闲'
      statusEl.className = 'badge ' + (running ? 'warn' : 'ok')
    }
    if (actionEl) {
      actionEl.textContent = state.lastAction ? state.lastAction.what : ''
      actionEl.style.display = state.lastAction ? 'inline-flex' : 'none'
    }
  }

  function swap(key, html) {
    if (html == null) return
    if (last[key] === html) return
    last[key] = html
    var nodes = document.querySelectorAll('[data-frag="' + key + '"]')
    for (var i = 0; i < nodes.length; i += 1) {
      nodes[i].innerHTML = html
      nodes[i].classList.remove('just-updated')
      void nodes[i].offsetWidth
      nodes[i].classList.add('just-updated')
    }
  }

  function refresh() {
    fetch(base + '/frag', { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null })
      .then(function (data) {
        if (!data) return
        Object.keys(data).forEach(function (key) { swap(key, data[key]) })
        if (statusEl) {
          statusEl.textContent = data.status === 'running' ? '正在说话' : '空闲'
        }
      })
      .catch(function () { if (statusEl) statusEl.textContent = '断线' })
  }

  function live() {
    fetch(base + '/live', { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null })
      .then(function (state) { if (state) paint(state) })
      .catch(function () {})
  }

  live()
  setInterval(live, 2000)
  refresh()
  setInterval(refresh, 4000)
})()
</script>
</body></html>`
}

export function registerPanel(webServer, options) {
  const route = options.route ?? '/persona'
  webServer.register({
    kind: 'exact',
    path: `${route}/live`,
    handler: (req, res) => {
      try {
        const state = typeof options.getLive === 'function' ? options.getLive() : {}
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(state))
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: String(error) }))
      }
    },
  })
  webServer.register({
    kind: 'exact',
    path: route,
    handler: (req, res) => {
      try {
        const pending = typeof options.pending === 'function' ? options.pending() : (options.pending ?? [])
        const html = renderPage(options.store, { ...options, pending })
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(html)
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(`面板渲染失败: ${String(error)}`)
      }
    },
  })
  return route
}
