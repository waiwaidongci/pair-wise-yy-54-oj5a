import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ClosureStage, CommentStatus, Scheme, SegmentComment, Unit } from '../types'
import {
  adoptConflict as engineAdopt,
  bootstrap,
  buildNoticeText,
  commit as engineCommit,
  discardConflict as engineDiscard,
  type CommitRequest,
  type Patch,
  type RemoteDoc,
  subscribe,
  uid,
} from '../collab/engine'

const STATE_KEY = 'yy54-collab-state-v2'
const BUFFER_KEY = 'yy54-collab-buffer-v2'
const OUTBOX_KEY = 'yy54-collab-outbox-v2'

export const UNIT_AUTHOR: Record<Unit, string> = {
  建设: '市政建设集团',
  交通: '郑航',
  公交: '顾敏',
  应急: '夏川',
}
export const UNITS: Unit[] = ['建设', '交通', '公交', '应急']

type StageBuffer = Record<string, ClosureStage>
type BufferMap = Partial<Record<Unit, StageBuffer>>
type OutboxMap = Partial<Record<Unit, CommitRequest[]>>

interface LocalState { unit: Unit; online: boolean }

function readJSON<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key)
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}
function writeJSON(key: string, value: unknown) { localStorage.setItem(key, JSON.stringify(value)) }

const initialState: LocalState = readJSON(STATE_KEY, { unit: '建设', online: true })

/* ---------------- 规则检测（与版本协作无关的业务检查，底本固定） ---------------- */
interface RuleCheck { id: string; level: '高' | '中'; segmentId: string; title: string; detail: string }

