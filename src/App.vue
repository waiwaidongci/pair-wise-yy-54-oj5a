<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useSchemeStore, UNITS } from './store/scheme'

const route = useRoute()
const router = useRouter()
const store = useSchemeStore()
const nav = [
  { name: 'overview', label: '方案总览' },
  { name: 'map', label: '地图与阶段' },
  { name: 'review', label: '多单位会签' },
]
</script>

<template>
  <a-layout class="shell">
    <a-layout-sider :width="224" class="sider">
      <div class="brand"><b>路</b><div><strong>封路协调台</strong><small>ROAD CONTROL</small></div></div>
      <a-menu :selected-keys="[route.name]" class="menu" @menu-item-click="(key: string) => router.push({ name: key })">
        <a-menu-item v-for="item in nav" :key="item.name">{{ item.label }}</a-menu-item>
      </a-menu>
      <div class="project-card"><span :class="{ off: !store.online }"></span><div><b>{{ store.scheme.project }}</b><small>已发布 v{{ store.remoteScheme.version }} · 4 家单位会签</small></div></div>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="topbar">
        <div><b>{{ store.scheme.id }}</b><span>{{ store.scheme.area }} · 2026 年第四季度施工计划</span></div>
        <div class="top-actions">
          <a-tooltip content="同一浏览器打开多个标签页即可模拟四家单位同时编辑">
            <a-select :model-value="store.unit" style="width: 108px" @change="(value: any) => store.setUnit(value)">
              <a-option v-for="u in UNITS" :key="u" :value="u">{{ u }}单位</a-option>
            </a-select>
          </a-tooltip>
          <a-tag :color="store.online ? 'green' : 'gray'">{{ store.online ? '在线' : '离线' }}</a-tag>
          <a-switch :model-value="store.online" checked-text="联网" unchecked-text="断网" @change="(value: any) => store.setOnline(Boolean(value))" />
          <a-tag v-if="store.queuedCount > 0" color="orange">发件箱 {{ store.queuedCount }}</a-tag>
          <a-badge :count="store.pendingConflicts.length" :offset="[-4, 2]">
            <a-button :status="store.pendingConflicts.length ? 'warning' : undefined" @click="router.push('/review')">冲突草稿</a-button>
          </a-badge>
          <a-button type="primary" @click="router.push('/review')">前往会签</a-button>
        </div>
      </a-layout-header>
      <a-layout-content class="main">
        <a-alert
          v-if="store.lastNotice"
          class="mb16"
          :type="store.lastNotice.type"
          :title="store.lastNotice.text"
          closable
          @close="store.lastNotice = null"
        />
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>
