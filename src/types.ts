export type StageStatus = '待协商' | '条件通过' | '已批准' | '退回'

/** 会签意见状态：待处理 / 已接受 / 已退回 / 已失效（待处理意见依附旧版本）/ 待复核（已接受意见冻结依据后阶段再变） */
export type CommentStatus = '待处理' | '已接受' | '已退回' | '已失效' | '待复核'

export type UnitRole = '建设' | '交通' | '公交' | '应急'

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

export interface SegmentComment {
  id: string
  segmentId: string
  unit: UnitRole
  author: string
  content: string
  condition?: string
  status: CommentStatus
  /** 意见作出或被接受时所依据的主线版本号 */
  basisVersion: number
  /** 已接受意见是否冻结了当时的阶段依据 */
  frozen: boolean
  /** 被哪个新版本置为失效 / 待复核 */
  invalidatedBy?: number
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
}
