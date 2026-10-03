import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ClosureStage, CommentStatus, Scheme, SegmentComment, UnitRole } from '../types'
import {
  cannedChange,
  cloneDeep,
  genCommitId,
  mergeDraft as threeWayMerge,
  reconcileComments,
  type CommitInput,
  type CommitOutcome,
  type CommitRecord,
  type ConflictDraft,
} from './collab'

const STORAGE_KEY = 'yy54-road-scheme-v2'
const UNIT_KEY = 'yy54-road-scheme-unit'

const seed: Scheme = {
  id: 'RC-2026-0918', project: '云河路快速化改造', contractor: '市政建设集团第三工程处', area: '云河路 / 江海大道', version: 7,
  stages: [
    { id: 'ST-01', name: '第一阶段 · 东半幅围挡', start: '2026-10-08', end: '2026-10-22', lanes: '双向 4 车道收窄为 2 车道', status: '条件通过', route: [[121.470,31.228],[121.482,31.231],[121.496,31.235]] },
    { id: 'ST-02', name: '第二阶段 · 路口夜间施工', start: '2026-10-23', end: '2026-11-05', lanes: '22:00–05:00 全封闭', status: '待协商', route: [[121.496,31.235],[121.508,31.238],[121.516,31.242]] },
    { id: 'ST-03', name: '第三阶段 · 西半幅恢复', start: '2026-11-06', end: '2026-11-18', lanes: '西侧公交专用道临时占用', status: '退回', route: [[121.452,31.224],[121.462,31.226],[121.470,31.228]] },
  ],
  detours: [
    { id: 'DR-01', name: '江海大道—滨河路绕行', distance: 4.8, extraMinutes: 11, coordinates: [[121.470,31.228],[121.478,31.214],[121.502,31.218],[121.516,31.242]] },
    { id: 'DR-02', name: '云河路辅道保通', distance: 2.3, extraMinutes: 6, coordinates: [[121.452,31.224],[121.462,31.219],[121.496,31.235]] },
  ],
  comments: [
    { id: 'CM-41', segmentId: 'ST-01', unit: '公交', author: '顾敏', content: '17 路、806 路临时站点与云河路站距离 680 米，超过老年乘客可接受步行距离。', condition: '需在江海大道口增设临时站并配置导乘人员。', status: '待处理', basisVersion: 7, frozen: false },
    { id: 'CM-42', segmentId: 'ST-02', unit: '应急', author: '夏川', content: '夜间全封闭期间，区域急救中心南门通道被切断。', condition: '保留 4 米应急通道，路口导改每 15 分钟巡查一次。', status: '已接受', basisVersion: 7, frozen: true },
    { id: 'CM-43', segmentId: 'ST-03', unit: '交通', author: '郑航', content: '公交专用道占用导致高峰小时延误增加 19 分钟，超过方案阈值。', condition: '缩减围挡 1.5 米并调整信号配时。', status: '已退回', basisVersion: 7, frozen: false },
  ],
}

