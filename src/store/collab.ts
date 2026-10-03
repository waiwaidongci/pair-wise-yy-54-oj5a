import type { ClosureStage, CommentStatus, Scheme, SegmentComment, UnitRole } from '../types'

/** 一次提交的结果：生效 / 重复（同提交号）/ 冲突（基准不一致，留草稿） */
export type CommitOutcomeKind = 'applied' | 'duplicate' | 'conflict'

export interface CommitRecord {
  commitId: string
  baseVersion: number
  version: number
  author: string
  unit: UnitRole
  time: number
  message: string
  snapshot: Scheme
  result: CommitOutcomeKind
}

export interface ConflictDraft {
  draftId: string
  commitId: string
  baseVersion: number
  author: string
  unit: UnitRole
  time: number
  message: string
  snapshot: Scheme
  status: 'open' | 'merged' | 'discarded'
  reason: string
}

export interface CommitInput {
  commitId: string
  baseVersion: number
  snapshot: Scheme
  message: string
  author: string
  unit: UnitRole
}

export type CommitOutcome =
  | { kind: 'applied'; commit: CommitRecord }
  | { kind: 'duplicate'; original: CommitRecord | ConflictDraft }
  | { kind: 'conflict'; draft: ConflictDraft }

let seq = 0
export function genCommitId(): string {
  seq += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `C-${Date.now().toString(36)}-${seq}-${rand}`
}

/** 深拷贝方案数据（纯 JSON 结构；structuredClone 无法克隆 Vue 响应式 Proxy） */
export function cloneDeep<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

/** 判断阶段的「起止或封路线」是否变化（名称 / 车道 / 状态变化不触发失效重算） */
export function stageGeometryChanged(prev: ClosureStage | undefined, next: ClosureStage | undefined): boolean {
  if (!prev || !next) return true
  return prev.start !== next.start || prev.end !== next.end || JSON.stringify(prev.route) !== JSON.stringify(next.route)
}

/**
 * 意见依附规则（在每次生效提交后对 next 原地修正）：
 * - 阶段起止或封路线变化后，依附旧版本的「待处理」意见立即失效，并按新版本重算为一条新的待处理意见；
 * - 「已接受」意见冻结当时依据，关联阶段再变时转为「待复核」；
 * - 已退回意见不再触发。
 */
export function reconcileComments(prev: Scheme, next: Scheme): void {
  const changedStageIds = new Set<string>()
  for (const stage of next.stages) {
    const prevStage = prev.stages.find((item) => item.id === stage.id)
    if (stageGeometryChanged(prevStage, stage)) changedStageIds.add(stage.id)
  }
  if (changedStageIds.size === 0) return

  const recalculated: SegmentComment[] = []
  for (const comment of next.comments) {
    if (!changedStageIds.has(comment.segmentId)) continue
    if (comment.status === '待处理' && comment.basisVersion < next.version) {
      // 依附旧版本的待处理意见：失效，按当前版本重算一条新意见
      comment.status = '已失效'
      comment.invalidatedBy = next.version
      recalculated.push({
        ...cloneDeep(comment),
        id: `CM-${Math.random().toString(36).slice(2, 8)}`,
        status: '待处理',
        basisVersion: next.version,
        frozen: false,
        invalidatedBy: undefined,
      })
    } else if (comment.status === '已接受' && comment.frozen) {
      // 已接受意见冻结了依据，阶段再变 → 待复核
      comment.status = '待复核'
      comment.invalidatedBy = next.version
    }
  }
  if (recalculated.length) next.comments.push(...recalculated)
}

type Mergeable = { id: string }

