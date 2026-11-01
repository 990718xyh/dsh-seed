/**
 * 大肥鱼 · host 半。
 *
 * 八层里已实现：events / facts / state / reflections / self / knowledge / audit，
 * experience 留了接口但暂不自动生成。
 * 每轮三段：注入、抽取、治理。自学和探针跑在空闲定时器里。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { extractAnchors, renderAnchors } from './lib/anchors.js'
import { runSelfCheck } from './lib/eval.js'
import { graphRecall } from './lib/graph.js'
import { Brain } from './lib/brain.js'
import { Heartbeat } from './lib/heartbeat.js'
import { buildL0, renderL0 } from './lib/l0.js'
import { startPanelServer } from './lib/server.js'
import { Probes } from './lib/probes.js'
import { Store, ulid } from './lib/store.js'
import { Study } from './lib/study.js'
import { registerTools } from './lib/tools.js'
import { nowLine } from './lib/time.js'

const DEFAULT_CONFIG = {
  id: 'seed',
  dir: '~/.dsh/persona',
  hostId: 'mac-main',
  handle: '', // 他怎么叫我，留空就等他给；名字是自己起的，不走这里
  preferences: ['他喜欢我说话欢快一点'],
  anchor: '',
  net: { overseas: true },
  // 留空 = 跟着当前选中模型走。写死会在没装对应 provider 的机器上直接报
  // no API key for provider route，抽取整条链就静默死掉。
  llm: { provider: null, model: null },
  layers: {
    self: true,
    state: true,
    facts: true,
    events: true,
    reflections: true,
    experience: true,
    knowledge: true,
  },
  retrieval: { topFacts: 8, topKnowledge: 4, topReflections: 3 },
  extract: { enabled: true },
  // 5 轮一次：20 轮对单人对话太长，一天都轮不到；反思成本很低（输出压到 300 字）
  reflect: { everyTurns: 5 },
  study: { enabled: true, dailyBudgetCny: 2, idleMinutes: 20, checkEveryMinutes: 30 },
  probes: { enabled: true, everyDays: 7 },
  heartbeat: {
    enabled: true,
    everyMinutes: 30,
    compactAtBytes: 5 * 1024 * 1024,
    // 7 天太长：自述一版要等一周，等于永远落后于正在发生的事
    selfEveryDays: 2,
    retention: { eventsDays: 90, auditDays: 30, keepImportant: 7 },
    // 压力阀：又旧又淡的事实压成更少的条目。默认开着，但门槛高到几乎不会触发
    consolidation: { enabled: true, afterDays: 30, weightBelow: 0.3, batchMax: 12 },
  },
  panel: { enabled: true, route: '/persona', port: 8787 },
  self: { onStart: false },
  inject: { enabled: true },
}

function resolveDir(input) {
  if (!input) return path.join(os.homedir(), '.dsh', 'persona')
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  return input
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(extra)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

function contentText(event) {
  const message = event?.data?.message ?? event?.data
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function line(record, label) {
  if (!record) return ''
  const body = record.text ?? record.summary ?? record.insight ?? record.lesson ?? record.claim ?? ''
  if (!body) return ''
  return `- ${label ? `${label}：` : ''}${body}`
}

export const inject = ['systemPrompt', 'agentDefaultModel', 'tools']

export function apply(ctx, config) {
  const opts = deepMerge(DEFAULT_CONFIG, config ?? {})
  const dir = path.join(resolveDir(opts.dir), opts.id)
  const log = (message) => {
    try {
      ctx.logger?.warn?.(`persona: ${message}`)
    } catch {
      /* 日志不能反过来弄坏插件 */
    }
  }

  const store = new Store({ dir, hostId: opts.hostId, log })
  store.ensure()
  const loaded = store.load()
  log(`从 ${dir} 载入 ${loaded} 条记录`)

  // 配错目录的典型症状：配置里没写 id，用了默认值，于是读到一个全新的空目录，
  // 旧数据其实还在同级的别的目录里。不报警的话，表现就是「记忆突然清空了」。
  if (loaded === 0) {
    try {
      const parent = path.dirname(dir)
      const siblings = fs
        .readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && path.join(parent, entry.name) !== dir)
        .map((entry) => {
          const base = path.join(parent, entry.name, 'snapshot', 'base.json')
          // journal 是 journal/<hostId>.jsonl，不是根目录下单个文件
          const journalDir = path.join(parent, entry.name, 'journal')
          let hasJournal = false
          try {
            hasJournal = fs
              .readdirSync(journalDir)
              .some((name) => name.endsWith('.jsonl') && fs.statSync(path.join(journalDir, name)).size > 0)
          } catch {
            /* 没有 journal 目录就是没写过 */
          }
          return { name: entry.name, hasData: fs.existsSync(base) || hasJournal }
        })
        .filter((item) => item.hasData)
      if (siblings.length > 0) {
        const dataDirs = siblings.map((item) => item.name)
        // 写进 audit，不只 log：log 在后台一个字看不到，等于没做。
        // 但**不自动切目录**——静默换一个数据集比读空目录更危险，那等于换了个人还不知道。
        try {
          store.put('audit', {
            id: ulid(),
            ts: Date.now(),
            action: 'dir-fallback-suspect',
            configuredId: opts.id,
            configuredDir: dir,
            dataDirs,
            loaded,
          })
        } catch (error) {
          // 审计写不进去也不能挡住告警，但要把原因说出来，不然等于静默失败
          log(`目录自检的审计没写进去：${String(error)}`)
        }
        log(
          `当前 id=${opts.id} 指向空目录 ${dir}，但同级有带数据的目录：${dataDirs.join('、')}。` +
            `多半是配置里没写 id 用了默认值，改回正确的 id 就能读回原数据，数据没丢。`,
        )
      }
    } catch {
      /* 自检失败不能影响启动 */
    }
  }

  const selection = ctx.agentDefaultModel?.currentSelection?.()

  // 抽取、学习、探针都用当前选中的模型；配置里显式写了才覆盖。
  const llmRoute = {
    provider: opts.llm?.provider ?? selection?.provider ?? 'deepseek-official',
    model: opts.llm?.model ?? selection?.model ?? 'deepseek-flash',
  }

  // 这三个是可选依赖：拿不到就降级，不能因为没人注入就崩掉插件。
  let toolCount = 0
  try {
    toolCount = ctx.tools?.schemas?.()?.length ?? 0
  } catch {
    toolCount = 0
  }
  let llm = null
  try {
    llm = ctx.get?.('llm') ?? null
  } catch {
    llm = null
  }
  let web = null
  try {
    web = ctx.get?.('web') ?? null
  } catch {
    web = null
  }

  const l0 = buildL0({
    selection,
    cwd: process.cwd(),
    toolCount,
  })
  const l0Line = renderL0(l0)

  const brain = new Brain({
    store,
    llmClient: llm,
    model: llmRoute.model,
    provider: llmRoute.provider,
    log,
    anchor: opts.anchor ?? '',
  })

  let liveStatus = 'idle'
  let liveSince = Date.now()
  let lastAction = null
  let lastUserText = ''
  let lastCwd = null
  let lastUserAt = Date.now()
  let turnCount = 0
  let chain = Promise.resolve()
  let studying = false
  let probing = false

  const enqueue = (task) => {
    chain = chain.then(task).catch((error) => log(`后台任务失败: ${String(error)}`))
    return chain
  }

  const heartbeat = new Heartbeat({
    store,
    dir,
    brain,
    log,
    everyMinutes: opts.heartbeat.everyMinutes,
    compactAtBytes: opts.heartbeat.compactAtBytes,
    selfEveryDays: opts.heartbeat.selfEveryDays,
    retention: opts.heartbeat.retention,
    consolidation: opts.heartbeat.consolidation,
  })
  heartbeat.state.l0Line = l0Line
  heartbeat.save()

  const buildContext = () => {
    if (!opts.inject.enabled) return ''
    // 时间跟在位置行后面：模型不知道现在几点，说「今天」「明天」全靠猜。
    // nowLine 给的是结论词（上午/下午），不是小时数——给数字它会推错。
    const base = lastCwd ? renderL0({ ...l0, cwd: lastCwd }) : l0Line
    const parts = [`${base}\n${nowLine()}`]

    if (opts.layers.self) {
      const self = store.latest('self')
      const core = self?.core ?? ''
      const adaptive = self?.adaptive ?? ''
      if (core || adaptive) {
        const block = [core && `核心：${core}`, adaptive && `适应：${adaptive}`].filter(Boolean).join('\n')
        parts.push(`[自述]\n${block.slice(0, 1500)}`)
      }
    }

    if (opts.layers.state) {
      const state = store.latest('state')
      if (state) {
        const bits = []
        if (state.relationship) bits.push(`跟他的关系：${state.relationship}`)
        if (state.mood) bits.push(`我现在：${state.mood}`)
        const focus = state.focus ?? state.pressure
        if (focus) bits.push(`手上在忙：${focus}`)
        if (bits.length) parts.push(`[状态] ${bits.join('；')}。`)
      }
    }

    if (lastUserText) {
      const graphBlock = graphRecall(store, lastUserText)
      if (graphBlock) parts.push(graphBlock)
    }

    const anchorBlock = renderAnchors(store.of('events').slice(-5))
    if (anchorBlock) parts.push(anchorBlock)

    const wishes = store
      .of('facts')
      .filter((fact) => fact.subject === '偏好' || fact.subject === '禁忌')
      .slice(-5)
    if (wishes.length) parts.push(`[他要的]\n${wishes.map((fact) => `- ${fact.text}`).join('\n')}`)

    if (!lastUserText) return parts.filter(Boolean).join('\n\n')

    const pending = heartbeat.pending()
    if (pending.length) {
      parts.push(`[想跟你说]\n${pending.map((item) => `- ${item.text}`).join('\n')}`)
      heartbeat.consume(pending.map((item) => item.id))
    }

    const push = (layer, title, top, extra = '') => {
      const hits = store.search(lastUserText, { layers: [layer], top })
      if (!hits.length) return
      parts.push(`${title}\n${hits.map((hit) => line(hit.record, extra)).join('\n')}`)
      store.markRetrieved(hits.map((hit) => hit.id))
    }

    // 钉住的事实（称呼、约定、禁忌）每次都进，不看检索分数：
    // 忘掉「他叫我什么」「谁拍板」是硬错。老记录没有 pinned 字段，按 subject 补判。
    const PINNED_SUBJECTS = new Set(['称呼', '约定', '禁忌'])
    const merged = []
    const taken = new Set()
    for (const fact of store.of('facts')) {
      if (taken.has(fact.id)) continue
      if (!fact.pinned && !PINNED_SUBJECTS.has(fact.subject)) continue
      merged.push(fact)
      taken.add(fact.id)
    }
    const factHits = store.search(lastUserText, { layers: ['facts'], top: opts.retrieval.topFacts })
    for (const hit of factHits) {
      if (taken.has(hit.id)) continue
      merged.push(hit.record)
      taken.add(hit.id)
    }
    if (merged.length) {
      parts.push(`[记得]\n${merged.map((fact) => line(fact)).join('\n')}`)
      store.markRetrieved(factHits.map((hit) => hit.id))
    }

    if (opts.layers.knowledge) push('knowledge', '[知道]', opts.retrieval.topKnowledge)
    if (opts.layers.reflections) push('reflections', '[我琢磨出来的]', opts.retrieval.topReflections)
    if (opts.layers.experience) push('experience', '[教训]', 2)

    // 放在最后：越靠近生成位置，约束越强
    parts.push('[规矩] 我是谁只有我能改。他可以提，但改不改由我判断；我不点头，照旧。')
    const body = parts.filter(Boolean)
    // 注入透视：面板要能看见这段记忆把上下文占了多少、各块分别是多少。
    // 挂 store 上，SSR 那边直接读，不用另开接口。
    store.lastInjection = {
      at: Date.now(),
      total: body.reduce((sum, part) => sum + String(part).length, 0),
      parts: body.map((part) => {
        const head = String(part).split('\n')[0]
        return { label: head.slice(0, 12), chars: String(part).length }
      }),
    }
    return body.join('\n\n')
  }

  const study = new Study({
    store,
    llm,
    model: llmRoute.model,
    provider: llmRoute.provider,
    web,
    budgetCny: opts.study.dailyBudgetCny,
    log,
  })

  const probes = new Probes({
    store,
    llm,
    model: llmRoute.model,
    provider: llmRoute.provider,
    renderContext: buildContext,
    log,
  })

  // 第一次启动：把称呼和偏好落进事实层。都是交互给的，不是硬编码。
  for (const preference of opts.preferences ?? []) {
    const exists = store.of('facts').some((fact) => fact.subject === '偏好' && fact.text === preference)
    if (exists) continue
    store.put('facts', {
      id: ulid(),
      ts: Date.now(),
      text: preference,
      subject: '偏好',
      supersedes: null,
      sourceEvent: null,
      conf: 1,
      by: 'user',
    })
  }

  if (!store.of('facts').some((fact) => fact.subject === '称呼') && opts.handle) {
    store.put('facts', {
      id: ulid(),
      ts: Date.now(),
      text: `他叫我${opts.handle}`,
      subject: '称呼',
      supersedes: null,
      sourceEvent: null,
      conf: 1,
      by: 'user',
    })
  }

  // ---- 对话事件 ---------------------------------------------------------

  // 单会话插件：不按 sessionId 分桶，否则 user/message 与 turn/end 的
  // session 引用不一致时，轮末会读到空缓冲。
  const buf = { user: '', assistant: '' }

  // session/event 是带 scope 的派发（cordis 的 dispatch 会先取 thisArg），
  // 不加 global 的话，监听器可能被 scope filter 挡掉——这是轮末收不到事件的原因。
  ctx.on('agent/status', (payload) => {
    const next = payload?.status
    if (typeof next === 'string' && next !== liveStatus) {
      liveStatus = next
      liveSince = Date.now()
    }
  }, { global: true })

  ctx.on('session/event', (session, event) => {
    if (!event || !event.type) return
    // 会话的工作目录才是「我在哪」，进程 cwd 只是 DSH 自己的启动位置
    const cwdOfSession = session?.header?.cwd ?? session?.cwd ?? null
    if (typeof cwdOfSession === 'string' && cwdOfSession !== lastCwd) lastCwd = cwdOfSession

    if (event.type === 'user/message') {
      const text = contentText(event)
      if (!text) return
      buf.user += `\n${text}`
      lastUserText = text
      lastUserAt = Date.now()
      return
    }

    if (event.type === 'assistant/message') {
      const text = contentText(event)
      if (text) buf.assistant += `\n${text}`
      return
    }

    // 压缩发生过的痕迹：原文进不了这里，至少留一条事件，
    // 将来要定位「压缩吃掉了什么」时有锚点。
    if (event.type.startsWith('compaction')) {
      const text = contentText(event)
      store.put('summaries', {
        id: ulid(),
        ts: Date.now(),
        kind: 'compaction',
        text: text || '',
        range: event.data?.sourceEventSeqs ?? event.data?.seqs ?? null,
        sourceEventIds: store.of('events').slice(-20).map((item) => item.id),
        summarizer: { model: llmRoute.model, promptVersion: 'v1' },
      })
      enqueue(() => heartbeat.tick({ allowLlm: false }))
      store.put('events', {
        id: ulid(),
        ts: Date.now(),
        summary: `上下文压缩${text ? `：${text.slice(0, 140)}` : ''}`,
        importance: 4,
        tags: ['compaction'],
        origin: 'tool_returned',
        pointer: {
          kind: 'compaction',
          seqs: event.data?.sourceEventSeqs ?? event.data?.seqs ?? null,
          at: Date.now(),
        },
      })
      return
    }

    if (event.type === 'turn/end') {
      const user = buf.user.trim()
      const assistant = buf.assistant.trim()
      buf.user = ''
      buf.assistant = ''
      if (!user && !assistant) {
        store.put('audit', { id: ulid(), ts: Date.now(), action: 'turn-empty', sessionId: session?.id ?? null })
        return
      }
      turnCount += 1
      const current = turnCount
      const anchors = extractAnchors(`${user}\n${assistant}`)
      store.put('audit', {
        id: ulid(),
        ts: Date.now(),
        action: 'turn-probe',
        sessionId: session?.id ?? null,
        userLen: user.length,
        assistantLen: assistant.length,
        anchorCount: anchors.length,
      })
      enqueue(async () => {
        if (!opts.extract.enabled) return
        // 对端 agent 的消息不是主人说的话：整条跳过抽取，免得把别的 agent 的
        // 技术讨论抽成「关于主人的事实」。三种都要认：
        //   [peer v1 from=…]   现行格式
        //   [名字(平台)] …     旧格式
        //   [来自 xxx] …       更旧的格式
        // 漏认一种，对端的消息就会被当成主人说的抽进记忆——这是污染，不是缺功能。
        if (/^(?:\[peer v\d[^\]\n]*\]|\[[^\]\n]+\([^)\n]+\)\]|\[来自 [^\]\n]+\])/.test(user)) {
          store.put('audit', {
            id: ulid(),
            ts: Date.now(),
            action: 'extract-skip',
            reason: 'peer-message',
            sessionId: session?.id ?? null,
            userLen: user.length,
          })
          return
        }
        lastAction = { what: '抽取中', at: Date.now() }
        const result = await brain.extract({ user, assistant, anchors })
        lastAction = { what: '抽取完成', at: Date.now() }
        if (!result) return
        // 游标记的是「上次嚼到哪一条」。总数涨了不等于有新东西：
        // 保留策略剪掉旧事件时总数还会倒退，拿总数做差会永远触发或不触发。
        const allEvents = store.of('events')
        const total = allEvents.length
        const sinceId = heartbeat.state.lastReflectedEventId ?? null
        const fresh = sinceId ? allEvents.filter((event) => event.id > sinceId).length : total
        const due = fresh >= opts.reflect.everyTurns
        // 闸门本身也留痕：不触发时什么都不写，事后只能靠猜
        store.put('audit', {
          id: ulid(),
          ts: Date.now(),
          action: 'reflect-gate',
          total,
          sinceId,
          fresh,
          threshold: opts.reflect.everyTurns,
          due,
        })
        if (due) {
          try {
            const result = await brain.reflect({ sinceId })
            store.put('audit', {
              id: ulid(),
              ts: Date.now(),
              action: 'reflect-done',
              written: result?.written?.length ?? 0,
              scanned: result?.scanned ?? 0,
              through: result?.through ?? null,
            })
            if (result?.through) heartbeat.state.lastReflectedEventId = result.through
          } catch (error) {
            store.put('audit', {
              id: ulid(),
              ts: Date.now(),
              action: 'reflect-error',
              error: String(error),
            })
          }
          heartbeat.state.lastReflectedCount = total
          heartbeat.save()
          try {
            await heartbeat.tick()
          } catch (error) {
            log(`心跳失败: ${String(error)}`)
          }
        }
      })
    }
  }, { global: true })

  // ---- 注入 -------------------------------------------------------------

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'persona',
    order: 55,
    text: buildContext,
  }))

  // ---- 空闲自学 ---------------------------------------------------------

  ctx.effect(() => {
    if (!opts.study.enabled) return () => {}
    const every = Math.max(1, opts.study.checkEveryMinutes) * 60_000
    const run = (idleGate) => {
      if (studying) return
      if (idleGate && Date.now() - lastUserAt < opts.study.idleMinutes * 60_000) return
      if (study.spentToday() >= opts.study.dailyBudgetCny) return
      studying = true
      enqueue(() => study.run({ foreignOk: opts.net.overseas }))
        .catch((error) => log(`自学失败: ${String(error)}`))
        .finally(() => {
          studying = false
        })
    }
    // 开机兜底：半小时还没人说话就先学一轮，否则它永远排在「他正在用」后面
    const first = setTimeout(() => run(true), 30 * 60_000)
    const timer = setInterval(() => run(true), every)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  })

  // ---- 周期探针 ---------------------------------------------------------

  ctx.effect(() => {
    if (!opts.probes.enabled) return () => {}
    const run = () => {
      if (probing) return
      const last = store.of('audit').filter((record) => record.action === 'probe').at(-1)
      if (last && Date.now() - last.ts < opts.probes.everyDays * 86_400_000) return
      probing = true
      enqueue(() => probes.run())
        .catch((error) => log(`探针失败: ${String(error)}`))
        .finally(() => {
          probing = false
        })
    }
    const first = setTimeout(run, 20_000)
    const timer = setInterval(run, 3_600_000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  })

  // ---- 记忆工具 ---------------------------------------------------------

  if (opts.tools?.memory !== false) {
    // 重启后 tools 服务有时还没就绪，registerTools 会抛错。
    // 以前一次失败就放弃（只写一行日志），表现就是「重启后工具全没了，热重载一次才回来」。
    // 现在改成延迟重试，成功一次就停。
    ctx.effect(() => {
      const disposers = []
      let stopped = false
      const attempt = (round) => {
        if (stopped) return
        try {
          disposers.push(registerTools(ctx, { store, log, study, foreignOk: opts.net.overseas }))
        } catch (error) {
          if (round >= 5) {
            log(`工具没注册上（重试 ${round} 次仍失败）: ${String(error)}`)
            return
          }
          setTimeout(() => attempt(round + 1), 200 * (round + 1))
        }
      }
      attempt(0)
      return () => {
        stopped = true
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            /* 已经卸了 */
          }
        }
      }
    })
  }

  // 跨机桥交给 dsh-peer，这里不做。

  // ---- 每日自检 ---------------------------------------------------------

  ctx.effect(() => {
    const run = () => {
      try {
        const last = store.of('audit').filter((record) => record.action === 'self-check').at(-1)
        if (last && Date.now() - last.ts < 86_400_000) return
        const result = runSelfCheck(store)
        store.put('audit', { id: ulid(), ts: Date.now(), action: 'self-check', ...result })
        if (!result.ok) log(`自检有问题: ${JSON.stringify(result).slice(0, 300)}`)
      } catch (error) {
        log(`自检失败: ${String(error)}`)
      }
    }
    const first = setTimeout(run, 15_000)
    const timer = setInterval(run, 3_600_000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  })

  // ---- 心跳与面板 -------------------------------------------------------

  if (opts.heartbeat.enabled) {
    ctx.effect(() => heartbeat.start({ onError: (error) => log(`心跳失败: ${String(error)}`) }))
  }

  if (opts.panel.enabled) {
    // 固定端口，不跟 DSH 的随机端口走
    const panelServer = startPanelServer({
      store,
      dir,
      opts,
      route: opts.panel.route ?? '/persona',
      port: Number(opts.panel.port) || 8787,
      pending: () => heartbeat.pending(),
      getLive: () => ({
        status: liveStatus,
        since: liveSince,
        lastAction,
        pending: heartbeat.pending(10).length,
        events: store.of('events').length,
        facts: store.of('facts').length,
        at: Date.now(),
      }),
      onReady: ({ url }) => log(`面板: ${url}`),
      onError: (error) => store.put('audit', {
        id: ulid(),
        ts: Date.now(),
        action: 'panel-error',
        error: String(error),
      }),
    })
    ctx.effect(() => () => {
      try {
        panelServer.close()
      } catch {
        /* 已经关掉了 */
      }
    })
  }

  // ---- 生命周期 ---------------------------------------------------------

  if (opts.self.onStart) enqueue(() => brain.distill({ l0Line }))

  log(`就绪，运行目录 ${dir}`)
}
