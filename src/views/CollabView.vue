<script setup lang="ts">
import { computed } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useSchemeStore } from '../store/scheme'
import { commentTagColor, type ConflictDraft } from '../store/collab'
import type { UnitRole } from '../types'

const store = useSchemeStore()
const units: UnitRole[] = ['建设', '交通', '公交', '应急']

const appliedCommits = computed(() => store.commits.filter((c) => c.result === 'applied'))

function fmtTime(t: number) {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function outcomeMessage(kind: string, fallback: string) {
  if (kind === 'applied') Message.success('已并入主线，版本 +1')
  else if (kind === 'duplicate') Message.warning('提交号已存在，保留首次结果，本次重复提交已忽略')
  else if (kind === 'conflict') Message.warning('基准不一致：先到者已生效，本次内容保留为冲突草稿，可在下方继续合并')
  else Message.info(fallback)
}

function simulate(unit: UnitRole) {
  const outcome = store.simulateConcurrent(unit)
  outcomeMessage(outcome.kind, '')
}

function retry() {
  const outcome = store.retryLastCommit()
  if (!outcome) Message.info('暂无可重试的提交')
  else outcomeMessage(outcome.kind, '')
}

function merge(draft: ConflictDraft) {
  const result = store.mergeDraft(draft.draftId)
  if (result.ok) {
    if (result.conflicts.length) Message.warning(`已合并，但有 ${result.conflicts.length} 处双方都修改的字段保留主线版本`)
    else Message.success('冲突草稿已合并入主线')
  } else Message.error('合并失败')
}

function discard(draft: ConflictDraft) {
  store.discardDraft(draft.draftId)
  Message.info('已丢弃该冲突草稿')
}

/** 草稿相对其基准版本的改动摘要 */
function draftChanges(draft: ConflictDraft): string[] {
  const changes: string[] = []
  const baseScheme = store.snapshotAt(draft.baseVersion)
  for (const stage of draft.snapshot.stages) {
    const prev = baseScheme.stages.find((s) => s.id === stage.id)
    if (!prev) { changes.push(`新增阶段 ${stage.id}`); continue }
    if (prev.start !== stage.start || prev.end !== stage.end) changes.push(`${stage.id} 时间调整为 ${stage.start} → ${stage.end}`)
    if (JSON.stringify(prev.route) !== JSON.stringify(stage.route)) changes.push(`${stage.id} 封路路线重绘`)
    if (prev.lanes !== stage.lanes) changes.push(`${stage.id} 车道方案调整`)
  }
  for (const comment of draft.snapshot.comments) {
    const prev = baseScheme.comments.find((c) => c.id === comment.id)
    if (!prev) changes.push(`新增意见：${comment.content.slice(0, 24)}…`)
    else if (prev.status !== comment.status) changes.push(`意见 ${comment.id} 状态改为 ${comment.status}`)
  }
  return changes
}
</script>

<template>
  <section class="page-head compact">
    <div>
      <p class="eyebrow">版本协作 · 提交号 / 基准版本 / 冲突草稿</p>
      <h1>版本协作中心</h1>
      <p>每次保存携带提交号与基准版本：同号只留首次结果，同基准并发只让先提交者生效，后到内容保留为冲突草稿，刷新或重开后仍可继续合并。</p>
    </div>
    <a-space>
      <a-tag color="green" size="large">主线 v{{ store.headVersion }}</a-tag>
      <a-tag v-if="store.hasOpenConflict" color="red" size="large">{{ store.openDrafts.length }} 份冲突草稿待处理</a-tag>
    </a-space>
  </section>

  <a-alert v-if="store.hasOpenConflict" type="warning" class="mb16" title="存在未合并的冲突草稿，公开通告暂不可导出"
    content="并发提交因基准不一致未并入主线。请在下方逐份「继续合并」（三向合并，双方都修改的字段保留主线），处理完后才能导出公开通告。" />

  <div class="collab-grid">
    <div class="left-col">
      <article class="card">
        <div class="panel-head">
          <div><h2>并发模拟</h2><p>模拟另一单位基于旧基准同时提交，验证先到生效、后到留草稿</p></div>
        </div>
        <div class="sim-row">
          <span class="sim-label">当前身份</span>
          <a-radio-group v-model="store.currentUnit" type="button">
            <a-radio v-for="u in units" :key="u" :value="u">{{ u }}组</a-radio>
          </a-radio-group>
        </div>
        <div class="sim-row">
          <span class="sim-label">并发提交</span>
          <a-space wrap>
            <a-button v-for="u in units" :key="u" size="small" @click="simulate(u)">{{ u }}组基于 v{{ Math.max(7, store.headVersion - 1) }} 提交</a-button>
          </a-space>
        </div>
        <div class="sim-row">
          <span class="sim-label">幂等重试</span>
          <a-button size="small" @click="retry">网络重试：重发上一提交号</a-button>
          <small class="hint">同提交号重复提交只保留首次结果</small>
        </div>
      </article>

      <article class="card">
        <div class="panel-head">
          <div><h2>版本历史</h2><p>每次生效提交的提交号、基准版本与结果</p></div>
          <a-tag color="green">{{ appliedCommits.length }} 次生效</a-tag>
        </div>
        <a-timeline v-if="appliedCommits.length">
          <a-timeline-item v-for="c in appliedCommits" :key="c.commitId" :label="fmtTime(c.time)">
            <div class="commit">
              <div class="commit-head">
                <a-tag color="arcoblue">v{{ c.version }}</a-tag>
                <b>{{ c.message }}</b>
                <a-tag color="green">已生效</a-tag>
              </div>
              <div class="commit-meta">
                <span>提交号 <code>{{ c.commitId }}</code></span>
                <span>基准 v{{ c.baseVersion }}</span>
                <span>{{ c.author }}</span>
              </div>
            </div>
          </a-timeline-item>
        </a-timeline>
        <a-empty v-else description="暂无提交，去地图或会签页保存一次" />
      </article>
    </div>

    <div class="right-col">
      <article class="card">
        <div class="panel-head">
          <div><h2>冲突草稿</h2><p>同基准并发的后到内容，可继续三向合并</p></div>
          <a-tag v-if="store.openDrafts.length" color="red">{{ store.openDrafts.length }} 待处理</a-tag>
        </div>

        <div v-for="draft in store.drafts" :key="draft.draftId" class="draft" :class="draft.status">
          <div class="draft-head">
            <a-tag :color="draft.status === 'open' ? 'red' : draft.status === 'merged' ? 'green' : 'gray'">
              {{ draft.status === 'open' ? '待合并' : draft.status === 'merged' ? '已合并' : '已丢弃' }}
            </a-tag>
            <b>{{ draft.message }}</b>
          </div>
          <p class="draft-reason">{{ draft.reason }}</p>
          <ul class="draft-changes">
            <li v-for="(change, i) in draftChanges(draft)" :key="i">{{ change }}</li>
          </ul>
          <div class="draft-meta">
            <span>{{ draft.author }}</span>
            <span>提交号 <code>{{ draft.commitId }}</code></span>
            <span>{{ fmtTime(draft.time) }}</span>
          </div>
          <div v-if="draft.status === 'open'" class="draft-actions">
            <a-button type="primary" size="small" @click="merge(draft)">继续合并</a-button>
            <a-button size="small" @click="discard(draft)">丢弃</a-button>
          </div>
        </div>
        <a-empty v-if="!store.drafts.length" description="暂无冲突草稿" />
      </article>

      <article class="card">
        <div class="panel-head"><div><h2>意见依附规则</h2><p>阶段变化后旧版本意见自动重算 / 复核</p></div></div>
        <ul class="rule-list">
          <li><a-tag color="orange">待处理</a-tag> 阶段起止或封路线变化 → <b>立即失效</b>，并按新版本重算一条待处理意见。</li>
          <li><a-tag color="green">已接受</a-tag> 冻结当时依据；关联阶段再变 → <a-tag color="arcoblue">待复核</a-tag>，需重新接受或退回。</li>
          <li><a-tag color="red">已退回</a-tag> 终态，阶段变化不再触发。</li>
        </ul>
      </article>
    </div>
  </div>
</template>

<style scoped>
.collab-grid{display:grid;grid-template-columns:1.15fr 1fr;gap:16px;align-items:start}.left-col,.right-col{display:grid;gap:16px}.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:12px;margin:0}.sim-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed #e7ebf1}.sim-row:last-child{border-bottom:none}.sim-label{color:#7a8798;font-size:13px;min-width:64px}.hint{color:#98a2b3;font-size:12px}.commit{padding:6px 0}.commit-head{display:flex;align-items:center;gap:8px}.commit-head b{font-size:14px}.commit-meta{display:flex;flex-wrap:wrap;gap:14px;margin-top:6px;color:#7a8798;font-size:12px}.commit-meta code,.draft-meta code{background:#f1f4f8;padding:1px 6px;border-radius:4px;font-size:11px}.draft{border:1px solid #f0d6d6;border-radius:8px;padding:13px;margin-bottom:12px;background:#fffafa}.draft.merged{border-color:#cde8d6;background:#f6fef8}.draft.discarded{border-color:#e7ebf1;background:#f8f9fb;opacity:.7}.draft-head{display:flex;align-items:center;gap:8px}.draft-head b{font-size:14px}.draft-reason{color:#b42318;font-size:12px;margin:7px 0}.draft.merged .draft-reason,.draft.discarded .draft-reason{color:#7a8798}.draft-changes{margin:6px 0;padding-left:18px;color:#475569;font-size:13px}.draft-changes li{margin:2px 0}.draft-meta{display:flex;flex-wrap:wrap;gap:14px;color:#7a8798;font-size:12px;margin-top:6px}.draft-actions{margin-top:10px;display:flex;gap:8px}.rule-list{margin:0;padding-left:18px;color:#475569;font-size:13px}.rule-list li{margin:8px 0;line-height:1.6}
@media(max-width:980px){.collab-grid{grid-template-columns:1fr}}
</style>
