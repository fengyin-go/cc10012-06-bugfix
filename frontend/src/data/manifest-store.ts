/**
 * 可回读清单数据表的持久化。
 *
 * 每个业务模块只保留一份「可回读的清单数据表」：
 *  - 重试导出时内容未变则幂等返回同一份记录，绝不落第二份；
 *  - 并发写入经同一把写锁串行化，读-改-写在锁内一次完成；
 *  - 生命周期只能按 已生成 → 已确认 → 已归档 顺序流转，回退动作只打异常标记不改阶段；
 *  - 版本冲突（旧状态上重新生成）按内容哈希比较取舍：内容相同沿用原版本，不同才升版本。
 */
import { parseCsvFixed, parseCsvQuoted, readBackTable } from './csv'

const MANIFEST_STORAGE_KEY = 'data-explore-studio:manifests'

/** 清单生命周期：只能按数组顺序向前流转。 */
export const MANIFEST_STATUSES = ['已生成', '已确认', '已归档'] as const
export type ManifestStatus = (typeof MANIFEST_STATUSES)[number]

export type FieldQuality = {
  rowCount: number
  columnCount: number
  /** 每列的非空单元格数，回读源表样本后形成字段质量。 */
  nonNullByColumn: number[]
  /** 含逗号 / 跨行的单元格数，用来核对边界处理是否生效。 */
  commaCellCount: number
  multilineCellCount: number
}

export type ManifestRecord = {
  moduleKey: string
  moduleName: string
  filename: string
  /** 实际落盘的文件内容（BOM + 分隔规则声明行 + 数据行）。 */
  content: string
  delimiterName: string
  /** 表头与两种读法回读出的数据，随结果一起归档。 */
  header: string[]
  rows: string[][]
  fixedRows: string[][]
  fieldQuality: FieldQuality
  status: ManifestStatus
  version: number
  checksum: string
  rowCount: number
  columnCount: number
  createdAt: string
  updatedAt: string
  abnormal: boolean
  abnormalReason: string
}

type ManifestMap = Record<string, ManifestRecord>

type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): StorageLike | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  return null
}

// 测试环境可注入内存存储；浏览器环境始终走 localStorage。
let storageOverride: StorageLike | null = null

export function __setManifestStorage(storage: StorageLike | null): void {
  storageOverride = storage
  cache = null
  writeChain = Promise.resolve()
}

function activeStorage(): StorageLike | null {
  return storageOverride ?? defaultStorage()
}

let cache: ManifestMap | null = null
// 写锁：所有写操作排队执行，保证并发写入只落一份。
let writeChain: Promise<unknown> = Promise.resolve()

function readAll(): ManifestMap {
  if (cache !== null) {
    return cache
  }
  const storage = activeStorage()
  if (!storage) {
    cache = {}
    return cache
  }
  const raw = storage.getItem(MANIFEST_STORAGE_KEY)
  if (!raw) {
    cache = {}
    return cache
  }
  try {
    cache = JSON.parse(raw) as ManifestMap
  } catch {
    cache = {}
  }
  return cache
}

function persist(map: ManifestMap): void {
  cache = map
  const storage = activeStorage()
  if (storage) {
    // 一次性整体写入，避免并发下出现半截记录。
    storage.setItem(MANIFEST_STORAGE_KEY, JSON.stringify(map))
  }
}

