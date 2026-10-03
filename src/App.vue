<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useSchemeStore } from './store/scheme'

const route = useRoute()
const router = useRouter()
const store = useSchemeStore()
const nav = [
  { name: 'overview', label: '方案总览' },
  { name: 'map', label: '地图与阶段' },
  { name: 'review', label: '多单位会签' },
  { name: 'collab', label: '版本协作' },
]
</script>

<template>
  <a-layout class="shell">
    <a-layout-sider :width="224" class="sider">
      <div class="brand"><b>路</b><div><strong>封路协调台</strong><small>ROAD CONTROL</small></div></div>
      <a-menu :selected-keys="[route.name]" class="menu" @menu-item-click="(key: string) => router.push({ name: key })">
        <a-menu-item v-for="item in nav" :key="item.name">{{ item.label }}</a-menu-item>
      </a-menu>
      <div class="project-card"><span></span><div><b>{{ store.scheme.project }}</b><small>主线 v{{ store.headVersion }} · 4 家单位会签</small></div></div>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="topbar">
        <div><b>{{ store.scheme.id }}</b><span>{{ store.scheme.area }} · 2026 年第四季度施工计划</span></div>
        <div class="top-actions">
          <a-tag color="green">协同在线 11</a-tag>
          <a-tag v-if="store.hasOpenConflict" color="red" class="conflict-badge" @click="router.push({ name: 'collab' })">
            {{ store.openDrafts.length }} 份冲突草稿待处理
          </a-tag>
          <a-tag v-if="store.pendingReviewCount" color="orange">{{ store.pendingReviewCount }} 条待处理 / 复核</a-tag>
          <a-button :disabled="!store.dirty" @click="store.undo">撤销修改</a-button>
          <a-button type="primary" @click="router.push({ name: 'collab' })">发起阶段审批</a-button>
        </div>
      </a-layout-header>
      <a-layout-content class="main"><router-view /></a-layout-content>
    </a-layout>
  </a-layout>
</template>

<style scoped>
.conflict-badge{cursor:pointer}
</style>
