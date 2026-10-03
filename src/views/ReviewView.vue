<script setup lang="ts">
import { ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useMutation } from '@vue/apollo-composable'
import { COMMENTS_MUTATION } from '../graphql'
import { useSchemeStore } from '../store/scheme'
import { commentTagColor } from '../store/collab'

const store = useSchemeStore()
const { mutate } = useMutation(COMMENTS_MUTATION)
const compare = ref(['ST-01', 'ST-02'])
const selectedVersion = ref('v7')
const versions = [
  { id: 'v7', author: '建设组', time: '今天 16:22', summary: '调整第二阶段夜间全封闭范围，保留急救通道' },
  { id: 'v6', author: '交通组', time: '今天 14:50', summary: '补充江海大道信号配时和现场疏导岗位' },
  { id: 'v5', author: '公交组', time: '昨天 19:10', summary: '提交临时站点与线路绕行方案' },
]

function resolve(id: string, status: '已接受' | '已退回') {
  const comment = store.scheme.comments.find((item) => item.id === id)
  if (!comment || (comment.status !== '待处理' && comment.status !== '待复核')) return
  store.resolveComment(id, status)
  void mutate({ id, status })
  Message.success(status === '已接受' ? '已接受条件，依据已冻结到当前版本' : '已退回该意见')
}
function exportNotice() {
  if (store.hasOpenConflict) {
    Message.error(`还有 ${store.openDrafts.length} 份冲突草稿未合并，冲突未处理完不能导出公开通告`)
    return
  }
  const pending = store.scheme.comments.filter((c) => c.status === '待处理' || c.status === '待复核')
  if (pending.length) {
    Message.warning(`仍有 ${pending.length} 条意见待处理 / 待复核，建议处理后再导出`)
  }
  const text = [`${store.scheme.project} 施工封路公开通告`, `范围：${store.scheme.area}`, `版本：v${store.scheme.version}`, '', ...store.scheme.stages.map((stage) => `${stage.start} 至 ${stage.end}｜${stage.name}｜${stage.lanes}`), '', '绕行建议：', ...store.scheme.detours.map((route) => `${route.name}，增加约 ${route.extraMinutes} 分钟`), '', '本通告由建设、交通、公交、应急单位联合确认。'].join('\n')
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `封路公开通告-${store.scheme.id}-v${store.scheme.version}.txt`
  link.click()
  URL.revokeObjectURL(link.href)
}
</script>

<template>
  <section class="page-head compact"><div><p class="eyebrow">条件会签与版本批复</p><h1>路段意见与阶段审批</h1><p>各方意见锚定具体路段和几何版本，审批人可逐项接受、退回并导出公开通告包。</p></div><a-button type="primary" @click="exportNotice">导出公开通告包</a-button></section>
  <a-alert v-if="store.hasOpenConflict" type="error" class="mb16" title="冲突未处理完，公开通告暂不可导出"
    content="存在同基准并发的冲突草稿未合并。请前往「版本协作」继续合并后再导出。" />
  <div class="review-grid">
    <article class="card">
      <div class="panel-head"><div><h2>会签意见</h2><p>原意见不可覆盖，处理动作进入版本审计</p></div><a-tag color="orange">{{ store.scheme.comments.filter((item) => item.status === '待处理' || item.status === '待复核').length }} 待处理 / 复核</a-tag></div>
      <button v-for="comment in store.scheme.comments" :key="comment.id" class="comment" :class="{ active: store.selectedCommentId === comment.id }" @click="store.selectedCommentId = comment.id">
        <div class="comment-head"><span>{{ comment.unit }}</span><b>{{ comment.author }}</b><a-tag :color="commentTagColor[comment.status]">{{ comment.status }}</a-tag></div>
        <p>{{ comment.content }}</p><small v-if="comment.condition">条件：{{ comment.condition }}</small><em>锚点 {{ comment.segmentId }} · 依据 v{{ comment.basisVersion }}<template v-if="comment.frozen"> · 已冻结</template><template v-if="comment.invalidatedBy"> · 因 v{{ comment.invalidatedBy }} 变化</template></em>
      </button>
    </article>
    <div class="right">
      <article class="card">
        <div class="panel-head"><div><h2>阶段条件处理</h2><p>{{ store.selectedComment?.segmentId }} · {{ store.selectedComment?.unit }}</p></div></div>
        <div v-if="store.selectedComment" class="condition"><b>要求条件</b><p>{{ store.selectedComment.condition || '无附加条件' }}</p><b>影响解释</b><p>{{ store.selectedComment.content }}</p><b>依据版本</b><p>v{{ store.selectedComment.basisVersion }}<template v-if="store.selectedComment.frozen"> · 已冻结当时依据</template><template v-if="store.selectedComment.invalidatedBy"> · 阶段已于 v{{ store.selectedComment.invalidatedBy }} 变化，待复核</template></p></div>
        <a-space><a-button status="danger" :disabled="store.selectedComment?.status !== '待处理' && store.selectedComment?.status !== '待复核'" @click="resolve(store.selectedComment!.id, '已退回')">退回方案</a-button><a-button type="primary" :disabled="store.selectedComment?.status !== '待处理' && store.selectedComment?.status !== '待复核'" @click="resolve(store.selectedComment!.id, '已接受')">{{ store.selectedComment?.status === '待复核' ? '重新接受' : '接受条件' }}</a-button></a-space>
      </article>
      <article class="card">
        <div class="panel-head"><div><h2>几何版本比较</h2><p>并排核对阶段起止、围挡与绕行</p></div><a-select v-model="selectedVersion" style="width:110px"><a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.id }}</a-option></a-select></div>
        <div class="version-list"><div v-for="version in versions" :key="version.id" :class="{ selected: selectedVersion === version.id }"><b>{{ version.id }} · {{ version.author }}</b><small>{{ version.time }}</small><p>{{ version.summary }}</p></div></div>
        <a-divider />
        <h3>阶段差异</h3><div class="diff"><a-tag color="red">修改</a-tag><span>ST-02 夜间封闭边界缩短 28 米，保留急救中心南门 4 米通道。</span></div><div class="diff"><a-tag color="green">新增</a-tag><span>江海大道口增加 2 名交通疏导员和临时信号配时方案。</span></div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.review-grid{display:grid;grid-template-columns:1fr 1.15fr;gap:16px}.right{display:grid;gap:16px;height:fit-content}.panel-head{display:flex;justify-content:space-between;margin-bottom:12px}.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:12px;margin:0}.comment{display:block;width:100%;text-align:left;border:1px solid #e7ebf1;background:#fff;border-radius:7px;padding:13px;margin-bottom:9px;color:inherit;cursor:pointer}.comment:hover,.comment.active{border-color:#2563eb;background:#f5f8ff}.comment-head{display:flex;align-items:center;gap:8px}.comment-head>span{display:grid;place-items:center;width:36px;height:36px;border-radius:6px;background:#eef2f7;font-weight:800}.comment-head b{flex:1}.comment p{margin:9px 0 5px;color:#475569}.comment small,.comment em{display:block;color:#7a8798}.comment em{margin-top:6px;font-style:normal}.condition p{color:#475569}.version-list>div{padding:11px;border:1px solid #edf0f5;border-radius:6px;margin-bottom:7px}.version-list>div.selected{border-color:#2563eb;background:#f5f8ff}.version-list b,.version-list small{display:block}.version-list small{color:#7a8798;margin-top:3px}.version-list p{margin:7px 0 0;color:#475569}.diff{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #edf0f5}
@media(max-width:980px){.review-grid{grid-template-columns:1fr}}
</style>
