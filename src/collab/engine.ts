import type { ClosureStage, FrozenBasis, Scheme, SegmentComment, Unit } from '../types'

/**
 * 版本协作引擎
 * ---------------
 * 以 localStorage 模拟共享文档库（同一浏览器的多个标签页即四家并发单位）。
 * 规则：
 *  - 每次保存携带 commitId（提交号）与 baseVersion（基准版本）
 *  - 同号只留首次结果：seen 日志幂等去重，重试返回第一次的结论
 *  - 同基准并发：版本号线性推进，基准落后者一律不生效，内容保留为冲突草稿
 *  - 阶段起止 / 封路线变化后：依附旧版本的待处理意见失效重算；已接受意见保留冻结依据并转待复核
 *  - 冲突草稿未处理完，公开通告不可导出
 */

const DOC_KEY = 'yy54-road-scheme-collab-v2'

export type CommitKind = 'stage' | 'comment' | 'notice' | 'merge'

export interface StagePatch {
  kind: 'stage'
  stageId: string
  before: ClosureStage | null
  after: ClosureStage | null
}
export interface CommentPatch {
  kind: 'comment'
  commentId: string
  before: SegmentComment | null
  after: SegmentComment | null
}
export interface NoticePatch {
  kind: 'notice'
  text: string
}
export type Patch = StagePatch | CommentPatch | NoticePatch

export interface CommitRequest {
  commitId: string
  baseVersion: number
  unit: Unit
  author: string
  kinds: CommitKind[]
  summary: string
  patches: Patch[]
}

export interface CommitRecord {
  commitId: string
  baseVersion: number
  version: number | null
  applied: boolean
  unit: Unit
  author: string
  kinds: CommitKind[]
  summary: string
  at: number
  note?: string
  patches: Patch[]
  event?: 'adopt-conflict' | 'discard-conflict'
  refCommitId?: string
}

export type ConflictStatus = '待处理' | '已采纳' | '已放弃'

export interface ConflictDraft {
  id: string
  commitId: string
  baseVersion: number
  winnerVersion: number
  winnerCommitId: string
  winnerSummary: string
  unit: Unit
  author: string
  kinds: CommitKind[]
  summary: string
  at: number
  status: ConflictStatus
  patches: Patch[]
  resolvedCommitId?: string
  resolvedAt?: number
}

interface SeenEntry {
  commitId: string
  applied: boolean
  version: number | null
}

export interface RemoteDoc {
  scheme: Scheme
  noticeText: string | null
  seen: SeenEntry[]
  history: CommitRecord[]
  conflicts: ConflictDraft[]
}

export type CommitResult =
  | { outcome: 'applied'; version: number; commitId: string; scheme: Scheme }
  | { outcome: 'duplicate'; applied: boolean; version: number | null; commitId: string; scheme: Scheme }
  | { outcome: 'conflict'; draft: ConflictDraft; scheme: Scheme }

/* ---------------- 工具 ---------------- */

export function uid(prefix = 'C'): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}-${rand}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function routesEqual(a?: [number, number][], b?: [number, number][]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
}

/** 阶段的哪些“锚点”字段发生变化（起止、封路线） */
export function anchorChanges(before: ClosureStage | null, after: ClosureStage | null): string[] {
  if (!before || !after) return ['阶段新增或删除']
  const changed: string[] = []
  if (before.start !== after.start) changed.push('开始时间')
  if (before.end !== after.end) changed.push('结束时间')
  if (!routesEqual(before.route, after.route)) changed.push('封路路线')
  return changed
}

function snapshotStage(stage: ClosureStage | undefined, version: number, commitId: string): FrozenBasis | null {
  if (!stage) return null
  return {
    version,
    commitId,
    stageName: stage.name,
    start: stage.start,
    end: stage.end,
    lanes: stage.lanes,
    route: clone(stage.route),
    frozenAt: Date.now(),
  }
}

/* ---------------- 初始文档 ---------------- */

