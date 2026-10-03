<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMutation } from '@vue/apollo-composable'
import { COMMENTS_MUTATION } from '../graphql'
import { useSchemeStore } from '../store/scheme'
import type { CommentStatus, SegmentComment } from '../types'
import type { Patch } from '../collab/engine'

const store = useSchemeStore()
const { mutate } = useMutation(COMMENTS_MUTATION)
const tab = ref<'conflicts' | 'comments' | 'history'>('conflicts')
const expandedHistoryId = ref<string | null>(null)

function resolve(comment: SegmentComment, status: CommentStatus) {
  store.resolveComment(comment.id, status)
  void mutate({ id: comment.id, status })
}

function exportNotice() {
  const result = store.exportNotice()
  // 失败原因已由 store.lastNotice 全局提示；此处兜底
  if (!result.ok && result.reason) store.lastNotice = { type: 'error', text: result.reason }
}

function tagColor(status: CommentStatus) {
  if (status === '已接受') return 'green'
  if (status === '已退回') return 'red'
  if (status === '待复核') return 'purple'
  return 'orange'
}

/* 冲突草稿里的字段级差异预览 */
interface StageDiffRow { field: string; from: string; to: string }
interface StageDiffView { stageId: string; rows: StageDiffRow[] }
const selectedConflictId = ref<string | null>(null)
const selectedConflict = computed(() =>
  store.conflictDrafts.find((item) => item.id === (selectedConflictId.value ?? store.pendingConflicts[0]?.id)))

function stageDiffView(patch: Patch): StageDiffView | null {
  if (patch.kind !== 'stage') return null
  if (patch.before === null && patch.after) {
    return { stageId: patch.stageId, rows: [{ field: '阶段', from: '—', to: patch.after.name }] }
  }
  if (patch.before && patch.after === null) {
    return { stageId: patch.stageId, rows: [{ field: '阶段', from: patch.before.name, to: '已删除' }] }
  }
  const before = patch.before
  const after = patch.after
  if (!before || !after) return null
  const rows: StageDiffRow[] = []
  if (before.name !== after.name) rows.push({ field: '名称', from: before.name, to: after.name })
  if (before.start !== after.start) rows.push({ field: '开始', from: before.start, to: after.start })
  if (before.end !== after.end) rows.push({ field: '结束', from: before.end, to: after.end })
  if (before.lanes !== after.lanes) rows.push({ field: '车道', from: before.lanes, to: after.lanes })
  if (before.status !== after.status) rows.push({ field: '状态', from: before.status, to: after.status })
  if (JSON.stringify(before.route) !== JSON.stringify(after.route)) {
    rows.push({ field: '封路路线', from: `${before.route.length} 个折点`, to: `${after.route.length} 个折点` })
  }
  return { stageId: patch.stageId, rows }
}
const conflictDiffs = computed<StageDiffView[]>(() =>
  (selectedConflict.value?.patches ?? []).map(stageDiffView).filter((item): item is StageDiffView => item !== null))

const pendingCount = computed(() => store.remoteScheme.comments.filter((item) => item.status === '待处理').length)
</script>

