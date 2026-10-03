/**
 * 协作引擎规则冒烟测试（纯 Node，不依赖 DOM）
 * 运行：node --experimental-strip-types src/collab/engine.test.ts
 */
// @ts-nocheck
// 规则冒烟测试：以 esbuild 直接在 Node 运行（见 package.json 的 test:collab），不引入 @types/node
import assert from 'node:assert/strict'

// ---- 最小 localStorage / window polyfill ----
const mem = new Map<string, string>()
const g = globalThis as any
g.localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
}
g.window = { addEventListener() {}, removeEventListener() {} }

import { bootstrap, commit, adoptConflict, discardConflict, loadDoc, pendingConflictCount, buildNoticeText } from '../engine'
import type { CommitRequest } from '../engine'

let pass = 0
function test(name: string, fn: () => void) {
  fn()
  pass++
  console.log(`  ✓ ${name}`)
}

function reset() {
  mem.clear()
  bootstrap()
}
function stageReq(opts: { baseVersion?: number; unit?: any; stageId?: string; patch: any; id?: string }): CommitRequest {
  const doc = loadDoc()
  const stage = doc.scheme.stages.find((s) => s.id === (opts.stageId ?? 'ST-02'))!
  const after = { ...JSON.parse(JSON.stringify(stage)), ...opts.patch }
  return {
    commitId: opts.id ?? `S-test-${Math.random().toString(36).slice(2, 8)}`,
    baseVersion: opts.baseVersion ?? doc.scheme.version,
    unit: opts.unit ?? '建设',
    author: `${opts.unit ?? '建设'}单位测试员`,
    kinds: ['stage'],
    summary: `测试修改 ${stage.id}`,
    patches: [{ kind: 'stage', stageId: stage.id, before: JSON.parse(JSON.stringify(stage)), after }],
  }
}

console.log('引擎规则测试')

// 1. 正常提交：版本推进
reset()
test('先提交者生效，版本号 +1', () => {
  const v0 = loadDoc().scheme.version
  const r = commit(stageReq({ patch: { lanes: '测试车道' } }))
  assert.equal(r.outcome, 'applied')
  if (r.outcome === 'applied') assert.equal(r.version, v0 + 1)
})

// 2. 同号只留首次结果
reset()
test('同提交号重复提交：返回首次结果，版本不二次推进', () => {
  const v0 = loadDoc().scheme.version
  const req = stageReq({ id: 'S-DUP-1', patch: { lanes: '第一次内容' } })
  const r1 = commit(req)
  const v1 = loadDoc().scheme.version
  // 用相同提交号、相同基准，再发一次（即使内容被改）
  const tampered = JSON.parse(JSON.stringify(req))
  tampered.patches[0].after.lanes = '第二次篡改内容'
  const r2 = commit(tampered)
  assert.equal(r1.outcome, 'applied')
  assert.equal(r2.outcome, 'duplicate')
  if (r2.outcome === 'duplicate') {
    assert.equal(r2.applied, true)
    assert.equal(r2.version, v1)
  }
  assert.equal(loadDoc().scheme.version, v1)
  assert.equal(loadDoc().scheme.stages.find((s: any) => s.id === 'ST-02').lanes, '第一次内容')
  assert.equal(loadDoc().scheme.version, v0 + 1)
})

// 3. 同基准并发：后到者 → 冲突草稿，不生效
reset()
test('同基准并发：后到提交不生效，内容保留为冲突草稿', () => {
  const v0 = loadDoc().scheme.version
  const reqA = stageReq({ id: 'S-WIN', unit: '建设', patch: { lanes: '建设单位先保存' } })
  const reqB = stageReq({ id: 'S-LOSE', unit: '交通', baseVersion: v0, patch: { lanes: '交通单位后保存' } })
  const rA = commit(reqA)
  const rB = commit(reqB)
  assert.equal(rA.outcome, 'applied')
  assert.equal(rB.outcome, 'conflict')
  assert.equal(pendingConflictCount(), 1)
  assert.equal(loadDoc().scheme.stages.find((s: any) => s.id === 'ST-02').lanes, '建设单位先保存')
  if (rB.outcome === 'conflict') {
    assert.equal(rB.draft.winnerVersion, v0 + 1)
    assert.equal(rB.draft.patches[0].after.lanes, '交通单位后保存')
  }
})