export const useSchemeStore = defineStore('scheme', () => {
  const initialScheme = cloneDeep(seed)
  const scheme = ref<Scheme>(cloneDeep(seed))
  const selectedStageId = ref('ST-01')
  const selectedCommentId = ref('CM-41')
  const drawing = ref(false)
  const draftRoute = ref<[number, number][]>([])

  /** 版本协作状态 */
  const headVersion = ref(seed.version)
  const commits = ref<CommitRecord[]>([])
  const drafts = ref<ConflictDraft[]>([])
  const currentUnit = ref<UnitRole>('建设')
  const lastCommitId = ref('')

  const selectedStage = computed(() => scheme.value.stages.find((item) => item.id === selectedStageId.value))
  const selectedComment = computed(() => scheme.value.comments.find((item) => item.id === selectedCommentId.value))
  const openDrafts = computed(() => drafts.value.filter((item) => item.status === 'open'))
  const hasOpenConflict = computed(() => openDrafts.value.length > 0)
  const pendingReviewCount = computed(() => scheme.value.comments.filter((c) => c.status === '待处理' || c.status === '待复核').length)

  const conflicts = computed(() => [
    ...(scheme.value.stages.some((stage) => stage.id === 'ST-02') ? [{ id: 'CF-01', level: '高', segmentId: 'ST-02', title: '相邻雨污分流工程时间重叠', detail: '10 月 26–30 日江海大道东段同步占用慢车道，建议错峰 4 天。' }] : []),
    { id: 'CF-02', level: '高', segmentId: 'ST-02', title: '救护通道中断风险', detail: '夜间全封闭将切断区域急救中心南门，必须保留 4 米应急通道。' },
    { id: 'CF-03', level: '中', segmentId: 'ST-01', title: '公交站点覆盖缺口', detail: '17 路与 806 路临时站距现状站 680 米，已超过 500 米阈值。' },
    { id: 'CF-04', level: '中', segmentId: 'ST-03', title: '绕行延误超阈值', detail: '高峰绕行新增 19 分钟，超过方案设定的 15 分钟阈值。' },
  ])

  /** 是否还有可撤销的提交 */
  const dirty = computed(() => commits.value.length > 0)

  function snapshotAt(version: number): Scheme {
    const commit = commits.value.find((item) => item.version === version)
    if (commit) return cloneDeep(commit.snapshot)
    return cloneDeep(initialScheme)
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      scheme: scheme.value,
      headVersion: headVersion.value,
      commits: commits.value,
      drafts: drafts.value,
      lastCommitId: lastCommitId.value,
    }))
    localStorage.setItem(UNIT_KEY, currentUnit.value)
  }

  function restore() {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const data = JSON.parse(raw)
        if (data.scheme) scheme.value = data.scheme
        if (typeof data.headVersion === 'number') headVersion.value = data.headVersion
        if (Array.isArray(data.commits)) commits.value = data.commits
        if (Array.isArray(data.drafts)) drafts.value = data.drafts
        if (typeof data.lastCommitId === 'string') lastCommitId.value = data.lastCommitId
      } catch { /* 损坏的本地存档直接忽略 */ }
    }
    const unit = localStorage.getItem(UNIT_KEY)
    if (unit === '建设' || unit === '交通' || unit === '公交' || unit === '应急') currentUnit.value = unit
  }

  /** 提交号 + 基准版本：同号只留首次结果，同基准并发只让先提交者生效，后到留冲突草稿。 */
  function submitCommit(input: CommitInput): CommitOutcome {
    const duplicateCommit = commits.value.find((item) => item.commitId === input.commitId)
    const duplicateDraft = drafts.value.find((item) => item.commitId === input.commitId)
    if (duplicateCommit) return { kind: 'duplicate', original: duplicateCommit }
    if (duplicateDraft) return { kind: 'duplicate', original: duplicateDraft }

    if (input.baseVersion === headVersion.value) {
      const record: CommitRecord = {
        commitId: input.commitId,
        baseVersion: input.baseVersion,
        version: input.snapshot.version,
        author: input.author,
        unit: input.unit,
        time: Date.now(),
        message: input.message,
        snapshot: input.snapshot,
        result: 'applied',
      }
      commits.value.push(record)
      scheme.value = input.snapshot
      headVersion.value = input.snapshot.version
      lastCommitId.value = input.commitId
      persist()
      return { kind: 'applied', commit: record }
    }

    const draft: ConflictDraft = {
      draftId: input.commitId,
      commitId: input.commitId,
      baseVersion: input.baseVersion,
      author: input.author,
      unit: input.unit,
      time: Date.now(),
      message: input.message,
      snapshot: input.snapshot,
      status: 'open',
      reason: `基于 v${input.baseVersion} 提交，但主线已推进到 v${headVersion.value}，基准不一致，未并入主线，保留为冲突草稿。`,
    }
    drafts.value.unshift(draft)
    persist()
    return { kind: 'conflict', draft }
  }

  /** 本地修改 → 生成快照 → 提交（自动带提交号与基准版本）。 */
  function commitChange(message: string, mutate: (draft: Scheme) => void): CommitOutcome {
    const baseVersion = headVersion.value
    const draft = cloneDeep(scheme.value)
    mutate(draft)
    draft.version = baseVersion + 1
    reconcileComments(scheme.value, draft)
    return submitCommit({
      commitId: genCommitId(),
      baseVersion,
      snapshot: draft,
      message,
      author: `${currentUnit.value}组`,
      unit: currentUnit.value,
    })
  }

  /** 合并冲突草稿：三向合并后作为新提交并入主线。 */
  function mergeDraft(draftId: string): { ok: boolean; conflicts: string[] } {
    const draft = drafts.value.find((item) => item.draftId === draftId && item.status === 'open')
    if (!draft) return { ok: false, conflicts: [] }
    const base = snapshotAt(draft.baseVersion)
    const { merged, conflicts } = threeWayMerge(base, scheme.value, draft.snapshot)
    merged.version = headVersion.value + 1
    reconcileComments(scheme.value, merged)
    const outcome = submitCommit({
      commitId: genCommitId(),
      baseVersion: headVersion.value,
      snapshot: merged,
      message: `合并草稿：${draft.message}`,
      author: `${currentUnit.value}组`,
      unit: currentUnit.value,
    })
    if (outcome.kind === 'applied') {
      draft.status = 'merged'
      persist()
      return { ok: true, conflicts }
    }
    return { ok: false, conflicts }
  }

  function discardDraft(draftId: string) {
    const draft = drafts.value.find((item) => item.draftId === draftId && item.status === 'open')
    if (draft) { draft.status = 'discarded'; persist() }
  }

  /** 模拟另一单位基于旧基准并发提交：先到者生效，后到者留冲突草稿。 */
  function simulateConcurrent(unit: UnitRole): CommitOutcome {
    const baseVersion = Math.max(initialScheme.version, headVersion.value - 1)
    const base = snapshotAt(baseVersion)
    const snapshot = cannedChange(unit, base)
    snapshot.version = baseVersion
    return submitCommit({
      commitId: genCommitId(),
      baseVersion,
      snapshot,
      message: `${unit}组基于 v${baseVersion} 的并发修改`,
      author: `${unit}组`,
      unit,
    })
  }

  /** 网络重试 / 刷新重发：同一提交号只保留首次结果。 */
  function retryLastCommit(): CommitOutcome | null {
    const last = commits.value.find((item) => item.commitId === lastCommitId.value)
    if (!last) return null
    return submitCommit({
      commitId: last.commitId,
      baseVersion: last.baseVersion,
      snapshot: last.snapshot,
      message: last.message,
      author: last.author,
      unit: last.unit,
    })
  }

  function startDraw() { drawing.value = true; draftRoute.value = [] }
  function addPoint(point: [number, number]) { if (drawing.value) draftRoute.value.push(point) }
  function finishDraw() {
    if (draftRoute.value.length >= 2) {
      const stage = selectedStage.value
      if (stage) {
        const route = [...draftRoute.value]
        commitChange(`重绘阶段 ${stage.id} 封路路线`, (draft) => {
          const target = draft.stages.find((item) => item.id === stage.id)
          if (target) { target.route = route; target.status = '待协商' }
        })
      }
    }
    drawing.value = false
    draftRoute.value = []
  }
  function updateStage(patch: Partial<ClosureStage>) {
    const stage = selectedStage.value
    if (!stage) return
    commitChange(`修改阶段 ${stage.id} 信息`, (draft) => {
      const target = draft.stages.find((item) => item.id === stage.id)
      if (target) { Object.assign(target, patch); target.status = '待协商' }
    })
  }
  function resolveComment(id: string, status: CommentStatus) {
    commitChange(`${status}意见 ${id}`, (draft) => {
      const target = draft.comments.find((item) => item.id === id)
      if (!target) return
      target.status = status
      if (status === '已接受') { target.frozen = true; target.basisVersion = draft.version; target.invalidatedBy = undefined }
      else if (status === '已退回') { target.frozen = false; target.invalidatedBy = undefined }
    })
  }

  function undo() {
    const last = commits.value.pop()
    if (!last) return
    const prev = commits.value.length > 0 ? commits.value[commits.value.length - 1].snapshot : initialScheme
    scheme.value = cloneDeep(prev)
    headVersion.value = prev.version
    persist()
  }

  watch(selectedStageId, () => {})
  restore()
  return {
    scheme, selectedStageId, selectedCommentId, selectedStage, selectedComment,
    drawing, draftRoute, conflicts, dirty,
    headVersion, commits, drafts, openDrafts, hasOpenConflict, pendingReviewCount,
    currentUnit, lastCommitId,
    startDraw, addPoint, finishDraw, updateStage, resolveComment, undo,
    submitCommit, commitChange, mergeDraft, discardDraft, simulateConcurrent, retryLastCommit,
    snapshotAt, initialScheme,
  }
})
