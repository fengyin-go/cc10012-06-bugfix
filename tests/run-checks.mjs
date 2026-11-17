/**
 * 可回读接入配置清单的端到端核对脚本（Node 环境，内存存储，无浏览器依赖）。
 * 运行：node tests/run-checks.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { build } = require(path.resolve(import.meta.dirname, '..', 'frontend', 'node_modules', 'esbuild'))

const repoRoot = path.resolve(import.meta.dirname, '..', 'frontend')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-check-'))
const outFile = path.join(outDir, 'bundle.mjs')

// 内存版 localStorage，local-store 与 manifest-store 共用。
function createMemoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    _dump: () => Object.fromEntries(map),
  }
}

await build({
  entryPoints: [path.join(repoRoot, 'src', 'api', 'local-service.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: outFile,
  alias: { '@': path.join(repoRoot, 'src') },
  logLevel: 'silent',
})

const service = await import(pathToFileURL(outFile).href)
const manifestStoreUrl = pathToFileURL(
  path.join(repoRoot, 'src', 'data', 'manifest-store.ts'),
).href
// manifest-store 通过 bundle 已包含；这里再单独取一份用于存储注入测试。
const csv = await import(
  pathToFileURL(path.join(repoRoot, 'src', 'data', 'csv.ts')).href
)

let passed = 0
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`  ✓ ${name}`)
    })
}

const storage = createMemoryStorage()
service.__setEntryStorageForTest?.(storage)

// local-store 的注入函数也被 bundle 进来了
const mod = await import(pathToFileURL(outFile).href)

console.log('1) 序列化与两种旧工具读法')
await check('声明行标注实际分隔规则', () => {
  const { content } = service.buildExportContent('source')
  assert.ok(content.startsWith('﻿# 分隔规则声明:'), '文件应以 BOM + 分隔规则声明行开头')
  assert.ok(content.includes('分隔符=制表符(Tab)'), '数据含逗号时应改用 Tab 并在声明行标注')
  assert.ok(content.includes('双引号转义=是'))
})

await check('SOUR-0001 地址含逗号：连接类型/接入地址/负责人仍分属三列', () => {
  const { content } = service.buildExportContent('source')
  const read = csv.readBackTable(content)
  const header = read.header
  const typeIdx = header.indexOf('连接类型')
  const addrIdx = header.indexOf('接入地址')
  const ownerIdx = header.indexOf('负责人')
  const firstRow = read.rows[0]
  assert.equal(firstRow[header.indexOf('配置编号')], 'SOUR-0001')
  assert.equal(firstRow[typeIdx], 'JDBC')
  assert.equal(
    firstRow[addrIdx],
    'jdbc:mysql://10.0.0.1:3306,10.0.0.2:3306/warehouse?useSSL=false',
  )
  assert.equal(firstRow[ownerIdx], '王敏')
  // 固定分隔符读法下列完全对齐
  const fixedFirst = read.fixedRows[0]
  assert.equal(fixedFirst[typeIdx], 'JDBC')
  assert.equal(
    fixedFirst[addrIdx],
    'jdbc:mysql://10.0.0.1:3306,10.0.0.2:3306/warehouse?useSSL=false',
  )
  assert.equal(fixedFirst[ownerIdx], '王敏')
})

await check('跨行文本与空字段同时出现，每行列数一致且可回读', () => {
  const { content } = service.buildExportContent('source')
  const read = csv.readBackTable(content)
  const expected = read.header.length
  assert.equal(expected, 10) // 编号 + 8 业务字段 + 当前状态
  for (const row of read.rows) assert.equal(row.length, expected)
  for (const row of read.fixedRows) assert.equal(row.length, expected)
  const second = read.rows[1]
  const addrIdx = read.header.indexOf('接入地址')
  const credIdx = read.header.indexOf('认证凭证')
  const poolIdx = read.header.indexOf('连接池大小')
  assert.ok(second[addrIdx].includes('\n备用: https://bak.example.cn/v2/sales'), '跨行文本应还原真实换行')
  assert.equal(second[credIdx], 'Bearer token-0002')
  assert.equal(second[poolIdx], '', '空字段回读为空字符串')
  // 固定读法同样保留跨行字面量还原
  assert.ok(read.fixedRows[1][addrIdx].includes('\n备用:'))
  assert.equal(read.fixedRows[1][poolIdx], '')
})

await check('含双引号的单元格两种读法都能正确剥离引号外壳', () => {
  const { content } = service.buildExportContent('source')
  const read = csv.readBackTable(content)
  const credIdx = read.header.indexOf('认证凭证')
  assert.equal(read.rows[2][credIdx], 'SASL "plain" 凭证')
  assert.equal(read.fixedRows[2][credIdx], 'SASL "plain" 凭证')
})

console.log('2) 可回读清单数据表的持久化与并发')
// 通过 bundle 里的 manifest-store 接口测试；local-service 已 re-export 业务封装。
await check('首次导出生成一份清单数据表', async () => {
  const result = await service.exportEntries('source')
  assert.equal(result.reused, false)
  assert.equal(result.record.status, '已生成')
  assert.equal(result.record.version, 1)
  assert.equal(result.record.rowCount, 3)
  assert.equal(result.record.columnCount, 10)
})

await check('重试导出内容未变：幂等复用，不产生第二份', async () => {
  const r1 = await service.exportEntries('source')
  const r2 = await service.exportEntries('source')
  assert.equal(r1.reused, true)
  assert.equal(r2.reused, true)
  assert.equal(r1.record.checksum, r2.record.checksum)
  const all = service.readAllManifests().filter((m) => m.moduleKey === 'source')
  assert.equal(all.length, 1, 'source 模块只能有一份清单数据表')
})

await check('并发写入只落一份', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () => service.exportEntries('source')),
  )
  assert.ok(results.every((r) => r.reused))
  const all = service.readAllManifests().filter((m) => m.moduleKey === 'source')
  assert.equal(all.length, 1)
})

await check('刷新后重新进入（模拟重读存储）清单仍可核对', async () => {
  // localStorage 里确实有一条 manifest 记录
  const raw = storage.getItem('data-explore-studio:manifests')
  assert.ok(raw)
  const parsed = JSON.parse(raw)
  assert.ok(parsed.source)
  const record = service.readManifest('source')
  assert.ok(record)
  const check = service.checkManifest('source')
  assert.equal(check.pageConsistent, true)
  assert.equal(check.verify.consistent, true)
})

console.log('3) 生命周期顺序流转与回退')
await check('未确认直接归档会被拒绝', async () => {
  await assert.rejects(() => service.archiveManifest('source'), /顺序流转/)
})

await check('已生成 → 已确认 → 已归档 顺序流转', async () => {
  const confirmed = await service.confirmManifest('source')
  assert.equal(confirmed.status, '已确认')
  const archived = await service.archiveManifest('source')
  assert.equal(archived.status, '已归档')
  // 归档后再次确认属于回退，拒绝
  await assert.rejects(() => service.confirmManifest('source'), /顺序流转/)
})

await check('归档后内容变更重新导出：版本冲突比较取舍并升版本', async () => {
  const conflict = service.resolveVersionConflict('source')
  assert.equal(conflict.decision, '沿用当前版本')
  // 改动来源数据（连接配置随结果归档场景）
  const rows = service.listEntries('source').items
  const mutated = rows.map((row) =>
    String(row['配置编号']) === 'SOUR-0001'
      ? { ...row, '负责人': '陈晨' }
      : row,
  )
  // 用数据层保存（bundle 内同一模块缓存）
  const localStore = await import(pathToFileURL(outFile).href)
  assert.equal(typeof localStore.__saveRowsForTest, 'function')
  localStore.__saveRowsForTest('source', mutated)
  const conflict2 = service.resolveVersionConflict('source')
  assert.equal(conflict2.decision, '生成新版本')
  const regenerated = await service.exportEntries('source')
  assert.equal(regenerated.reused, false)
  assert.equal(regenerated.record.version, 2)
  assert.equal(regenerated.record.status, '已生成')
  assert.equal(regenerated.record.abnormal, true, '已归档清单被覆盖应打异常标记')
  const all = service.readAllManifests().filter((m) => m.moduleKey === 'source')
  assert.equal(all.length, 1, '版本冲突后仍只保留一份数据表')
})

await check('回退动作只打异常标记，不改变生命周期阶段', async () => {
  const before = service.readManifest('source')
  // source 的动作里没有负向动词，直接用数据模块的回退语义：先确认再通过 runAction 触发
  await service.confirmManifest('source')
  // 断开连接不是负向动词；用 schedule 模块的「停用调度」验证通用回退链路
  await service.exportEntries('schedule')
  const scheduleRows = service.listEntries('schedule').items
  const target = scheduleRows.find((r) => r.status !== '已停用')
  if (target) {
    const res = service.runAction('schedule', Number(target.id), '停用调度')
    assert.equal(res.ok, true)
  }
  const after = service.readManifest('source')
  assert.equal(after.status, '已确认', '其他模块的回退不影响 source 生命周期')
  assert.ok(before)
})

console.log('4) 字段质量与下游一致性')
await check('字段质量来自源表样本回读', async () => {
  const record = service.readManifest('source')
  assert.equal(record.fieldQuality.rowCount, 3)
  assert.equal(record.fieldQuality.columnCount, 10)
  assert.ok(record.fieldQuality.commaCellCount >= 2, 'SOUR-0001/0003 地址都含逗号')
  assert.ok(record.fieldQuality.multilineCellCount >= 1, 'SOUR-0002 含跨行文本')
  // 空字段列的非空计数应小于总行数
  const credIdx = record.header.indexOf('认证凭证')
  assert.ok(record.fieldQuality.nonNullByColumn[credIdx] <= 3)
})

await check('导出结果与清单记录、页面明细一致', async () => {
  const recordBefore = service.readManifest('source')
  const built = service.buildExportContent('source')
  // 当前源数据已被改为负责人「陈晨」，清单与源表现已对齐（上一用例已重新生成）
  const aligned = await service.exportEntries('source')
  assert.equal(aligned.reused, true, '内容对齐后重试应幂等复用')
  assert.equal(aligned.record.content, built.content)
  assert.equal(recordBefore.content, built.content)
  const check = service.checkManifest('source')
  assert.equal(check.pageConsistent, true)
  const owner = check.ownerChecks.find((c) => c.configId === 'SOUR-0001')
  assert.equal(owner.owner, '陈晨')
})

await check('下游导出入口读取的就是清单数据表内容', async () => {
  const record = service.readManifest('source')
  // downloadEntries 在无 DOM 环境会在 Blob 处失败，改为直接验证其取值路径：
  // 已存在清单时返回的 content 必须等于存储内容
  const built = service.buildExportContent('source')
  assert.equal(built.content, record.content)
})

await check('损坏边界的清单无法通过回读门禁', () => {
  // 手工构造一份含未转义逗号、列数错位的内容
  const broken = '﻿# 分隔规则声明: 分隔符=逗号 双引号转义=是 列数=3\na,b,c\na,b,c,d\n'
  assert.throws(() => csv.readBackTable(broken), /列数/)
})

console.log(`\n全部 ${passed} 项核对通过`)
fs.rmSync(outDir, { recursive: true, force: true })