function seedDoc(): RemoteDoc {
  const scheme: Scheme = {
    id: 'RC-2026-0918',
    project: '云河路快速化改造',
    contractor: '市政建设集团第三工程处',
    area: '云河路 / 江海大道',
    version: 7,
    stages: [
      { id: 'ST-01', name: '第一阶段 · 东半幅围挡', start: '2026-10-08', end: '2026-10-22', lanes: '双向 4 车道收窄为 2 车道', status: '条件通过', route: [[121.470, 31.228], [121.482, 31.231], [121.496, 31.235]] },
      { id: 'ST-02', name: '第二阶段 · 路口夜间施工', start: '2026-10-23', end: '2026-11-05', lanes: '22:00–05:00 全封闭', status: '待协商', route: [[121.496, 31.235], [121.508, 31.238], [121.516, 31.242]] },
      { id: 'ST-03', name: '第三阶段 · 西半幅恢复', start: '2026-11-06', end: '2026-11-18', lanes: '西侧公交专用道临时占用', status: '退回', route: [[121.452, 31.224], [121.462, 31.226], [121.470, 31.228]] },
    ],
    detours: [
      { id: 'DR-01', name: '江海大道—滨河路绕行', distance: 4.8, extraMinutes: 11, coordinates: [[121.470, 31.228], [121.478, 31.214], [121.502, 31.218], [121.516, 31.242]] },
      { id: 'DR-02', name: '云河路辅道保通', distance: 2.3, extraMinutes: 6, coordinates: [[121.452, 31.224], [121.462, 31.219], [121.496, 31.235]] },
    ],
    comments: [
      { id: 'CM-41', segmentId: 'ST-01', unit: '公交', author: '顾敏', content: '17 路、806 路临时站点与云河路站距离 680 米，超过老年乘客可接受步行距离。', condition: '需在江海大道口增设临时站并配置导乘人员。', status: '待处理', basisVersion: 7, invalid: false, history: [] },
      { id: 'CM-42', segmentId: 'ST-02', unit: '应急', author: '夏川', content: '夜间全封闭期间，区域急救中心南门通道被切断。', condition: '保留 4 米应急通道，路口导改每 15 分钟巡查一次。', status: '已接受', basisVersion: 7, invalid: false, frozenBasis: { version: 7, commitId: 'seed-v7', stageName: '第二阶段 · 路口夜间施工', start: '2026-10-23', end: '2026-11-05', lanes: '22:00–05:00 全封闭', route: [[121.496, 31.235], [121.508, 31.238], [121.516, 31.242]], frozenAt: Date.now() }, history: [] },
      { id: 'CM-43', segmentId: 'ST-03', unit: '交通', author: '郑航', content: '公交专用道占用导致高峰小时延误增加 19 分钟，超过方案阈值。', condition: '缩减围挡 1.5 米并调整信号配时。', status: '已退回', basisVersion: 7, invalid: false, history: [] },
    ],
    notice: { exported: false, version: null, commitId: null, at: null },
  }
  const doc: RemoteDoc = {
    scheme,
    noticeText: null,
    seen: [{ commitId: 'seed-v7', applied: true, version: 7 }],
    history: [
      {
        commitId: 'seed-v7', baseVersion: 6, version: 7, applied: true,
        unit: '建设', author: '市政建设集团', kinds: ['stage'],
        summary: '初始导入：三段式封路方案与会签底本', at: Date.now() - 86400000,
        patches: [],
      },
    ],
    conflicts: [],
  }
  return doc
}

/* ---------------- 存取与订阅 ---------------- */

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  const storageHandler = (event: StorageEvent) => {
    if (event.key === DOC_KEY) fn()
  }
  window.addEventListener('storage', storageHandler)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('storage', storageHandler)
  }
}

function emit() {
  listeners.forEach((fn) => fn())
}

export function bootstrap(): RemoteDoc {
  localStorage.removeItem('yy54-road-scheme-v1') // 清理旧版整表覆盖式快照，避免与协作文档串读
  const raw = localStorage.getItem(DOC_KEY)
  if (!raw) {
    const doc = seedDoc()
    localStorage.setItem(DOC_KEY, JSON.stringify(doc))
    return doc
  }
  try {
    return JSON.parse(raw) as RemoteDoc
  } catch {
    const doc = seedDoc()
    localStorage.setItem(DOC_KEY, JSON.stringify(doc))
    return doc
  }
}

export function loadDoc(): RemoteDoc {
  const raw = localStorage.getItem(DOC_KEY)
  if (raw) return JSON.parse(raw) as RemoteDoc
  return bootstrap()
}

function saveDoc(doc: RemoteDoc) {
  localStorage.setItem(DOC_KEY, JSON.stringify(doc))
}

/* ---------------- 补丁应用与级联 ---------------- */

