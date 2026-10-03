<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@vue/apollo-composable'
import { SCHEME_QUERY } from '../graphql'
import { useSchemeStore } from '../store/scheme'

const store = useSchemeStore()
const { result, loading, error } = useQuery(SCHEME_QUERY)

const stats = computed(() => [
  { label: '施工阶段', value: store.remoteScheme.stages.length, note: '跨 42 天' },
  { label: '待合并冲突草稿', value: store.pendingConflicts.length, note: store.pendingConflicts.length ? '未处理前禁止通告导出' : '无并发遗留' },
  { label: '失效 / 待复核意见', value: `${store.invalidComments.length} / ${store.reviewComments.length}`, note: '阶段锚点变化自动联动' },
  { label: '已发布版本', value: `v${result.value?.scheme?.version ?? store.remoteScheme.version}`, note: `提交号 ${store.history[0]?.commitId.slice(-6) ?? '—'}` },
])

const agencyNote = computed<Record<string, { note: string; color: string; tag: string }>>(() => {
  const map: Record<string, { note: string; color: string; tag: string }> = {}
  for (const agency of result.value?.agencies ?? []) {
    const mine = store.remoteScheme.comments.filter((item) => item.unit === agency.role)
    const invalid = mine.filter((item) => item.invalid).length
    const review = mine.filter((item) => item.status === '待复核').length
    const pending = mine.filter((item) => item.status === '待处理').length
    if (invalid) map[agency.role] = { note: `${invalid} 条意见因阶段变化失效待重认`, color: 'red', tag: '失效重算' }
    else if (review) map[agency.role] = { note: `${review} 条已接受意见待复核`, color: 'purple', tag: '待复核' }
    else if (pending) map[agency.role] = { note: `${pending} 条待处理`, color: 'orange', tag: '待处理' }
    else map[agency.role] = { note: '暂无新增意见', color: 'green', tag: '已响应' }
  }
  return map
})
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">建设 · 交通 · 公交 · 应急</p><h1>封路方案协调总览</h1><p>四家单位基于提交号与基准版本协作；阶段起止或封路线变化时，意见自动失效重算或转待复核。</p></div><a-space><a-button :disabled="!store.canExport" @click="$router.push('/review')">公开通告预览</a-button><a-button type="primary" @click="$router.push('/map')">编辑封路方案</a-button></a-space></section>
  <a-spin :loading="loading" style="width:100%">
    <a-alert v-if="error" type="error" title="GraphQL 请求异常，已使用本地协作数据" class="mb16" />
    <a-alert v-if="store.pendingConflicts.length" class="mb16" type="error" show-icon>
      <template #title><a-space><b>{{ store.pendingConflicts.length }} 份并发冲突草稿等待合并，冲突未处理完不能导出公开通告。</b><a-button size="small" status="danger" @click="$router.push('/review')">前往合并工作台</a-button></a-space></template>
    </a-alert>
    <div class="metrics"><article v-for="item in stats" :key="item.label" class="card metric"><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>{{ item.note }}</small></article></div>
    <div class="grid-2">
      <article class="card">
        <div class="panel-head"><div><h2>施工阶段时间轴</h2><p>点击阶段查看范围与道路占用</p></div><a-tag color="orange">当前 v{{ store.remoteScheme.version }}</a-tag></div>
        <a-table :data="store.workingStages" :pagination="false" row-key="id" @row-click="(row: any) => { store.selectedStageId = row.id; $router.push('/map') }">
          <template #columns><a-table-column title="阶段" data-index="name" /><a-table-column title="时间" :width="190"><template #cell="{ record }">{{ record.start }} → {{ record.end }}</template></a-table-column><a-table-column title="车道方案" data-index="lanes" /><a-table-column title="状态" :width="100"><template #cell="{ record }"><a-tag :color="record.status === '已批准' ? 'green' : record.status === '退回' ? 'red' : 'orange'">{{ record.status }}</a-tag></template></a-table-column></template>
        </a-table>
        <p v-if="store.dirty" class="local-note">* 当前视图叠加了 {{ store.unit }}单位未提交草稿；提交基准为 v{{ store.remoteScheme.version }}。</p>
      </article>
      <article class="card">
        <div class="panel-head"><div><h2>规则检测结果</h2><p>按影响等级排序（不随版本状态消失）</p></div><a-tag color="red">{{ store.ruleChecks.filter((item) => item.level === '高').length }} 高风险</a-tag></div>
        <div v-for="item in store.ruleChecks" :key="item.id" class="conflict" :class="item.level === '高' ? 'red' : 'amber'"><div><b>{{ item.title }}</b><small>{{ item.segmentId }}</small></div><a-tag :color="item.level === '高' ? 'red' : 'orange'">{{ item.level }}</a-tag><p>{{ item.detail }}</p><a-button size="mini" type="text" @click="store.selectedStageId = item.segmentId; $router.push('/map')">定位路段</a-button></div>
      </article>
    </div>
    <article class="card mt16"><div class="panel-head"><div><h2>会签单位与条件</h2><p>意见锚定具体分段与版本，原记录不覆盖</p></div><a-button type="text" @click="$router.push('/review')">进入会签</a-button></div><div class="agency-grid"><div v-for="agency in result?.agencies || []" :key="agency.id" class="agency"><span>{{ agency.role }}</span><div><b>{{ agency.name }}</b><small>{{ agencyNote[agency.role]?.note ?? '加载中' }}</small></div><a-tag :color="agencyNote[agency.role]?.color ?? 'gray'">{{ agencyNote[agency.role]?.tag ?? '—' }}</a-tag></div></div></article>
  </a-spin>
</template>

<style scoped>
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.metric{padding:17px;border-left:4px solid #2563eb}.metric span,.metric small{display:block;color:#667085}.metric strong{display:block;font-size:29px;margin:7px 0 2px}.grid-2{display:grid;grid-template-columns:1.4fr .8fr;gap:16px}.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:13px;margin:0}.conflict{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:12px;margin-bottom:9px;border-radius:6px}.conflict.red{background:#fff1f2;border-left:3px solid #e11d48}.conflict.amber{background:#fff7ed;border-left:3px solid #f59e0b}.conflict>div{min-width:210px}.conflict b,.conflict small{display:block}.conflict small{color:#7a8798;margin-top:3px}.conflict p{width:100%;margin:0;color:#475569}.mt16{margin-top:16px}.agency-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.agency{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #e7ebf1;border-radius:7px}.agency>span{display:grid;place-items:center;width:35px;height:35px;border-radius:7px;background:#eff6ff;color:#2563eb;font-weight:800}.agency b,.agency small{display:block}.agency small{color:#7a8798;margin-top:3px}.agency>div{flex:1}.local-note{color:#b45309;font-size:12px;margin:8px 0 0}
@media(max-width:1050px){.metrics,.agency-grid{grid-template-columns:1fr 1fr}.grid-2{grid-template-columns:1fr}}@media(max-width:600px){.metrics,.agency-grid{grid-template-columns:1fr}}
</style>
