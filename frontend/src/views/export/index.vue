<template>
  <section class="page" data-module="export">
    <header class="page-head">
      <div>
        <h2>数据导出管理</h2>
        <p class="page-desc">维护数据导出任务的输入、执行约束与结果记录，为数据导出提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记导出任务</button>
        <button class="btn" type="button" @click="exportRows">导出数据导出清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 下游导出入口：直接读取数据源接入模块归档的可回读清单数据表 -->
    <section class="manifest-panel">
      <header class="manifest-head">
        <h3>下游引用：可回读的接入配置清单数据表</h3>
        <span v-if="sourceManifest" class="legend-item">
          {{ sourceManifest.status }} ｜ v{{ sourceManifest.version }} ｜
          分隔规则：{{ sourceManifest.delimiterName }} ｜ {{ sourceManifest.rowCount }} 行 × {{ sourceManifest.columnCount }} 列
        </span>
      </header>

      <p v-if="!sourceManifest" class="empty-state">
        数据源接入模块尚未生成清单数据表，请先到「数据源接入」页面导出清单。
      </p>

      <div v-else class="manifest-body">
        <div class="manifest-meta">
          <span>来源文件：{{ sourceManifest.filename }}</span>
          <span>校验和：{{ sourceManifest.checksum }}</span>
          <span
            :class="sourceConsistent === true ? 'ok-text' : sourceConsistent === false ? 'error-text' : ''"
          >
            导出结果与清单记录一致：{{ sourceConsistent === null ? '待核对' : sourceConsistent ? '是' : '否' }}
          </span>
        </div>
        <div class="manifest-actions">
          <button class="btn" type="button" @click="downloadSourceManifest">下载引用的接入清单文件</button>
          <button class="btn ghost" type="button" @click="reloadSourceManifest">重新核对</button>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th v-for="column in sourceManifest.header" :key="column">{{ column }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIndex) in sourceManifest.rows" :key="rowIndex">
              <td v-for="(cell, cellIndex) in row" :key="cellIndex" class="manifest-cell">
                {{ cell === '' ? '（空）' : cell }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无数据导出数据，可先登记导出任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据导出记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="infoMessage" class="ok-text">{{ infoMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  checkManifest,
  downloadEntries,
  listEntries,
  moduleMeta,
  readManifest,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import type { ManifestRecord } from '@/data/manifest-store'

const meta = moduleMeta('export')
const columns = ["任务编号", "查询SQL", "导出格式", "字段列表", "分隔符", "编码格式", "压缩方式", "目标路径"]
const actions = ["提交执行", "启动导出", "终止导出", "归档文件"]
const statuses = ["草稿", "待执行", "执行中", "已完成", "已失败"]
const stats = [{"label": "导出任务总数", "value": 0}, {"label": "执行中任务", "value": 0}, {"label": "已完成任务", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const sourceManifest = ref<ManifestRecord | null>(null)
const sourceConsistent = ref<boolean | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function reloadSourceManifest() {
  errorMessage.value = ''
  sourceManifest.value = readManifest('source')
  if (!sourceManifest.value) {
    sourceConsistent.value = null
    return
  }
  try {
    // 下游引用前再回读一次：两种读法列数一致且与来源页面明细一致才放行。
    const result = checkManifest('source')
    sourceConsistent.value = result.verify.consistent && result.pageConsistent
  } catch (error) {
    sourceConsistent.value = false
    errorMessage.value = error instanceof Error ? error.message : '接入清单回读失败'
  }
}

async function downloadSourceManifest() {
  errorMessage.value = ''
  try {
    // 下游文件由导出入口读取可回读清单数据表，不重新拼接。
    await downloadEntries('source')
    infoMessage.value = '已按清单数据表中的分隔规则导出接入配置清单文件'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '导出失败'
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '导出任务登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据导出列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadSourceManifest()
})
</script>

<style scoped>
.manifest-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.manifest-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.manifest-head h3 {
  margin: 0;
  font-size: 15px;
}
.manifest-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 8px;
}
.manifest-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.manifest-cell {
  white-space: pre-line;
}
.ok-text {
  color: #067647;
}
</style>