function applyPatches(scheme: Scheme, patches: Patch[], newVersion: number, commitId: string): { changedStageIds: Set<string>; touchedCommentIds: Set<string> } {
  const changedStageIds = new Set<string>()
  const touchedCommentIds = new Set<string>()
  for (const patch of patches) {
    if (patch.kind === 'stage') {
      if (anchorChanges(patch.before, patch.after).length > 0) changedStageIds.add(patch.stageId)
      if (patch.after === null) {
        scheme.stages = scheme.stages.filter((item) => item.id !== patch.stageId)
      } else {
        const idx = scheme.stages.findIndex((item) => item.id === patch.stageId)
        if (idx >= 0) scheme.stages.splice(idx, 1, clone(patch.after))
        else scheme.stages.push(clone(patch.after))
      }
    } else if (patch.kind === 'comment') {
      touchedCommentIds.add(patch.commentId)
      if (patch.after === null) {
        scheme.comments = scheme.comments.filter((item) => item.id !== patch.commentId)
      } else {
        const after = clone(patch.after)
        // 接受 / 复核接受：冻结“当时依据”，锚定新版本
        if (after.status === '已接受') {
          const stage = scheme.stages.find((item) => item.id === after.segmentId)
          after.frozenBasis = snapshotStage(stage, newVersion, commitId)
          after.basisVersion = newVersion
          after.invalid = false
          after.recomputeNote = undefined
        } else if (after.status === '待处理') {
          // 失效后重新确认：重新挂接到当前版本并清除失效标记
          after.basisVersion = newVersion
          after.invalid = false
          after.recomputeNote = undefined
        }
        after.history = after.history ?? []
        after.history.push({ version: newVersion, at: Date.now(), action: `会签处理（提交 ${commitId.slice(-6)}）` })
        const idx = scheme.comments.findIndex((item) => item.id === patch.commentId)
        if (idx >= 0) scheme.comments.splice(idx, 1, after)
        else scheme.comments.push(after)
      }
    } else if (patch.kind === 'notice') {
      scheme.notice = { exported: true, version: newVersion, commitId, at: Date.now() }
    }
  }
  return { changedStageIds, touchedCommentIds }
}

/** 阶段起止 / 封路线变化后的意见级联 */
function cascadeComments(scheme: Scheme, changedStageIds: Set<string>, oldVersion: number, newVersion: number, touchedCommentIds?: Set<string>) {
  if (changedStageIds.size === 0) return
  for (const comment of scheme.comments) {
    if (!changedStageIds.has(comment.segmentId)) continue
    // 同一提交里刚被处理的意见：以提交结果为准，本次不连锁
    if (touchedCommentIds?.has(comment.id)) continue
    const stage = scheme.stages.find((item) => item.id === comment.segmentId)
    comment.history = comment.history ?? []
    if (comment.status === '待处理') {
      // 依附旧版本的待处理意见：立即失效，按新版本重算挂接，交原单位重新确认
      comment.invalid = true
      comment.basisVersion = newVersion
      comment.recomputeNote = stage
        ? `依据阶段在 v${oldVersion}→v${newVersion} 间发生${stage ? '起止/封路线' : ''}变化，原意见已失效并按新版本重算挂接，请原单位重新确认。`
        : `关联阶段已删除（v${oldVersion}→v${newVersion}），原意见失效待处理。`
      comment.history.push({ version: newVersion, at: Date.now(), action: `阶段锚点变化，意见失效重算（v${oldVersion}→v${newVersion}）` })
    } else if (comment.status === '已接受') {
      // 已接受意见冻结依据保留，关联阶段再变 → 待复核
      const frozen = comment.frozenBasis?.version ?? oldVersion
      comment.status = '待复核'
      comment.recomputeNote = `接受时依据 v${frozen} 已被后续修改（当前 v${newVersion}），冻结依据保留，转入待复核。`
      comment.history.push({ version: newVersion, at: Date.now(), action: `关联阶段再变，已接受意见转待复核（依据 v${frozen}）` })
    }
  }
}

/* ---------------- 提交主流程 ---------------- */

