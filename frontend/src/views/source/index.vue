<template>
  <section class="page" data-module="source">
    <header class="page-head">
      <div>
        <h2>数据源接入管理</h2>
        <p class="page-desc">维护数据源接入配置的输入、执行约束与结果记录，为数据接入提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记接入配置</button>
        <button class="btn" type="button" :disabled="exporting" @click="exportRows">
          {{ exporting ? '导出中…' : '导出数据源接入清单' }}
        </button>
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

    <!-- 可回读的接入配置清单数据表：单份持久化，刷新后仍可核对 -->
    <section class="manifest-panel">
      <header class="manifest-head">
        <h3>可回读的接入配置清单数据表</h3>
        <span v-if="manifest" class="legend-item">
          生命周期：{{ manifest.status }} ｜ 版本 v{{ manifest.version }} ｜
          分隔规则：{{ manifest.delimiterName }} ｜ 行数 {{ manifest.rowCount }} ｜ 列数 {{ manifest.columnCount }}
        </span>
      </header>

      <p v-if="!manifest" class="empty-state">
        尚未生成清单数据表，点击「导出数据源接入清单」后在此回读核对。
      </p>

      <div v-else class="manifest-body">
        <div class="manifest-meta">
          <span>文件名：{{ manifest.filename }}</span>
          <span>内容校验和：{{ manifest.checksum }}</span>
          <span>更新时间：{{ manifest.updatedAt }}</span>
          <span v-if="manifest.abnormal" class="error-text">异常标记：{{ manifest.abnormalReason }}</span>
        </div>

        <div class="manifest-actions">
          <button class="btn" type="button" :disabled="manifest.status !== '已生成'" @click="onConfirm">
            确认结果（已生成 → 已确认）
          </button>
          <button class="btn" type="button" :disabled="manifest.status !== '已确认'" @click="onArchive">
            归档清单（已确认 → 已归档）
          </button>
          <button class="btn ghost" type="button" @click="onCheck">回读核对</button>
          <button class="btn ghost" type="button" @click="onVersionCompare">版本冲突比较</button>
          <button class="btn ghost" type="button" @click="exportRows">重试导出</button>
        </div>

        <table class="data-table manifest-table">
          <thead>
            <tr>
              <th v-for="column in manifest.header" :key="column">{{ column }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIndex) in manifest.rows" :key="rowIndex">
              <td v-for="(cell, cellIndex) in row" :key="cellIndex" class="manifest-cell">
                {{ cell === '' ? '（空）' : cell }}
              </td>
            </tr>
          </tbody>
        </table>

        <section v-if="checkResult" class="check-panel">
          <h4>回读核对结果</h4>
          <p>
            转义读法每行列数：{{ checkResult.verify.quotedColumns.join(', ') }}<br />
            固定分隔符读法每行列数：{{ checkResult.verify.fixedColumns.join(', ') }}<br />
            两种读法列数一致：
            <strong :class="checkResult.verify.consistent ? 'ok-text' : 'error-text'">
              {{ checkResult.verify.consistent ? '是' : '否' }}
            </strong>
            ｜ 清单与页面明细一致：
            <strong :class="checkResult.pageConsistent ? 'ok-text' : 'error-text'">
              {{ checkResult.pageConsistent ? '是' : '否' }}
            </strong>
          </p>
          <table class="data-table">
            <thead>
              <tr><th>清单行</th><th>配置编号</th><th>负责人</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in checkResult.ownerChecks" :key="item.rowIndex">
                <td>第 {{ item.rowIndex }} 行</td>
                <td>{{ item.configId }}</td>
                <td>{{ item.owner }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="versionResult" class="check-panel">
          <h4>版本冲突取舍</h4>
          <p>
            当前校验和：{{ manifest.checksum }} ｜ 待导出校验和：{{ versionResult.candidateChecksum }}<br />
            结论：<strong>{{ versionResult.decision }}</strong>
            （{{ versionResult.same ? '内容未变，重试不产生第二份清单' : '内容已变，确认导出后版本号递增' }}）
          </p>
        </section>

        <details class="raw-file">
          <summary>查看导出文件原文（含分隔规则声明行）</summary>
          <pre>{{ manifest.content }}</pre>
        </details>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无数据源接入数据，可先登记接入配置</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据源接入记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="infoMessage" class="ok-text">{{ infoMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  archiveManifest,
  checkManifest,
  confirmManifest,
  downloadEntries,
  exportEntries,
  listEntries,
  moduleMeta,
  readManifest,
  resolveVersionConflict,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import type { ManifestRecord } from '@/data/manifest-store'

const meta = moduleMeta('source')
const columns = ["配置编号", "连接类型", "接入地址", "认证凭证", "连接池大小", "超时秒数", "重试上限", "负责人"]
const actions = ["提交校验", "建立连接", "断开连接"]
const statuses = ["草稿", "待校验", "已连接", "已断开"]
const stats = [{"label": "接入配置总数", "value": 0}, {"label": "已连接接入", "value": 0}, {"label": "待校验接入", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const exporting = ref(false)
const manifest = ref<ManifestRecord | null>(null)
const checkResult = ref<ReturnType<typeof checkManifest> | null>(null)
const versionResult = ref<ReturnType<typeof resolveVersionConflict> | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function refreshManifest() {
  manifest.value = readManifest(meta.key)
  if (manifest.value) {
    checkResult.value = checkManifest(meta.key)
  } else {
    checkResult.value = null
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

async function exportRows() {
  errorMessage.value = ''
  infoMessage.value = ''
  exporting.value = true
  try {
    const result = await exportEntries(meta.key)
    // 同时触发下载，下游文件直接读取这份已落库的清单数据表。
    await downloadEntries(meta.key)
    infoMessage.value = result.reused
      ? `清单内容未变，复用 v${result.record.version} 同一份清单数据表`
      : `已生成可回读清单数据表 v${result.record.version}，分隔规则：${result.record.delimiterName}`
    versionResult.value = null
    refreshManifest()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '清单导出失败'
  } finally {
    exporting.value = false
  }
}

async function onConfirm() {
  errorMessage.value = ''
  try {
    await confirmManifest(meta.key)
    refreshManifest()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '确认失败'
  }
}

async function onArchive() {
  errorMessage.value = ''
  try {
    await archiveManifest(meta.key)
    refreshManifest()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '归档失败'
  }
}

function onCheck() {
  errorMessage.value = ''
  try {
    checkResult.value = checkManifest(meta.key)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '回读核对失败'
  }
}

function onVersionCompare() {
  errorMessage.value = ''
  versionResult.value = resolveVersionConflict(meta.key)
}

function openCreate() {
  errorMessage.value = '接入配置登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  refreshManifest()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据源接入列表读取失败'
  }
}

onMounted(() => {
  reload()
  refreshManifest()
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
.check-panel {
  margin-top: 10px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
.check-panel h4 {
  margin: 6px 0;
  font-size: 13px;
}
.ok-text {
  color: #067647;
}
.raw-file pre {
  background: #0f172a;
  color: #e2e8f0;
  padding: 10px;
  border-radius: 6px;
  font-size: 12px;
  overflow-x: auto;
}
</style>