/** 三向合并：base 为基准快照，ours 为主线当前快照，theirs 为冲突草稿快照。 */
function threeWay<T extends Mergeable>(
  base: T[],
  ours: T[],
  theirs: T[],
  isChanged: (b: T, t: T) => boolean,
  take: (t: T) => T,
  conflictNote: (id: string) => string,
  conflicts: string[],
): T[] {
  const result: T[] = []
  const ids = new Set<string>([...base.map((i) => i.id), ...ours.map((i) => i.id), ...theirs.map((i) => i.id)])
  for (const id of ids) {
    const b = base.find((i) => i.id === id)
    const o = ours.find((i) => i.id === id)
    const t = theirs.find((i) => i.id === id)
    if (t && !b) {
      // 草稿新增：直接采纳（主线没有）
      if (!o) result.push(take(t))
      else result.push(cloneDeep(o))
      continue
    }
    if (!b || !o || !t) {
      if (o) result.push(cloneDeep(o))
      continue
    }
    const changedTheirs = isChanged(b, t)
    const changedOurs = isChanged(b, o)
    if (changedTheirs && !changedOurs) result.push(take(t))
    else if (changedTheirs && changedOurs) {
      conflicts.push(conflictNote(id))
      result.push(cloneDeep(o)) // 双方都改：保留主线，标注冲突
    } else result.push(cloneDeep(o))
  }
  return result
}

export interface MergeResult {
  merged: Scheme
  conflicts: string[]
}

/** 合并冲突草稿：以基准版本做三向合并，返回合并后的新快照与双方都改的字段级冲突说明。 */
export function mergeDraft(base: Scheme, ours: Scheme, theirs: Scheme): MergeResult {
  const conflicts: string[] = []
  const merged: Scheme = {
    ...cloneDeep(ours),
    stages: threeWay<ClosureStage>(
      base.stages, ours.stages, theirs.stages,
      (b, t) => stageGeometryChanged(b, t) || b.name !== t.name || b.lanes !== t.lanes || b.status !== t.status,
      (t) => cloneDeep(t),
      (id) => `阶段 ${id} 双方都做了修改，已保留主线版本`,
      conflicts,
    ),
    detours: threeWay(
      base.detours, ours.detours, theirs.detours,
      (b, t) => JSON.stringify(b) !== JSON.stringify(t),
      (t) => cloneDeep(t),
      (id) => `绕行路线 ${id} 双方都做了修改，已保留主线版本`,
      conflicts,
    ),
    comments: threeWay<SegmentComment>(
      base.comments, ours.comments, theirs.comments,
      (b, t) => b.status !== t.status || b.content !== t.content || b.condition !== t.condition,
      (t) => cloneDeep(t),
      (id) => `意见 ${id} 双方都做了处理，已保留主线结果`,
      conflicts,
    ),
  }
  return { merged, conflicts }
}

/** 各单位并发模拟时的固化修改（基于旧基准），用于演示同基准并发冲突与三向合并。 */
export function cannedChange(unit: UnitRole, base: Scheme): Scheme {
  const draft = cloneDeep(base)
  const stamp = (s: ClosureStage | undefined, patch: Partial<ClosureStage>) => {
    if (s) Object.assign(s, patch)
  }
  switch (unit) {
    case '建设':
      stamp(draft.stages.find((s) => s.id === 'ST-01'), { lanes: '双向 4 车道收窄为 1 车道（建设组并发调整）' })
      break
    case '交通':
      stamp(draft.stages.find((s) => s.id === 'ST-02'), { start: '2026-10-24', end: '2026-11-06' })
      break
    case '公交':
      draft.comments.push({
        id: `CM-${Math.random().toString(36).slice(2, 8)}`,
        segmentId: 'ST-01', unit: '公交', author: '顾敏',
        content: '公交组基于旧版本追加：早高峰 7:30–9:00 临时站候车人数超 40 人，需扩容。',
        condition: '临时站站台延长至 30 米并增设防雨棚。',
        status: '待处理', basisVersion: base.version, frozen: false,
      })
      break
    case '应急':
      stamp(draft.stages.find((s) => s.id === 'ST-02'), {
        route: [[121.496, 31.235], [121.500, 31.239], [121.512, 31.240], [121.516, 31.242]],
      })
      break
  }
  return draft
}

export const commentTagColor: Record<CommentStatus, string> = {
  待处理: 'orange',
  已接受: 'green',
  已退回: 'red',
  已失效: 'gray',
  待复核: 'arcoblue',
}