// 4. 同号的冲突也是幂等的
reset()
test('冲突提交用同号重试：不产生第二份草稿', () => {
  const v0 = loadDoc().scheme.version
  commit(stageReq({ id: 'S-WIN2', unit: '建设', patch: { lanes: '先' } }))
  const loser = stageReq({ id: 'S-LOSE2', unit: '交通', baseVersion: v0, patch: { lanes: '后' } })
  const c1 = commit(JSON.parse(JSON.stringify(loser)))
  const c2 = commit(JSON.parse(JSON.stringify(loser)))
  assert.equal(c1.outcome, 'conflict')
  assert.equal(c2.outcome, 'duplicate')
  if (c2.outcome === 'duplicate') assert.equal(c2.applied, false)
  assert.equal(pendingConflictCount(), 1)
})

// 5. 阶段起止变化 → 待处理意见失效重算
reset()
test('阶段起止变化：依附旧版本的待处理意见立即失效并重挂新版本', () => {
  const before = loadDoc().scheme.comments.find((c: any) => c.id === 'CM-41')
  assert.equal(before.status, '待处理')
  assert.equal(before.invalid ?? false, false)
  const r = commit(stageReq({ stageId: 'ST-01', patch: { start: '2026-10-10' } }))
  assert.equal(r.outcome, 'applied')
  const doc = loadDoc()
  const cm = doc.scheme.comments.find((c: any) => c.id === 'CM-41')
  assert.equal(cm.invalid, true)
  assert.equal(cm.status, '待处理')
  assert.equal(cm.basisVersion, doc.scheme.version)
  assert.ok(cm.recomputeNote?.includes('失效'))
})

// 5b. 只改车道/名称等非锚点字段：意见不失效
reset()
test('仅修改车道方案（非起止/路线锚点）：待处理意见不失效', () => {
  commit(stageReq({ stageId: 'ST-01', patch: { lanes: '双向 4 收窄为 1' } }))
  const cm = loadDoc().scheme.comments.find((c: any) => c.id === 'CM-41')
  assert.equal(cm.invalid ?? false, false)
})

// 6. 封路线变化 → 已接受意见转待复核，冻结依据保留
reset()
test('封路路线变化：已接受意见转待复核，冻结依据保留', () => {
  const r = commit(stageReq({
    stageId: 'ST-02',
    patch: { route: [[121.5, 31.24], [121.52, 31.25]] },
  }))
  assert.equal(r.outcome, 'applied')
  const cm = loadDoc().scheme.comments.find((c: any) => c.id === 'CM-42')
  assert.equal(cm.status, '待复核')
  assert.ok(cm.frozenBasis, '冻结依据必须保留')
  assert.equal(cm.frozenBasis.version, 7)
  assert.ok(cm.recomputeNote?.includes('待复核'))
})

// 7. 待复核意见重新接受 → 重新冻结到当前版本
reset()
test('待复核意见复核通过：按当前版本重新冻结依据', () => {
  commit(stageReq({ stageId: 'ST-02', patch: { end: '2026-11-10' } }))
  const vAfter = loadDoc().scheme.version
  let cm = loadDoc().scheme.comments.find((c: any) => c.id === 'CM-42')
  assert.equal(cm.status, '待复核')
  const req = {
    commitId: 'R-RECHECK-1', baseVersion: vAfter, unit: '应急' as const, author: '夏川',
    kinds: ['comment' as const], summary: '复核通过',
    patches: [{ kind: 'comment' as const, commentId: 'CM-42', before: JSON.parse(JSON.stringify(cm)), after: { ...JSON.parse(JSON.stringify(cm)), status: '已接受' as const } }],
  }
  const r = commit(req)
  assert.equal(r.outcome, 'applied')
  cm = loadDoc().scheme.comments.find((c: any) => c.id === 'CM-42')
  assert.equal(cm.status, '已接受')
  assert.equal(cm.frozenBasis.version, vAfter + 1)
})

// 8. 失效意见重新确认 → 挂接当前版本，invalid 清除
reset()
test('失效重算的意见重新确认后挂接当前版本、失效标记清除', () => {
  commit(stageReq({ stageId: 'ST-01', patch: { start: '2026-10-11' } }))
  const v = loadDoc().scheme.version
  let cm = loadDoc().scheme.comments.find((c: any) => c.id === 'CM-41')
  assert.equal(cm.invalid, true)
  commit({
    commitId: 'R-RECONF-1', baseVersion: v, unit: '公交' as const, author: '顾敏',
    kinds: ['comment' as const], summary: '重新确认',
    patches: [{ kind: 'comment' as const, commentId: 'CM-41', before: JSON.parse(JSON.stringify(cm)), after: { ...JSON.parse(JSON.stringify(cm)), status: '待处理' as const } }],
  })
  cm = loadDoc().scheme.comments.find((c: any) => c.id === 'CM-41')
  assert.equal(cm.invalid, false)
  assert.equal(cm.basisVersion, v + 1)
})