<template>
  <section class="page-head compact">
    <div><p class="eyebrow">条件会签 · 版本恢复 · 冲突合并</p><h1>路段意见、冲突草稿与公开通告</h1><p>保存带提交号与基准版本；同号去重、同基准先到先得；阶段起止或封路线变化自动联动意见状态。</p></div>
    <a-tooltip :content="store.canExport ? '通告将锁定当前已发布版本与提交号' : '请先处理冲突草稿并清空本地/离线草稿'">
      <a-button type="primary" :disabled="!store.canExport" @click="exportNotice">导出公开通告包</a-button>
    </a-tooltip>
  </section>

  <a-alert v-if="!store.canExport" class="mb16" type="error" show-icon>
    <template #title>
      导出闸门关闭：
      <span v-if="store.pendingConflicts.length">{{ store.pendingConflicts.length }} 份冲突草稿未处理；</span>
      <span v-if="store.dirty">本单位有未提交阶段草稿；</span>
      <span v-if="store.queuedCount">发件箱有 {{ store.queuedCount }} 个离线提交；</span>
      <span v-if="store.otherQueuedCount">其他单位发件箱尚有 {{ store.otherQueuedCount }} 个提交未回放；</span>
      <span>以上清空后方可导出公开通告。</span>
    </template>
  </a-alert>
  <a-alert v-else class="mb16" type="success" show-icon title="无待处理冲突与待合并草稿，公开通告可基于当前已发布版本导出。" />

  <a-alert v-if="store.queuedCount" class="mb16" type="warning" show-icon>
    <template #title>
      本单位有 {{ store.queuedCount }} 个提交暂存在离线发件箱（刷新、断网、重开均不丢失）：
      <a-button size="small" type="primary" :disabled="!store.online" @click="store.flushOutbox()">{{ store.online ? '立即回放合并' : '恢复联网后自动回放' }}</a-button>
    </template>
  </a-alert>

  <a-tabs :active-key="tab" @change="(key: any) => tab = key" class="review-tabs">
    <a-tab-pane key="conflicts">
      <template #title>冲突草稿 <a-badge v-if="store.pendingConflicts.length" :count="store.pendingConflicts.length" :max-count="99" /></template>

      <article v-if="store.queuedCommits.length" class="card mb16 outbox">
        <div class="panel-head"><div><h2>本单位发件箱（离线 / 未确认）</h2><p>提交号与基准版本已随草稿持久化；同号重试只认首次结果</p></div><a-tag color="orange">{{ store.queuedCommits.length }} 待合并</a-tag></div>
        <a-table :data="store.queuedCommits" :pagination="false" row-key="commitId" size="small">
          <template #columns>
            <a-table-column title="提交号" :width="170"><template #cell="{ record }">#{{ record.commitId.slice(-6) }}</template></a-table-column>
            <a-table-column title="基准" :width="80"><template #cell="{ record }">v{{ record.baseVersion }}</template></a-table-column>
            <a-table-column title="内容" data-index="summary" />
            <a-table-column title="操作" :width="200">
              <template #cell="{ record }">
                <a-button size="mini" type="primary" :disabled="!store.online" @click="store.retryCommit(record.commitId)">回放合并</a-button>
                <a-button size="mini" :disabled="!store.online" @click="store.flushOutbox()">全部回放</a-button>
              </template>
            </a-table-column>
          </template>
        </a-table>
      </article>

      <div class="conflict-grid">
        <article class="card draft-list">
          <div class="panel-head"><div><h2>并发保存的后到内容</h2><p>同基准并发仅先提交者生效，后到内容原样保留在草稿中，可逐项采纳或放弃</p></div></div>
          <a-empty v-if="!store.pendingConflicts.length" description="暂无待处理冲突草稿" style="padding: 28px 0" />
          <button
            v-for="draft in store.pendingConflicts"
            :key="draft.id"
            class="draft"
            :class="{ active: draft.id === selectedConflict?.id }"
            @click="selectedConflictId = draft.id"
          >
            <div class="draft-head">
              <a-tag color="red">基准 v{{ draft.baseVersion }}</a-tag>
              <b>{{ draft.unit }} · {{ draft.author }}</b>
              <span class="muted">#{{ draft.commitId.slice(-6) }}</span>
            </div>
            <p>{{ draft.summary }}</p>
            <small>先提交者已推进至 <b>v{{ draft.winnerVersion }}</b>：{{ draft.winnerSummary }}</small>
          </button>
        </article>

        <article v-if="selectedConflict" class="card draft-detail">
          <div class="panel-head">
            <div><h2>合并工作台</h2><p>采纳 = 以当前 v{{ store.remoteScheme.version }} 为新基准重放后到内容；放弃 = 留痕不合并</p></div>
            <a-tag color="red">草稿 #{{ selectedConflict.commitId.slice(-6) }}</a-tag>
          </div>
          <a-descriptions :column="1" size="small" bordered class="mb16">
            <a-descriptions-item label="提交单位">{{ selectedConflict.unit }}（{{ selectedConflict.author }}）</a-descriptions-item>
            <a-descriptions-item label="草稿基准">v{{ selectedConflict.baseVersion }}</a-descriptions-item>
            <a-descriptions-item label="先提交版本">v{{ selectedConflict.winnerVersion }} · {{ selectedConflict.winnerSummary }}</a-descriptions-item>
          </a-descriptions>
          <h3>后到内容差异（采纳前预览）</h3>
          <a-table v-if="conflictDiffs.length" :data="conflictDiffs" :pagination="false" row-key="stageId" size="small">
            <template #columns>
              <a-table-column title="阶段" data-index="stageId" :width="90" />
              <a-table-column title="字段差异">
                <template #cell="{ record }">
                  <div v-for="row in record.rows" :key="row.field" class="diff-row">
                    <span class="field">{{ row.field }}</span>
                    <span class="from">{{ row.from || '（空）' }}</span>
                    <span class="arrow">→</span>
                    <span class="to">{{ row.to || '（空）' }}</span>
                  </div>
                </template>
              </a-table-column>
            </template>
          </a-table>
          <a-alert v-else type="info" size="small" :title="selectedConflict.kinds.includes('notice') ? '该草稿为一次通告导出动作，采纳将以当前版本重新生成通告。' : '该草稿不含可展示的阶段字段差异。'" class="mb16" />
          <a-space>
            <a-button status="danger" @click="store.discardDraft(selectedConflict.id)">放弃后到内容</a-button>
            <a-button type="primary" @click="store.adoptDraft(selectedConflict.id)">采纳并以当前版本重放</a-button>
          </a-space>
          <p class="hint">采纳后若涉及阶段起止 / 封路线变化，依附旧版本的待处理意见会立即失效重算，已接受意见转待复核。</p>
        </article>
      </div>

      <article v-if="store.conflictDrafts.some((item) => item.status !== '待处理')" class="card mt16">
        <h2>已处理草稿</h2>
        <a-table :data="store.conflictDrafts.filter((item) => item.status !== '待处理')" :pagination="false" row-key="id" size="small">
          <template #columns>
            <a-table-column title="提交号" :width="130"><template #cell="{ record }">#{{ record.commitId.slice(-6) }}</template></a-table-column>
            <a-table-column title="单位" data-index="unit" :width="80" />
            <a-table-column title="内容" data-index="summary" />
            <a-table-column title="处理结果" :width="170">
              <template #cell="{ record }">
                <a-tag :color="record.status === '已采纳' ? 'green' : 'gray'">{{ record.status }}</a-tag>
                <span v-if="record.resolvedCommitId" class="muted">合并号 #{{ record.resolvedCommitId.slice(-6) }}</span>
              </template>
            </a-table-column>
          </template>
        </a-table>
      </article>
    </a-tab-pane>

    <a-tab-pane key="comments">
      <template #title>会签意见 <a-badge v-if="pendingCount" :count="pendingCount" :max-count="99" /></template>
      <div class="review-grid">
        <article class="card">
          <div class="panel-head">
            <div><h2>会签意见</h2><p>原意见不覆盖；失效重算与待复核均保留历史依据</p></div>
            <a-space size="small">
              <a-tag v-if="store.invalidComments.length" color="red">{{ store.invalidComments.length }} 失效待重认</a-tag>
              <a-tag v-if="store.reviewComments.length" color="purple">{{ store.reviewComments.length }} 待复核</a-tag>
              <a-tag color="orange">{{ pendingCount }} 待处理</a-tag>
            </a-space>
          </div>
          <button
            v-for="comment in store.remoteScheme.comments"
            :key="comment.id"
            class="comment"
            :class="{ active: store.selectedCommentId === comment.id, invalid: comment.invalid }"
            @click="store.selectedCommentId = comment.id"
          >
            <div class="comment-head">
              <span>{{ comment.unit }}</span><b>{{ comment.author }}</b>
              <a-tag :color="tagColor(comment.status)">{{ comment.status }}</a-tag>
            </div>
            <p>{{ comment.content }}</p>
            <small v-if="comment.condition">条件：{{ comment.condition }}</small>
            <em>锚点 {{ comment.segmentId }} · 依据 v{{ comment.basisVersion ?? '—' }}</em>
            <a-tag v-if="comment.invalid" color="red" size="small" class="mt4">阶段已变 · 失效重算</a-tag>
          </button>
        </article>
        <div class="right">
          <article class="card" v-if="store.selectedComment">
            <div class="panel-head">
              <div><h2>意见处理</h2><p>{{ store.selectedComment.segmentId }} · {{ store.selectedComment.unit }} · {{ store.selectedComment.author }}</p></div>
              <a-tag :color="tagColor(store.selectedComment.status)">{{ store.selectedComment.status }}</a-tag>
            </div>
            <div class="condition"><b>要求条件</b><p>{{ store.selectedComment.condition || '无附加条件' }}</p><b>影响解释</b><p>{{ store.selectedComment.content }}</p></div>

            <a-alert v-if="store.selectedComment.invalid" class="mb16" type="error" show-icon
              :title="`该意见依附的阶段在基准版本之后发生了起止/封路线变化，已立即失效并按新版本重算（${store.selectedComment.recomputeNote ?? ''}）。请原单位重新确认。`" />
            <a-alert v-else-if="store.selectedComment.status === '待复核'" class="mb16" type="warning" show-icon>
              <template #title>{{ store.selectedComment.recomputeNote ?? '接受时依据已被后续修改，请复核。' }}</template>
            </a-alert>

            <div v-if="store.selectedComment.frozenBasis" class="frozen">
              <h3>接受时冻结依据 <small class="muted">v{{ store.selectedComment.frozenBasis.version }} · #{{ store.selectedComment.frozenBasis.commitId.slice(-6) }}</small></h3>
              <p>{{ store.selectedComment.frozenBasis.start }} → {{ store.selectedComment.frozenBasis.end }}｜{{ store.selectedComment.frozenBasis.stageName }}</p>
              <p class="muted">{{ store.selectedComment.frozenBasis.lanes }} · {{ store.selectedComment.frozenBasis.route.length }} 个折点（冻结于 {{ new Date(store.selectedComment.frozenBasis.frozenAt).toLocaleString('zh-CN', { hour12: false }) }}）</p>
            </div>

            <a-space wrap>
              <template v-if="store.selectedComment.status === '待复核'">
                <a-button status="danger" @click="resolve(store.selectedComment, '已退回')">复核退回</a-button>
                <a-button type="primary" @click="resolve(store.selectedComment, '已接受')">复核通过（重新冻结当前依据）</a-button>
              </template>
              <template v-else-if="store.selectedComment.invalid">
                <a-button status="danger" @click="resolve(store.selectedComment, '已退回')">失效后退回</a-button>
                <a-button type="primary" @click="resolve(store.selectedComment, '待处理')">重新确认意见（挂接当前版本）</a-button>
              </template>
              <template v-else>
                <a-button status="danger" :disabled="store.selectedComment.status !== '待处理'" @click="resolve(store.selectedComment, '已退回')">退回方案</a-button>
                <a-button type="primary" :disabled="store.selectedComment.status !== '待处理'" @click="resolve(store.selectedComment, '已接受')">接受条件（冻结依据）</a-button>
              </template>
            </a-space>
          </article>

          <article class="card">
            <h2>当前阶段基准</h2>
            <a-table :data="store.remoteScheme.stages" :pagination="false" row-key="id" size="small">
              <template #columns>
                <a-table-column title="阶段" data-index="id" :width="80" />
                <a-table-column title="起止">
                  <template #cell="{ record }">{{ record.start }} → {{ record.end }}</template>
                </a-table-column>
                <a-table-column title="状态" data-index="status" :width="100" />
              </template>
            </a-table>
          </article>
        </div>
      </div>
    </a-tab-pane>

    <a-tab-pane key="history" title="版本历史">
      <article class="card">
        <div class="panel-head"><div><h2>提交日志</h2><p>每次保存带提交号与基准版本；同号只留首次结果，冲突与合并全部留痕</p></div><a-tag color="arcoblue">当前 v{{ store.remoteScheme.version }}</a-tag></div>
        <a-timeline>
          <a-timeline-item v-for="record in store.history" :key="record.commitId + String(record.version)" :dot-color="record.applied ? (record.event ? '#7c3aed' : '#16a34a') : '#e54849'">
            <div class="log" @click="expandedHistoryId = expandedHistoryId === record.commitId ? null : record.commitId">
              <div class="log-head">
                <a-tag :color="record.applied ? 'green' : 'red'" size="small">{{ record.applied ? `生效 v${record.version ?? '—'}` : '未生效' }}</a-tag>
                <b>{{ record.summary }}</b>
              </div>
              <p class="muted">{{ record.unit }} · {{ record.author }} · {{ new Date(record.at).toLocaleString('zh-CN', { hour12: false }) }} · 基准 v{{ record.baseVersion }} · 提交号 {{ record.commitId }}</p>
              <p v-if="record.note" class="note">{{ record.note }}</p>
              <div v-if="expandedHistoryId === record.commitId && record.patches.length" class="patch-detail">
                <div v-for="(patch, index) in record.patches" :key="index" class="patch-line">
                  <template v-if="patch.kind === 'stage'">[阶段 {{ patch.stageId }}] {{ patch.before?.status ?? '新增' }} → {{ patch.after?.status ?? '删除' }}；{{ patch.after ? `${patch.after.start}→${patch.after.end}` : '' }}</template>
                  <template v-else-if="patch.kind === 'comment'">[意见 {{ patch.commentId }}] → {{ patch.after?.status }}</template>
                  <template v-else>[公开通告] 锁定导出</template>
                </div>
              </div>
            </div>
          </a-timeline-item>
        </a-timeline>
      </article>
    </a-tab-pane>
  </a-tabs>
