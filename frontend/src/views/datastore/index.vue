<template>
  <section class="page" data-module="datastore">
    <header class="page-head">
      <div>
        <h2>数据集管理管理</h2>
        <p class="page-desc">维护数据集定义的输入、执行约束与结果记录，为数据集管理提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记数据集定义</button>
        <button class="btn" type="button" @click="exportRows">导出数据集管理清单</button>
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

    <!-- 数据集管理引用的来源配置：直接读取数据源接入模块的可回读清单数据表 -->
    <section class="manifest-panel">
      <header class="manifest-head">
        <h3>引用来源：可回读的接入配置清单数据表</h3>
        <span v-if="sourceManifest" class="legend-item">
          {{ sourceManifest.status }} ｜ v{{ sourceManifest.version }} ｜
          分隔规则：{{ sourceManifest.delimiterName }} ｜ {{ sourceManifest.rowCount }} 行 × {{ sourceManifest.columnCount }} 列
        </span>
      </header>
      <p v-if="!sourceManifest" class="empty-state">
        数据源接入模块尚未生成清单数据表，数据集定义暂无已核对的来源配置可引用。
      </p>
      <div v-else>
        <p class="manifest-meta">
          来源文件：{{ sourceManifest.filename }} ｜
          两种读法列数一致且与页面明细对齐：
          <strong :class="sourceConsistent ? 'ok-text' : 'error-text'">
            {{ sourceConsistent ? '是' : '否' }}
          </strong>
        </p>
        <table class="data-table">
          <thead>
            <tr>
              <th v-for="column in sourceColumns" :key="column">{{ column }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIndex) in sourceRows" :key="rowIndex">
              <td v-for="column in sourceColumns" :key="column" class="manifest-cell">
                {{ row[sourceHeaderIndex[column]] === '' ? '（空）' : row[sourceHeaderIndex[column]] }}
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
          <td :colspan="columns.length + 2" class="empty-state">暂无数据集管理数据，可先登记数据集定义</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据集管理记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
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

const meta = moduleMeta('datastore')
const columns = ["数据集编号", "数据集名称", "来源表名", "字段列表", "更新策略", "数据采样比例", "生命周期天数", "缓存开关"]
const actions = ["提交审核", "生效发布", "废弃下线"]
const statuses = ["草稿", "待审核", "已生效", "已废弃"]
const stats = [{"label": "数据集定义总数", "value": 0}, {"label": "已生效数据集", "value": 0}, {"label": "待审核数据集", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 来源配置引用：只读数据源接入模块已落库的清单数据表，避免引用错位的来源配置。
const sourceManifest = ref<ManifestRecord | null>(null)
const sourceConsistent = ref(false)
const sourceColumns = ["配置编号", "连接类型", "接入地址", "负责人"]
const sourceHeaderIndex = computed<Record<string, number>>(() => {
  const indexMap: Record<string, number> = {}
  for (const column of sourceColumns) {
    indexMap[column] = sourceManifest.value?.header.indexOf(column) ?? -1
  }
  return indexMap
})
const sourceRows = computed(() => sourceManifest.value?.rows ?? [])

function reloadSourceManifest() {
  sourceManifest.value = readManifest('source')
  if (!sourceManifest.value) {
    sourceConsistent.value = false
    return
  }
  try {
    const result = checkManifest('source')
    sourceConsistent.value = result.verify.consistent && result.pageConsistent
  } catch {
    sourceConsistent.value = false
  }
}

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '数据集定义登记入口尚未接入审批流'
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
    errorMessage.value = error instanceof Error ? error.message : '数据集管理列表读取失败'
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
  font-size: 12px;
  color: var(--muted);
}
.manifest-cell {
  white-space: pre-line;
}
.ok-text {
  color: #067647;
}
.error-text {
  color: #b42318;
}
</style>