function processCommit(doc: RemoteDoc, req: CommitRequest): CommitResult {
  // 同号只留首次结果
  const seen = doc.seen.find((item) => item.commitId === req.commitId)
  if (seen) {
    if (seen.applied) return { outcome: 'duplicate', applied: true, version: seen.version, commitId: req.commitId, scheme: doc.scheme }
    return { outcome: 'duplicate', applied: false, version: null, commitId: req.commitId, scheme: doc.scheme }
  }

  const currentVersion = doc.scheme.version

  // 同基准并发：先提交者已把版本向前推进，后到者保留为冲突草稿
  if (req.baseVersion !== currentVersion) {
    const winner = [...doc.history].reverse().find((item) => item.applied && item.version === currentVersion)
    const draft: ConflictDraft = {
      id: req.commitId,
      commitId: req.commitId,
      baseVersion: req.baseVersion,
      winnerVersion: currentVersion,
      winnerCommitId: winner?.commitId ?? '',
      winnerSummary: winner?.summary ?? '先提交者的保存',
      unit: req.unit,
      author: req.author,
      kinds: req.kinds,
      summary: req.summary,
      at: Date.now(),
      status: '待处理',
      patches: clone(req.patches),
    }
    doc.conflicts.unshift(draft)
    doc.seen.push({ commitId: req.commitId, applied: false, version: null })
    doc.history.push({
      commitId: req.commitId, baseVersion: req.baseVersion, version: null, applied: false,
      unit: req.unit, author: req.author, kinds: req.kinds, summary: req.summary, at: Date.now(),
      note: `基准 v${req.baseVersion} 已过期：先提交者已推进至 v${currentVersion}，内容保留为冲突草稿`,
      patches: clone(req.patches),
    })
    return { outcome: 'conflict', draft, scheme: doc.scheme }
  }

  const newVersion = currentVersion + 1
  const { changedStageIds, touchedCommentIds } = applyPatches(doc.scheme, req.patches, newVersion, req.commitId)
  doc.scheme.version = newVersion
  cascadeComments(doc.scheme, changedStageIds, currentVersion, newVersion, touchedCommentIds)

  if (req.kinds.includes('notice')) {
    const noticePatch = req.patches.find((item): item is NoticePatch => item.kind === 'notice')
    if (noticePatch) {
      // 文本可能在提交前按旧版本号预生成，落库时统一改写为生效版本
      doc.noticeText = noticePatch.text.replace(/通告版本：v\d+/, `通告版本：v${newVersion}`)
    }
  }

  doc.seen.push({ commitId: req.commitId, applied: true, version: newVersion })
  doc.history.push({
    commitId: req.commitId, baseVersion: req.baseVersion, version: newVersion, applied: true,
    unit: req.unit, author: req.author, kinds: req.kinds, summary: req.summary, at: Date.now(),
    patches: clone(req.patches),
  })
  return { outcome: 'applied', version: newVersion, commitId: req.commitId, scheme: doc.scheme }
}

export function commit(req: CommitRequest): CommitResult {
  const doc = loadDoc()
  const result = processCommit(doc, req)
  saveDoc(doc)
  emit()
  return result
}

/* ---------------- 冲突草稿合并 ---------------- */

export function pendingConflictCount(doc?: RemoteDoc): number {
  const d = doc ?? loadDoc()
  return d.conflicts.filter((item) => item.status === '待处理').length
}

export function adoptConflict(conflictId: string, unit: Unit, author: string): CommitResult | { outcome: 'noop' } {
  const doc = loadDoc()
  const draft = doc.conflicts.find((item) => item.id === conflictId && item.status === '待处理')
  if (!draft) return { outcome: 'noop' }
  const req: CommitRequest = {
    commitId: uid('M'),
    baseVersion: doc.scheme.version,
    unit,
    author,
    kinds: draft.kinds.includes('notice') ? ['notice'] : draft.kinds,
    summary: `采纳冲突草稿（…${draft.commitId.slice(-6)}）：${draft.summary}`,
    patches: clone(draft.patches),
  }
  const result = processCommit(doc, req)
  if (result.outcome === 'applied') {
    draft.status = '已采纳'
    draft.resolvedCommitId = result.commitId
    draft.resolvedAt = Date.now()
  }
  saveDoc(doc)
  emit()
  return result
}

export function discardConflict(conflictId: string, unit: Unit, author: string): void {
  const doc = loadDoc()
  const draft = doc.conflicts.find((item) => item.id === conflictId && item.status === '待处理')
  if (!draft) return
  draft.status = '已放弃'
  draft.resolvedAt = Date.now()
  doc.history.push({
    commitId: uid('D'), baseVersion: doc.scheme.version, version: doc.scheme.version, applied: true,
    unit, author, kinds: ['merge'], summary: `放弃冲突草稿（…${draft.commitId.slice(-6)}）：${draft.summary}`,
    at: Date.now(), event: 'discard-conflict', refCommitId: draft.commitId, patches: [],
  })
  saveDoc(doc)
  emit()
}

/** 生成公开通告文本（含版本与提交号戳） */
export function buildNoticeText(scheme: Scheme, commitId: string): string {
  return [
    `${scheme.project} 施工封路公开通告`,
    `范围：${scheme.area}　方案编号：${scheme.id}`,
    `通告版本：v${scheme.version}（提交号 ${commitId}）　导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    ...scheme.stages.map((stage) => `${stage.start} 至 ${stage.end}｜${stage.name}｜${stage.lanes}`),
    '',
    '绕行建议：',
    ...scheme.detours.map((route) => `${route.name}，增加约 ${route.extraMinutes} 分钟`),
    '',
    '本通告由建设、交通、公交、应急单位联合确认。',
  ].join('\n')
}