</template>

<style scoped>
.review-tabs{background:transparent}
.outbox{border-left:4px solid #f59e0b}
.conflict-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:16px}
.draft-list .draft{display:block;width:100%;text-align:left;border:1px solid #e7ebf1;background:#fff;border-radius:7px;padding:12px;margin-bottom:9px;color:inherit;cursor:pointer}
.draft-list .draft:hover,.draft-list .draft.active{border-color:#2563eb;background:#f5f8ff}
.draft-head{display:flex;align-items:center;gap:8px}.draft-head b{flex:1}.draft p{margin:8px 0 5px;color:#475569}.draft small{color:#7a8798}
.muted{color:#8a94a6;font-size:12px}.diff-row{display:flex;gap:8px;align-items:baseline;padding:3px 0;font-size:13px}.diff-row .field{width:64px;color:#667085}.diff-row .from{color:#b91c1c}.diff-row .arrow{color:#94a3b8}.diff-row .to{color:#15803d;flex:1}
.hint{color:#7a8798;font-size:12px;margin-top:12px}
.review-grid{display:grid;grid-template-columns:1fr 1.15fr;gap:16px}.right{display:grid;gap:16px;height:fit-content}
.panel-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:12px}.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:12px;margin:0}
.comment{display:block;width:100%;text-align:left;border:1px solid #e7ebf1;background:#fff;border-radius:7px;padding:13px;margin-bottom:9px;color:inherit;cursor:pointer}.comment:hover,.comment.active{border-color:#2563eb;background:#f5f8ff}.comment.invalid{border-left:3px solid #e54849}
.comment-head{display:flex;align-items:center;gap:8px}.comment-head>span{display:grid;place-items:center;width:36px;height:36px;border-radius:6px;background:#eef2f7;font-weight:800}.comment-head b{flex:1}
.comment p{margin:9px 0 5px;color:#475569}.comment small,.comment em{display:block;color:#7a8798}.comment em{margin-top:6px;font-style:normal}.mt4{margin-top:6px}
.condition p{color:#475569}.frozen{background:#f8fafc;border:1px dashed #cbd5e1;border-radius:6px;padding:10px 12px;margin-bottom:12px}.frozen h3{margin:0 0 6px;font-size:14px}.frozen p{margin:3px 0;font-size:13px}
.log{cursor:pointer}.log-head{display:flex;align-items:center;gap:9px}.log p{margin:5px 0}.note{color:#b45309;font-size:13px}.patch-detail{margin-top:6px;background:#f8fafc;border-radius:6px;padding:8px 10px}.patch-line{font-size:12px;color:#475569;padding:2px 0;font-family:ui-monospace,Menlo,monospace}
@media(max-width:980px){.review-grid,.conflict-grid{grid-template-columns:1fr}}
</style>
