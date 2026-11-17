import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, __setEntryStorage } from '@/data/local-store'
import { serializeTable, readBackTable } from '@/data/csv'
import {
  compareVersions,
  generateManifest,
  getManifest,
  listManifests,
  markManifestRollback,
  transitionManifest,
  verifyManifest,
  __setManifestStorage,
  type ManifestRecord,
  type ManifestStatus,
} from '@/data/manifest-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 测试支撑：注入内存存储并直接落行，浏览器运行时不会调用。
export function __setEntryStorageForTest(
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null,
): void {
  __setEntryStorage(storage)
  __setManifestStorage(storage)
}

export function __saveRowsForTest(key: string, rows: EntryRow[]): void {
  saveRows(key, rows)
}

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  // 回退类动作不改变清单生命周期，只在同一份清单数据表上打异常标记。
  if (NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)) && getManifest(key)) {
    void markManifestRollback(key, `${meta.entity}执行「${action}」，清单状态回退待核对`)
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

/**
 * 构建模块清单文件：字段按实际分隔规则序列化，接入地址里的逗号不会改变字段边界。
 * 落库前先用两种旧工具读法各回读一遍，列数不一致直接失败，绝不产出歧义清单。
 */
export function buildExportContent(key: string): {
  filename: string
  content: string
  header: string[]
  rows: (string | number | boolean | null | undefined)[][]
} {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const rows = listRows(key).map((row) => [
    row.id,
    ...meta.fields.map((field) => row[field] ?? ''),
    row.status,
  ])
  const table = serializeTable(header, rows)
  // 落盘前的可回读门禁：转义读法与固定分隔符读法列数必须一致。
  readBackTable(table.content)
  return { filename: `${meta.name}-清单.csv`, content: table.content, header, rows }
}

/**
 * 导出并落一份「可回读的清单数据表」。
 * 重试 / 并发且内容未变时幂等复用同一份记录；内容变化才按版本冲突规则升版本。
 */
export async function exportEntries(key: string): Promise<{
  filename: string
  content: string
  record: ManifestRecord
  reused: boolean
}> {
  const meta = moduleMeta(key)
  const { filename, content } = buildExportContent(key)
  const { record, reused } = await generateManifest(key, meta.name, filename, content)
  return { filename, content, record, reused }
}

export async function downloadEntries(key: string): Promise<void> {
  // 下载入口统一读取已落库的清单数据表，而不是现场重拼，保证导出与清单记录一致。
  const existing = getManifest(key)
  let content: string
  let filename: string
  if (existing) {
    content = existing.content
    filename = existing.filename
  } else {
    const exported = await exportEntries(key)
    content = exported.content
    filename = exported.filename
  }
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 读取某模块的可回读清单数据表（结果列表与详情页面共用）。 */
export function readManifest(key: string): ManifestRecord | null {
  return getManifest(key)
}

export function readAllManifests(): ManifestRecord[] {
  return listManifests()
}

/** 确认清单：生命周期 已生成 → 已确认。 */
export async function confirmManifest(key: string): Promise<ManifestRecord> {
  return transitionManifest(key, '已确认' as ManifestStatus)
}

/** 归档清单：生命周期 已确认 → 已归档，接入配置与连接配置随结果归档。 */
export async function archiveManifest(key: string): Promise<ManifestRecord> {
  return transitionManifest(key, '已归档' as ManifestStatus)
}

/** 详情页核对：对归档内容做两种读法回读，并比对来源负责人对应关系。 */
export function checkManifest(key: string): {
  record: ManifestRecord
  verify: ReturnType<typeof verifyManifest>
  ownerChecks: { rowIndex: number; configId: string; owner: string }[]
  pageConsistent: boolean
} {
  const record = getManifest(key)
  if (!record) {
    throw new Error('还没有可回读的清单数据表，请先导出清单')
  }
  const verify = verifyManifest(record)
  const meta = moduleMeta(key)
  const ownerIndex = record.header.indexOf('负责人')
  const idIndex = record.header.indexOf(meta.fields[0])
  const sourceRows = listRows(key)
  const ownerChecks = record.rows.map((row, rowIndex) => ({
    rowIndex: rowIndex + 1,
    configId: idIndex >= 0 ? row[idIndex] : '',
    owner: ownerIndex >= 0 ? row[ownerIndex] : '',
  }))
  // 清单与页面明细逐行核对：编号与负责人必须一一对应。
  const pageConsistent =
    sourceRows.length === record.rowCount &&
    sourceRows.every((sourceRow, rowIndex) => {
      const parsedRow = record.rows[rowIndex]
      if (!parsedRow) {
        return false
      }
      return (
        String(sourceRow[meta.fields[0]] ?? '') === parsedRow[idIndex] &&
        String(sourceRow['负责人'] ?? '') === parsedRow[ownerIndex]
      )
    })
  return { record, verify, ownerChecks, pageConsistent }
}

/** 版本冲突处理：比较当前清单与待导出内容，给出取舍结论。 */
export function resolveVersionConflict(key: string): ReturnType<typeof compareVersions> | null {
  const existing = getManifest(key)
  if (!existing) {
    return null
  }
  const { content } = buildExportContent(key)
  return compareVersions(existing, content)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