function enqueueWrite<T>(task: () => T): Promise<T> {
  const run = writeChain.then(task, task)
  // 链上任何失败都不阻断后续任务。
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** FNV-1a 32 位哈希，版本冲突时按内容比较取舍。 */
export function checksumOf(content: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function buildFieldQuality(
  header: string[],
  rows: string[][],
  fixedRows: string[][],
): FieldQuality {
  const columnCount = header.length
  const nonNullByColumn = new Array(columnCount).fill(0)
  let commaCellCount = 0
  let multilineCellCount = 0
  for (const row of rows) {
    row.forEach((cell, index) => {
      if (cell.trim() !== '') {
        nonNullByColumn[index] += 1
      }
      if (cell.includes(',')) {
        commaCellCount += 1
      }
      if (cell.includes('\n')) {
        multilineCellCount += 1
      }
    })
  }
  // 固定分隔符读法也能回读同样的行数，字段质量才成立。
  if (fixedRows.length !== rows.length) {
    throw new Error('字段质量核对失败：两种读法行数不一致')
  }
  return {
    rowCount: rows.length,
    columnCount,
    nonNullByColumn,
    commaCellCount,
    multilineCellCount,
  }
}

export type GeneratedManifest = {
  record: ManifestRecord
  /** true 表示复用了既有记录（重试 / 并发同内容），没有新增数据表。 */
  reused: boolean
}

/**
 * 生成（或幂等复用）某模块的可回读清单数据表。
 * @param moduleKey 模块键
 * @param moduleName 模块中文名
 * @param filename 下载文件名
 * @param content 已通过两读法校验的清单文件内容
 */
export function generateManifest(
  moduleKey: string,
  moduleName: string,
  filename: string,
  content: string,
): Promise<GeneratedManifest> {
  return enqueueWrite(() => {
    const readBack = readBackTable(content)
    const checksum = checksumOf(content)
    const map = readAll()
    const existing = map[moduleKey]
    const now = new Date().toISOString()

    // 重试 / 并发：内容完全相同则直接复用，保证只落一份。
    if (existing && existing.checksum === checksum) {
      return { record: existing, reused: true }
    }

    const fieldQuality = buildFieldQuality(
      readBack.header,
      readBack.rows,
      readBack.fixedRows,
    )
    let version = 1
    let status: ManifestStatus = '已生成'
    let abnormal = false
    let abnormalReason = ''
    if (existing) {
      // 版本冲突：旧版本上重新生成且内容有变，保留历史版本号递增；
      // 已确认/已归档的清单被覆盖时标记异常并回到「已生成」重新走流程。
      version = existing.version + 1
      if (existing.status !== '已生成') {
        abnormal = true
        abnormalReason = `版本冲突：${existing.status}的清单内容发生变化，新版本重新进入已生成`
      }
    }

    const record: ManifestRecord = {
      moduleKey,
      moduleName,
      filename,
      content,
      delimiterName: readBack.rule.name,
      header: readBack.header,
      rows: readBack.rows,
      fixedRows: readBack.fixedRows,
      fieldQuality,
      status,
      version,
      checksum,
      rowCount: readBack.rows.length,
      columnCount: readBack.header.length,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      abnormal,
      abnormalReason,
    }
    persist({ ...map, [moduleKey]: record })
    return { record, reused: false }
  })
}

/** 顺序流转：只允许 已生成→已确认→已归档，跳步或回退一律拒绝。 */
export function transitionManifest(
  moduleKey: string,
  next: ManifestStatus,
): Promise<ManifestRecord> {
  return enqueueWrite(() => {
    const map = readAll()
    const existing = map[moduleKey]
    if (!existing) {
      throw new Error(`模块 ${moduleKey} 还没有可回读的清单数据表`)
    }
    const currentIndex = MANIFEST_STATUSES.indexOf(existing.status)
    const nextIndex = MANIFEST_STATUSES.indexOf(next)
    if (nextIndex !== currentIndex + 1) {
      throw new Error(
        `生命周期只能按 ${MANIFEST_STATUSES.join(' → ')} 顺序流转，当前「${existing.status}」不能转为「${next}」`,
      )
    }
    const updated: ManifestRecord = { ...existing, status: next, updatedAt: new Date().toISOString() }
    persist({ ...map, [moduleKey]: updated })
    return updated
  })
}

/**
 * 状态回退（撤销/驳回类动作）：不允许改变生命周期阶段，
 * 只在当前清单上打异常标记，保证仍只有一份数据表。
 */
export function markManifestRollback(
  moduleKey: string,
  reason: string,
): Promise<ManifestRecord> {
  return enqueueWrite(() => {
    const map = readAll()
    const existing = map[moduleKey]
    if (!existing) {
      throw new Error(`模块 ${moduleKey} 还没有可回读的清单数据表`)
    }
    const updated: ManifestRecord = {
      ...existing,
      abnormal: true,
      abnormalReason: reason,
      updatedAt: new Date().toISOString(),
    }
    persist({ ...map, [moduleKey]: updated })
    return updated
  })
}

export function getManifest(moduleKey: string): ManifestRecord | null {
  return readAll()[moduleKey] ?? null
}

export function listManifests(): ManifestRecord[] {
  return Object.values(readAll()).sort((a, b) => a.moduleKey.localeCompare(b.moduleKey))
}

/** 版本冲突比较：返回两份内容的取舍结论，供页面提示与测试核对。 */
export function compareVersions(
  current: ManifestRecord,
  candidateContent: string,
): { same: boolean; candidateChecksum: string; decision: '沿用当前版本' | '生成新版本' } {
  const candidateChecksum = checksumOf(candidateContent)
  const same = candidateChecksum === current.checksum
  return {
    same,
    candidateChecksum,
    decision: same ? '沿用当前版本' : '生成新版本',
  }
}

/** 用两种读法重新回读已归档内容，详情页面核对时调用。 */
export function verifyManifest(record: ManifestRecord): {
  quotedColumns: number[]
  fixedColumns: number[]
  consistent: boolean
} {
  const quoted = parseCsvQuoted(record.content)
  const fixed = parseCsvFixed(record.content)
  const quotedColumns = quoted.map((row) => row.length)
  const fixedColumns = fixed.map((row) => row.length)
  const consistent =
    quotedColumns.length === fixedColumns.length &&
    quotedColumns.every((count, index) => count === fixedColumns[index])
  return { quotedColumns, fixedColumns, consistent }
}
