/**
 * 自检：不需要人看数据也能跑的几项。
 *   1. 锚点回读率 —— 埋进去的路径/版本/日期还能不能检索回来
 *   2. 失效链完整性 —— 被替代的事实有没有指向不存在的记录
 *   3. 证据完整性 —— 反思和自述引用的东西还在不在
 */
export function runSelfCheck(store) {
  const now = Date.now()
  const events = store.of('events')

  let anchorsTried = 0
  let anchorsHit = 0
  // 只统计有区分度的锚点：'0.2'、'127' 这种本来就不该指望能精确回读
  const usable = (list) => (Array.isArray(list) ? list : []).filter(
    (anchor) => typeof anchor === 'string' && anchor.trim().length >= 8 && /[\/\\:]|\.\d/.test(anchor),
  )
  for (const event of events.slice(-30)) {
    for (const anchor of usable(event.anchors).slice(0, 2)) {
      anchorsTried += 1
      const found = store.search(anchor, { top: 5, now })
      if (found.some((hit) => hit.id === event.id)) anchorsHit += 1
    }
  }

  const facts = store.of('facts')
  const danglingSupersede = facts.filter((fact) => fact.supersedes && !store.get(fact.supersedes))

  const reflections = store.of('reflections')
  const brokenReflections = reflections.filter((item) =>
    (item.becauseOf ?? []).some((id) => !store.get(id)),
  )

  const self = store.latest('self')
  const brokenSelf = self ? (self.evidence ?? []).filter((id) => !store.get(id)) : []

  return {
    at: now,
    counts: store.stats(),
    anchorRecall: anchorsTried ? Number((anchorsHit / anchorsTried).toFixed(2)) : null,
    anchorsTried,
    danglingSupersede: danglingSupersede.length,
    brokenReflections: brokenReflections.length,
    brokenSelf: brokenSelf.length,
    selfAppliedAt: self?.ts ?? null,
    selfEvidence: self?.evidence?.length ?? 0,
    ok:
      danglingSupersede.length === 0 &&
      brokenReflections.length === 0 &&
      brokenSelf.length === 0,
  }
}
