/**
 * 心跳：静默维护，不主动说话。
 * 每次醒来看几件事：journal 该不该压实、自述该不该重凝、待说的话过没过期。
 * 欠下的心跳在下次启动时补跑，最多补三次，避免一次开机跑一百轮。
 */
import fs from 'node:fs'
import path from 'node:path'

import { ulid } from './store.js'

const MAX_CATCHUP = 3

export class Heartbeat {
  constructor({
    store,
    dir,
    brain,
    log = () => {},
    everyMinutes = 30,
    compactAtBytes = 5 * 1024 * 1024,
    selfEveryDays = 7,
    pendingTtlDays = 7,
    maxActions = 20,
    retention = { eventsDays: 90, auditDays: 30, keepImportant: 7 },
    consolidation = { enabled: false },
  }) {
    this.store = store
    this.dir = dir
    this.brain = brain
    this.log = log
    this.everyMinutes = everyMinutes
    this.compactAtBytes = compactAtBytes
    this.selfEveryDays = selfEveryDays
    this.pendingTtlDays = pendingTtlDays
    this.maxActions = maxActions
    this.retention = retention
    this.consolidation = consolidation
    this.file = path.join(dir, 'heartbeat.json')
    this.state = this.load()
    this.timer = null
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return { lastBeat: 0, beats: 0 }
    }
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2))
    } catch (error) {
      this.log(`心跳状态写不进去: ${String(error)}`)
    }
  }

  /** 攒一句想说还没说的话，等下次用户开口时自然带出来。 */
  say(text, meta = {}) {
    if (!text) return null
    const record = {
      id: ulid(),
      ts: Date.now(),
      action: 'pending',
      text: String(text).slice(0, 300),
      consumed: false,
      ...meta,
    }
    this.store.put('audit', record)
    return record
  }

  pending(limit = 3) {
    return this.store
      .of('audit')
      .filter((record) => record.action === 'pending' && !record.consumed)
      .slice(-limit)
      .reverse()
  }

  consume(ids) {
    for (const id of ids) {
      const record = this.store.get(id)
      if (!record) continue
      this.store.put('audit', { ...record, consumed: true })
    }
  }

  /** 一次维护。返回做了哪些事，方便测试和面板显示。 */
  async tick({ allowLlm = true } = {}) {
    const actions = []
    const overBudget = () => actions.length >= this.maxActions

    // 1. journal 太大就压实
    try {
      const size = fs.existsSync(this.store.file) ? fs.statSync(this.store.file).size : 0
      if (size > this.compactAtBytes) {
        const result = this.store.compact()
        actions.push({ compact: result })
      }
    } catch (error) {
      actions.push({ compactError: String(error) })
    }

    // 2. 自述到期且攒够反思
    if (allowLlm) {
      try {
        const current = this.store.latest('self')
        const due = !current || Date.now() - (current.ts ?? 0) > this.selfEveryDays * 86_400_000
        const reflections = this.store.of('reflections')
        if (due && reflections.length >= 3) {
          const version = this.brain
            ? await this.brain.distill({ l0Line: this.state.l0Line ?? '' })
            : null
          if (version) actions.push({ distilled: version.id ?? 'rejected' })
        }
      } catch (error) {
        actions.push({ distillError: String(error) })
      }
    }

    if (overBudget()) return actions

    // 3. 自述观察期：落盘后一段时间没有新证据支持，回退到上一版
    try {
      const self = this.store.latest('self')
      if (self?.diffFrom && self.appliedAtEventCount != null) {
        const added = this.store.of('events').length - self.appliedAtEventCount
        const age = Date.now() - (self.ts ?? 0)
        if (added < 3 && age > this.selfEveryDays * 86_400_000) {
          const previous = this.store.get(self.diffFrom)
          if (previous) {
            this.store.put('self', {
              ...previous,
              id: ulid(),
              ts: Date.now(),
              restoredFrom: self.id,
              restoredBecause: '观察期内没有新证据',
            })
            actions.push({ rolledBack: self.id })
          }
        }
      }
    } catch (error) {
      actions.push({ rollbackError: String(error) })
    }

    if (overBudget()) return actions

    // 4. 事件层覆盖窗口审计：掉出预期窗口说明经历层被静默裁掉了
    const events = this.store.of('events')
    if (events.length) {
      const oldest = events[0].ts ?? Date.now()
      const days = Math.floor((Date.now() - oldest) / 86_400_000)
      const previous = this.state.coverageDays ?? days
      this.state.coverageDays = days
      if (days < previous) actions.push({ coverageShrank: { from: previous, to: days } })
    }

    // 5. 待说的话过期就丢
    const ttl = this.pendingTtlDays * 86_400_000
    for (const record of this.store.of('audit')) {
      if (record.action !== 'pending' || record.consumed) continue
      if (Date.now() - record.ts > ttl) {
        this.store.del('audit', record.id, 'pending-expired')
        actions.push({ dropped: record.id })
      }
    }

    // 6. 保留策略：事件层和审计层会一直涨，超出窗口的低价值记录裁掉
    try {
      const now = Date.now()
      const referenced = new Set(
        this.store.of('reflections').flatMap((item) => item.becauseOf ?? []),
      )
      let dropped = 0
      for (const event of this.store.of('events')) {
        if (event.tags?.includes('compaction')) continue
        if (referenced.has(event.id)) continue
        if ((event.importance ?? 0) >= this.retention.keepImportant) continue
        if ((event.anchors ?? []).length) continue
        if (now - (event.ts ?? 0) < this.retention.eventsDays * 86_400_000) continue
        this.store.del('events', event.id, 'retention')
        dropped += 1
      }
      const keepActions = new Set(['pending', 'self-check', 'probe', 'self-proposal', 'self-rejected'])
      for (const record of this.store.of('audit')) {
        if (keepActions.has(record.action)) continue
        if (now - (record.ts ?? 0) < this.retention.auditDays * 86_400_000) continue
        this.store.del('audit', record.id, 'retention')
        dropped += 1
      }
      if (dropped) actions.push({ retentionDropped: dropped })
    } catch (error) {
      actions.push({ retentionError: String(error) })
    }

    // 7. 检索计数落盘
    // 命中数原来只活在内存 Map 里，重启归零，经验层的 utility 永远是 0——
    // 按 utility 淘汰等于随机淘汰，「效用最低」这个理由是假的。这里每轮心跳把
    // 增量写回记录本身，随正常回放恢复，不用新开一层。
    try {
      let flushed = 0
      for (const [id, count] of this.store.retrieved) {
        if (!count) continue
        const record = this.store.get(id)
        if (!record) continue
        const hits = (record.hits ?? 0) + count
        const next = { ...record, hits, lastHitAt: Date.now() }
        if (record.layer === 'experience') {
          next.utility = hits
          next.lastUsed = Date.now()
        }
        // 被用到的记忆会重新变实：遗忘曲线的另一半
        if (record.layer === 'facts' && !record.pinned) {
          next.weight = Math.min(1, (record.weight ?? 1) + 0.05 * count)
        }
        this.store.put(record.layer, next)
        flushed += 1
      }
      this.store.retrieved.clear()
      if (flushed) actions.push({ usageFlushed: flushed })
    } catch (error) {
      actions.push({ usageError: String(error) })
    }

    // 8. 每日遗忘：没被用到的记忆慢慢变淡，钉住的（称呼、禁忌）不动。
    // 0.998/天，下限 0.1：两年也掉不到底线以下，只是让它排得靠后。
    // 首次运行不衰减——升级那天一次性改几百条记录没意义。
    try {
      const last = this.state.lastDecayAt ?? Date.now()
      const days = Math.floor((Date.now() - last) / 86_400_000)
      if (days >= 1) {
        let decayed = 0
        for (const fact of this.store.of('facts')) {
          if (fact.pinned) continue
          const current = fact.weight ?? 1
          const nextWeight = Math.max(0.1, current * Math.pow(0.998, days))
          // 只在百分位真的变了才写，否则每天给每条事实刷一行 journal
          if (Math.round(nextWeight * 100) === Math.round(current * 100)) continue
          this.store.put('facts', { ...fact, weight: Number(nextWeight.toFixed(4)), decayedAt: Date.now() })
          decayed += 1
        }
        this.state.lastDecayAt = Date.now()
        if (decayed) actions.push({ decayed })
      }
    } catch (error) {
      actions.push({ decayError: String(error) })
    }

    // 9. 记忆合并：又旧又淡的事实压成更少的条目。
    // 门槛很高（600 天没用到才会淡到这个程度），所以它基本不跑——留着当压力阀。
    if (allowLlm && this.consolidation?.enabled && this.brain?.consolidate) {
      try {
        const merged = await this.brain.consolidate(this.consolidation)
        if (merged?.length) actions.push({ consolidated: merged.length })
      } catch (error) {
        actions.push({ consolidateError: String(error) })
      }
    }

    this.state.lastBeat = Date.now()
    this.state.beats = (this.state.beats ?? 0) + 1
    this.save()
    return actions
  }

  /** 启动：欠账补跑，然后挂定时器。返回可清理的 disposer。 */
  start({ onError } = {}) {
    const interval = this.everyMinutes * 60_000
    const owed = this.state.lastBeat
      ? Math.min(MAX_CATCHUP, Math.floor((Date.now() - this.state.lastBeat) / interval))
      : 0

    const run = async () => {
      try {
        const actions = await this.tick()
        if (actions.length) this.log(`心跳: ${JSON.stringify(actions).slice(0, 200)}`)
      } catch (error) {
        onError?.(error)
      }
    }

    if (owed > 0) {
      // 补跑不调模型，只整理，避免开机时突然多花几毛钱
      Promise.resolve().then(() => this.tick({ allowLlm: false })).catch((error) => onError?.(error))
    }

    this.timer = setInterval(run, interval)
    return () => {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
    }
  }
}