export const useSchemeStore = defineStore('scheme', () => {
  const doc = ref<RemoteDoc>(bootstrap())
  const unit = ref<Unit>(initialState.unit)
  const online = ref<boolean>(initialState.online)
  const buffers = ref<BufferMap>(readJSON(BUFFER_KEY, {}))
  const outbox = ref<OutboxMap>(readJSON(OUTBOX_KEY, {}))

  const selectedStageId = ref('ST-01')
  const selectedCommentId = ref('CM-41')
  const drawing = ref(false)
  const draftRoute = ref<[number, number][]>([])
  /** 最近一次提交结论，供界面提示 */
  const lastNotice = ref<{ type: 'success' | 'warning' | 'error' | 'info'; text: string } | null>(null)

  /* -------- 本地缓冲 / 发件箱 -------- */
  const stageBuffer = computed<StageBuffer>(() => buffers.value[unit.value] ?? {})
  const queuedCommits = computed<CommitRequest[]>(() => outbox.value[unit.value] ?? [])
  const otherQueuedCount = computed(() =>
    UNITS.filter((item) => item !== unit.value).reduce((sum, key) => sum + (outbox.value[key]?.length ?? 0), 0))
  const dirty = computed(() => Object.keys(stageBuffer.value).length > 0)
  const queuedCount = computed(() => queuedCommits.value.length)

  /* -------- 远程文档派生 -------- */
  const remoteScheme = computed<Scheme>(() => doc.value.scheme)
  const conflictDrafts = computed(() => doc.value.conflicts)
  const pendingConflicts = computed(() => doc.value.conflicts.filter((item) => item.status === '待处理'))
  const history = computed(() => [...doc.value.history].reverse())

  /** 工作视图 = 远程最新 + 本单位未提交缓冲 + 离线队列叠加 */
  const workingStages = computed<ClosureStage[]>(() => {
    const stages = remoteScheme.value.stages.map((stage) => ({ ...stage }))
    const overlays = new Map<string, ClosureStage>()
    for (const req of queuedCommits.value) {
      for (const patch of req.patches) {
        if (patch.kind === 'stage' && patch.after) overlays.set(patch.stageId, structuredClone(patch.after))
      }
    }
    Object.values(stageBuffer.value).forEach((stage) => overlays.set(stage.id, structuredClone(stage)))
    for (const stage of stages) {
      const overlay = overlays.get(stage.id)
      if (overlay) Object.assign(stage, overlay)
    }
    for (const overlay of overlays.values()) {
      if (!stages.some((item) => item.id === overlay.id)) stages.push(structuredClone(overlay))
    }
    return stages
  })

  const workingScheme = computed<Scheme>(() => ({
    ...remoteScheme.value,
    stages: workingStages.value,
  }))

  const selectedStage = computed(() => workingStages.value.find((item) => item.id === selectedStageId.value))
  const selectedComment = computed(() => remoteScheme.value.comments.find((item) => item.id === selectedCommentId.value))

  const ruleChecks = computed<RuleCheck[]>(() => [
    ...(remoteScheme.value.stages.some((stage) => stage.id === 'ST-02')
      ? [{ id: 'CF-01', level: '高' as const, segmentId: 'ST-02', title: '相邻雨污分流工程时间重叠', detail: '10 月 26–30 日江海大道东段同步占用慢车道，建议错峰 4 天。' }]
      : []),
    { id: 'CF-02', level: '高', segmentId: 'ST-02', title: '救护通道中断风险', detail: '夜间全封闭将切断区域急救中心南门，必须保留 4 米应急通道。' },
    { id: 'CF-03', level: '中', segmentId: 'ST-01', title: '公交站点覆盖缺口', detail: '17 路与 806 路临时站距现状站 680 米，已超过 500 米阈值。' },
    { id: 'CF-04', level: '中', segmentId: 'ST-03', title: '绕行延误超阈值', detail: '高峰绕行新增 19 分钟，超过方案设定的 15 分钟阈值。' },
  ])

  const invalidComments = computed(() => remoteScheme.value.comments.filter((item) => item.invalid))
  const reviewComments = computed(() => remoteScheme.value.comments.filter((item) => item.status === '待复核'))
  const canExport = computed(() =>
    online.value && pendingConflicts.value.length === 0 && !dirty.value && queuedCount.value === 0 && otherQueuedCount.value === 0)

  /* -------- 持久化 -------- */
  function persistLocal() {
    writeJSON(STATE_KEY, { unit: unit.value, online: online.value })
    writeJSON(BUFFER_KEY, buffers.value)
    writeJSON(OUTBOX_KEY, outbox.value)
  }
  function refreshDoc() { doc.value = readJSON<RemoteDoc>('yy54-road-scheme-collab-v2', doc.value) }
  subscribe(refreshDoc)

  function setUnit(next: Unit) {
    unit.value = next
    persistLocal()
    const first = workingStages.value[0]
    if (first && !workingStages.value.some((item) => item.id === selectedStageId.value)) selectedStageId.value = first.id
  }
  function setOnline(next: boolean) {
    online.value = next
    persistLocal()
    if (next) flushOutbox()
  }

  /* -------- 阶段本地编辑（先缓冲，保存才提交） -------- */
  function startDraw() { drawing.value = true; draftRoute.value = [] }
  function addPoint(point: [number, number]) { if (drawing.value) draftRoute.value.push(point) }
  function finishDraw() {
    if (draftRoute.value.length >= 2 && selectedStage.value) {
      const stageId = selectedStage.value.id
      const base: ClosureStage = stageBuffer.value[stageId]
        ? structuredClone(stageBuffer.value[stageId])
        : (remoteScheme.value.stages.find((item) => item.id === stageId) ?? selectedStage.value)
      const edited: ClosureStage = { ...structuredClone(base), route: [...draftRoute.value], status: '待协商' }
      buffers.value = { ...buffers.value, [unit.value]: { ...stageBuffer.value, [stageId]: edited } }
      persistLocal()
    }
    drawing.value = false
    draftRoute.value = []
  }
  function updateStage(patch: Partial<ClosureStage>) {
    const current = selectedStage.value
    if (!current) return
    const base = stageBuffer.value[current.id]
      ? structuredClone(stageBuffer.value[current.id])
      : structuredClone(current)
    const edited: ClosureStage = { ...base, ...patch, status: '待协商' }
    buffers.value = { ...buffers.value, [unit.value]: { ...stageBuffer.value, [current.id]: edited } }
    persistLocal()
  }
  function discardBuffer() {
    const next = { ...buffers.value }
    delete next[unit.value]
    buffers.value = next
    persistLocal()
    lastNotice.value = { type: 'info', text: '已放弃本单位未提交的阶段草稿。' }
  }

  /* -------- 提交 -------- */
  function submitStages(): void {
    const buffer = stageBuffer.value
    const ids = Object.keys(buffer)
    if (ids.length === 0) return
    const patches: Patch[] = ids.map((stageId) => ({
      kind: 'stage' as const,
      stageId,
      before: structuredClone(remoteScheme.value.stages.find((item) => item.id === stageId) ?? null),
      after: structuredClone(buffer[stageId]),
    }))
    const labels = ids.map((id) => {
      const before = remoteScheme.value.stages.find((item) => item.id === id)
      const after = buffer[id]
      if (!before) return `${id} 新增`
      const changes: string[] = []
      if (before.start !== after.start || before.end !== after.end) changes.push('起止时间')
      if (JSON.stringify(before.route) !== JSON.stringify(after.route)) changes.push('封路路线')
      if (before.lanes !== after.lanes) changes.push('车道方案')
      if (before.name !== after.name) changes.push('名称')
      if (before.status !== after.status) changes.push('状态')
      return `${id} ${changes.join('、') || '调整'}`
    })
    const req: CommitRequest = {
      commitId: uid('S'),
      baseVersion: remoteScheme.value.version,
      unit: unit.value,
      author: UNIT_AUTHOR[unit.value],
      kinds: ['stage'],
      summary: `阶段修改：${labels.join('；')}`,
      patches,
    }
    runOrQueue(req, () => {
      const next = { ...buffers.value }
      delete next[unit.value]
      buffers.value = next
    })
  }

  function resolveComment(id: string, status: CommentStatus) {
    const found = remoteScheme.value.comments.find((item) => item.id === id)
    if (!found) return
    const after: SegmentComment = structuredClone(found)
    after.status = status
    if (status === '待处理') {
      // 失效重算后的重新确认
      after.invalid = false
      after.recomputeNote = undefined
    }
    const req: CommitRequest = {
      commitId: uid('R'),
      baseVersion: remoteScheme.value.version,
      unit: unit.value,
      author: UNIT_AUTHOR[unit.value],
      kinds: ['comment'],
      summary: `会签意见 ${id} → ${status}`,
      patches: [{ kind: 'comment', commentId: id, before: structuredClone(found), after }],
    }
    runOrQueue(req)
  }

  /** 发件箱 FIFO 回放：始终从队首开始，点击任意一项的重试等同于“继续回放队列” */
  function retryCommit(commitId: string) {
    const exists = queuedCommits.value.some((item) => item.commitId === commitId)
    if (!exists) {
      lastNotice.value = { type: 'info', text: '该提交号在本单位发件箱中未找到。' }
      return
    }
    if (!online.value) {
      lastNotice.value = { type: 'warning', text: '当前离线，请恢复联网后再回放发件箱。' }
      return
    }
    flushOutbox()
  }

  function runOrQueue(req: CommitRequest, onSettled?: () => void) {
    if (!online.value) {
      outbox.value = { ...outbox.value, [unit.value]: [...queuedCommits.value, req] }
      persistLocal()
      onSettled?.()
      lastNotice.value = { type: 'warning', text: `当前离线，提交号 ${req.commitId.slice(-6)} 已进入发件箱，联网后自动按序合并。` }
      return
    }
    const result = engineCommit(req)
    handleResult(result, onSettled)
  }

  function handleResult(result: ReturnType<typeof engineCommit>, onSettled?: () => void) {
    if (result.outcome === 'applied') {
      lastNotice.value = { type: 'success', text: `保存生效：版本推进至 v${result.version}（提交号 ${result.commitId.slice(-6)}）。` }
      onSettled?.()
    } else if (result.outcome === 'duplicate') {
      lastNotice.value = {
        type: 'info',
        text: result.applied
          ? `提交号重复，沿用首次结果 v${result.version}，未重复落库。`
          : '提交号重复，沿用首次结果（该提交此前已作为冲突草稿保留）。',
      }
      onSettled?.()
    } else if (result.outcome === 'conflict') {
      lastNotice.value = {
        type: 'error',
        text: `并发冲突：你的基准 v${result.draft.baseVersion} 已过期，先提交者已推进至 v${result.draft.winnerVersion}，你的内容已保留为冲突草稿，处理后才能通告。`,
      }
      onSettled?.()
    }
  }

  function dequeue(commitId: string) {
    outbox.value = { ...outbox.value, [unit.value]: queuedCommits.value.filter((item) => item.commitId !== commitId) }
    persistLocal()
  }

  /**
   * 离线发件箱按 FIFO 回放：
   *  - 本单位前一个提交生效后，后续排队提交的基准自动顺移（同一用户连续编辑不算并发）
   *  - 顺移后若基准仍对不上（被其他单位抢先推进），如实保留为冲突草稿，不做静默合并
   */
  function flushOutbox() {
    let applied = 0
    let conflicts = 0
    // 本次回放中本单位已经成功生效的提交：其后排队的同单位提交基准顺移
    let advancedBySelf = false
    for (;;) {
      const queue = outbox.value[unit.value] ?? []
      const req = queue[0]
      if (!req) break
      const live = remoteScheme.value.version
      const rebased = advancedBySelf && req.baseVersion < live
        ? { ...req, baseVersion: live, summary: `${req.summary}（离线回放，基准顺移至 v${live}）` }
        : req
      const result = engineCommit(structuredClone(rebased))
      dequeue(req.commitId)
      if (result.outcome === 'applied') { applied += 1; advancedBySelf = true }
      else if (result.outcome === 'conflict') conflicts += 1
    }
    if (applied > 0 || conflicts > 0) {
      lastNotice.value = conflicts > 0
        ? { type: 'warning', text: `回放完成：${applied} 个提交生效，${conflicts} 个提交因其他单位抢先保存而保留为冲突草稿。` }
        : { type: 'success', text: `联网恢复：发件箱 ${applied} 个提交已按序合并。` }
    }
  }

  /* -------- 冲突草稿 -------- */
  function adoptDraft(conflictId: string) {
    const result = engineAdopt(conflictId, unit.value, UNIT_AUTHOR[unit.value])
    if (result.outcome === 'applied') {
      lastNotice.value = { type: 'success', text: `冲突草稿已采纳合并，版本推进至 v${result.version}。关联意见已按规则联动重算。` }
      flushOutbox()
    } else if (result.outcome === 'conflict') {
      lastNotice.value = { type: 'error', text: '采纳时版本又被推进，采纳内容再次保留为冲突草稿，请继续处理。' }
    } else {
      lastNotice.value = { type: 'info', text: '该草稿已被其他单位处理。' }
    }
  }
  function discardDraft(conflictId: string) {
    engineDiscard(conflictId, unit.value, UNIT_AUTHOR[unit.value])
    lastNotice.value = { type: 'info', text: '冲突草稿已放弃，动作记入版本历史。' }
  }

  /* -------- 公开通告 -------- */
  function exportNotice(): { ok: boolean; reason?: string } {
    if (pendingConflicts.value.length > 0) {
      return { ok: false, reason: `尚有 ${pendingConflicts.value.length} 份冲突草稿未处理，冲突解决前不能导出公开通告。` }
    }
    if (dirty.value || queuedCount.value > 0 || otherQueuedCount.value > 0) {
      return { ok: false, reason: '存在未提交或未联网合并的草稿，请先提交并清空发件箱后再导出。' }
    }
    if (!online.value) {
      return { ok: false, reason: '当前处于离线状态：公开通告必须在线提交锁定版本，请联网后再导出。' }
    }
    const commitId = uid('P')
    const text = buildNoticeText(remoteScheme.value, commitId)
    const result = engineCommit({
      commitId,
      baseVersion: remoteScheme.value.version,
      unit: unit.value,
      author: UNIT_AUTHOR[unit.value],
      kinds: ['notice'],
      summary: `导出公开通告（v${remoteScheme.value.version} 内容快照）`,
      patches: [{ kind: 'notice', text }],
    })
    if (result.outcome === 'applied') {
      const finalText = text.replace(/通告版本：v\d+/, `通告版本：v${result.version}`)
      const blob = new Blob([finalText], { type: 'text/plain;charset=utf-8' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `封路公开通告-${remoteScheme.value.id}-v${result.version}.txt`
      link.click()
      URL.revokeObjectURL(link.href)
      lastNotice.value = { type: 'success', text: `公开通告已导出并锁定到 v${result.version}（提交号 ${commitId.slice(-6)}）。` }
      return { ok: true }
    }
    if (result.outcome === 'conflict') return { ok: false, reason: '导出瞬间有并发提交抢先生效，本次导出未执行，其内容已保留为冲突草稿。' }
    return { ok: false, reason: '提交号重复，未重复导出。' }
  }

  return {
    // 状态
    unit, online, doc, lastNotice,
    selectedStageId, selectedCommentId, drawing, draftRoute,
    // 派生
    scheme: workingScheme, remoteScheme, workingStages, workingScheme,
    selectedStage, selectedComment,
    stageBuffer, queuedCommits, dirty, queuedCount, otherQueuedCount,
    conflictDrafts, pendingConflicts, history,
    ruleChecks, invalidComments, reviewComments, canExport,
    // 动作
    setUnit, setOnline,
    startDraw, addPoint, finishDraw, updateStage, discardBuffer,
    submitStages, resolveComment, retryCommit, flushOutbox,
    adoptDraft, discardDraft, exportNotice,
  }
})