// 9. 采纳冲突草稿 → 合并生效并级联
reset()
test('采纳冲突草稿：以当前版本重放，版本推进，冲突标记已采纳', () => {
  const v0 = loadDoc().scheme.version
  commit(stageReq({ id: 'S-WIN3', unit: '建设', stageId: 'ST-01', patch: { lanes: '建设改车道' } }))
  const loser = stageReq({ id: 'S-LOSE3', unit: '交通', baseVersion: v0, stageId: 'ST-01', patch: { start: '2026-10-15' } })
  const cr = commit(loser)
  assert.equal(cr.outcome, 'conflict')
  const draftId = loadDoc().conflicts[0].id
  const ar = adoptConflict(draftId, '交通', '郑航')
  assert.equal(ar.outcome, 'applied')
  const doc = loadDoc()
  if (ar.outcome === 'applied') assert.equal(ar.version, v0 + 2)
  assert.equal(doc.conflicts[0].status, '已采纳')
  const st = doc.scheme.stages.find((s: any) => s.id === 'ST-01')!
  assert.equal(st.lanes, '建设改车道') // 先提交者的内容保留
  assert.equal(st.start, '2026-10-15') // 草稿内容叠加生效
  // ST-01 起止变化 → CM-41 失效
  assert.equal(doc.scheme.comments.find((c: any) => c.id === 'CM-41')!.invalid, true)
  assert.equal(pendingConflictCount(), 0)
})

// 10. 放弃冲突草稿
reset()
test('放弃冲突草稿：不合并，留痕，待处理数清零', () => {
  const v0 = loadDoc().scheme.version
  commit(stageReq({ id: 'S-WIN4', unit: '建设', patch: { lanes: '先' } }))
  const cr = commit(stageReq({ id: 'S-LOSE4', unit: '交通', baseVersion: v0, patch: { lanes: '后' } }))
  assert.equal(cr.outcome, 'conflict')
  const draftId = loadDoc().conflicts[0].id
  discardConflict(draftId, '交通', '郑航')
  const doc = loadDoc()
  assert.equal(doc.conflicts[0].status, '已放弃')
  assert.equal(doc.scheme.stages.find((s: any) => s.id === 'ST-02')!.lanes, '先')
  assert.equal(pendingConflictCount(), 0)
})

// 11. 导出闸门：有冲突时导出动作不允许（由 store 层判断），引擎层面通告提交带版本戳
reset()
test('通告文本包含版本与提交号；通告提交后版本推进并锁定', () => {
  const v0 = loadDoc().scheme.version
  const commitId = 'P-NOTICE-1'
  const text = buildNoticeText(loadDoc().scheme, commitId)
  assert.ok(text.includes(`v${v0}`))
  assert.ok(text.includes(commitId))
  const r = commit({
    commitId, baseVersion: v0, unit: '建设' as const, author: '市政建设集团',
    kinds: ['notice' as const], summary: '导出通告',
    patches: [{ kind: 'notice' as const, text }],
  })
  assert.equal(r.outcome, 'applied')
  const doc = loadDoc()
  assert.equal(doc.scheme.notice.exported, true)
  assert.equal(doc.scheme.notice.version, v0 + 1)
  assert.ok(doc.noticeText.includes(`通告版本：v${v0 + 1}`))
  assert.ok(doc.noticeText.includes(commitId))
})

// 12. 通告提交撞上并发：也变冲突草稿，不能静默导出
reset()
test('通告导出撞并发：不生效，保留为冲突草稿', () => {
  const v0 = loadDoc().scheme.version
  commit(stageReq({ id: 'S-WIN5', unit: '建设', patch: { lanes: '抢跑' } }))
  const r = commit({
    commitId: 'P-NOTICE-2', baseVersion: v0, unit: '交通' as const, author: '郑航',
    kinds: ['notice' as const], summary: '通告', patches: [{ kind: 'notice' as const, text: 'old' }],
  })
  assert.equal(r.outcome, 'conflict')
  assert.equal(loadDoc().scheme.notice.exported, false)
})

console.log(`\n全部 ${pass} 项测试通过。`)
