export type StageStatus = '待协商' | '条件通过' | '已批准' | '退回'

export type Unit = '建设' | '交通' | '公交' | '应急'

export type CommentStatus = '待处理' | '已接受' | '已退回' | '待复核'

export interface ClosureStage {
  id: string
  name: string
  start: string
  end: string
  lanes: string
  status: StageStatus
  route: [number, number][]
}

export interface DetourRoute {
  id: string
  name: string
  distance: number
  extraMinutes: number
  coordinates: [number, number][]
}

/** 已接受意见冻结的当时依据：关联阶段再变也不可篡改，只供复核对照 */
export interface FrozenBasis {
  version: number
  commitId: string
  stageName: string
  start: string
  end: string
  lanes: string
  route: [number, number][]
  frozenAt: number
}

export interface CommentHistoryEntry {
  version: number
  at: number
  action: string
}

export interface SegmentComment {
  id: string
  segmentId: string
  unit: Unit
  author: string
  content: string
  condition?: string
  status: CommentStatus
  /** 意见当前依附的阶段版本：待处理意见据此在阶段起止/路线变化时失效重算 */
  basisVersion?: number
  /** 待处理意见依附的旧版本是否已被阶段变化作废（失效重算中，待原单位重新确认） */
  invalid?: boolean
  /** 失效重算 / 待复核的说明 */
  recomputeNote?: string
  /** 接受那一刻冻结的阶段快照，待复核时与现状对照 */
  frozenBasis?: FrozenBasis | null
  history?: CommentHistoryEntry[]
}

export interface NoticeState {
  exported: boolean
  version: number | null
  commitId: string | null
  at: number | null
}

export interface Scheme {
  id: string
  project: string
  contractor: string
  area: string
  version: number
  stages: ClosureStage[]
  detours: DetourRoute[]
  comments: SegmentComment[]
  notice: NoticeState
}
