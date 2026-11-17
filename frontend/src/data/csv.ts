/**
 * 清单 CSV 的序列化与回读。
 *
 * 历史上下游有两类读取工具：
 *  1. 「按逗号转义读取」：遵循 RFC 4180，识别双引号包裹、双引号转义；
 *  2. 「按固定分隔符读取」：只按声明的分隔符切列，不识别引号。
 * 本模块导出的文件必须同时满足两种读法：
 *  - 文件首行用注释行标注实际分隔规则（分隔符 / 是否双引号转义）；
 *  - 单元格内的真实换行统一拍平成字面量 `\n`，保证固定分隔符读法按物理行切也不会串列；
 *  - 含分隔符、引号或字面量换行标记的单元格整体加双引号转义，保证转义读法边界正确；
 *  - 两种读法下列数一致，接入地址里的逗号永远不能改变字段边界。
 */

export type DelimiterRule = {
  /** 实际使用的列分隔符。 */
  delimiter: string
  /** 分隔符在声明行里的可读名称。 */
  name: string
  /** 是否对特殊单元格做双引号转义（RFC 4180）。 */
  quoted: boolean
}

const CANDIDATE_DELIMITERS: { char: string; name: string }[] = [
  { char: ',', name: '逗号' },
  { char: '\t', name: '制表符(Tab)' },
  { char: '|', name: '竖线' },
  { char: ';', name: '分号' },
  { char: '\u001f', name: '单元分隔符(US)' },
]

/** 单元格内真实换行统一拍平成这个字面量，固定分隔符读法才能按物理行回读。 */
export const NEWLINE_LITERAL = '\\n'
const QUOTE = '"'

/** 声明行前缀，解析器只认这个前缀，避免被当成数据列。 */
export const DECLARATION_PREFIX = '# 分隔规则声明:'

/** 挑一个所有单元格里都不出现的字符当分隔符，从逗号开始优先。 */
export function pickDelimiter(rows: (string | number | boolean)[][]): DelimiterRule {
  const joined = rows.map((row) => row.map((cell) => String(cell ?? '')).join('')).join('')
  const found = CANDIDATE_DELIMITERS.find((candidate) => !joined.includes(candidate.char))
  if (!found) {
    throw new Error('数据包含全部候选分隔符，无法确定安全的列分隔规则')
  }
  return { delimiter: found.char, name: found.name, quoted: true }
}

function flattenCell(value: string | number | boolean | null | undefined): string {
  return String(value ?? '').replace(/\r\n|\r|\n/g, NEWLINE_LITERAL)
}

function escapeCell(value: string, delimiter: string): string {
  const needsQuote =
    value.includes(delimiter) || value.includes(QUOTE) || value.includes(NEWLINE_LITERAL)
  if (!needsQuote) {
    return value
  }
  return QUOTE + value.replace(/"/g, '""') + QUOTE
}

function buildDeclaration(rule: DelimiterRule, columnCount: number): string {
  return `${DECLARATION_PREFIX} 分隔符=${rule.name} 双引号转义=${rule.quoted ? '是' : '否'} 列数=${columnCount}`
}

export type CsvTable = {
  header: string[]
  rows: string[][]
  rule: DelimiterRule
  /** 带 BOM 与声明行、可直接落盘的完整文件内容。 */
  content: string
}

/** 按实际分隔规则把表头与数据行序列化为可回读的清单文件。 */
export function serializeTable(
  header: string[],
  rows: (string | number | boolean | null | undefined)[][],
): CsvTable {
  const rawRows = [header, ...rows].map((row) => row.map((cell) => flattenCell(cell)))
  const rule = pickDelimiter(rawRows)
  const columnCount = header.length
  const physicalLines = rawRows.map((row) =>
    row.map((cell) => escapeCell(cell, rule.delimiter)).join(rule.delimiter),
  )
  const declaration = buildDeclaration(rule, columnCount)
  // BOM 让 Excel 等工具识别 UTF-8；声明行单独占一个物理行，两种读法都先跳过它。
  const content = `﻿${[declaration, ...physicalLines].join('\n')}`
  return {
    header,
    rows: rawRows.slice(1).map((row) => row.map(unflattenCell)),
    rule,
    content,
  }
}

/** 把字面量 `\n` 还原为真实换行，回读后跨行文本仍落在同一个单元格里。 */
export function unflattenCell(value: string): string {
  return value.replace(/\\n/g, '\n')
}

/** 从文件内容里解析声明行，找不到时回退为逗号 + 双引号转义的默认规则。 */
export function parseDeclaration(content: string): DelimiterRule {
  const bomStripped = content.replace(/^﻿/, '')
  const firstLineEnd = bomStripped.indexOf('\n')
  const firstLine = firstLineEnd >= 0 ? bomStripped.slice(0, firstLineEnd) : bomStripped
  if (!firstLine.startsWith(DECLARATION_PREFIX)) {
    return { delimiter: ',', name: '逗号', quoted: true }
  }
  const matched = CANDIDATE_DELIMITERS.find((candidate) =>
    firstLine.includes(`分隔符=${candidate.name}`),
  )
  const quoted = !firstLine.includes('双引号转义=否')
  if (matched) {
    return { delimiter: matched.char, name: matched.name, quoted }
  }
  return { delimiter: ',', name: '逗号', quoted }
}

function stripDeclarationAndBom(content: string): string {
  const bomStripped = content.replace(/^﻿/, '')
  const lines = bomStripped.split('\n')
  if (lines[0]?.startsWith(DECLARATION_PREFIX)) {
    return lines.slice(1).join('\n')
  }
  return bomStripped
}

/**
 * 旧工具一：按逗号/声明分隔符转义读取（RFC 4180 状态机）。
 * 识别双引号包裹、`""` 转义，跨行字面量在单元格内保留，再还原真实换行。
 */
export function parseCsvQuoted(content: string): string[][] {
  const rule = parseDeclaration(content)
  const body = stripDeclarationAndBom(content)
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (inQuotes) {
      if (char === QUOTE) {
        if (body[i + 1] === QUOTE) {
          field += QUOTE
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === QUOTE) {
      inQuotes = true
    } else if (char === rule.delimiter) {
      record.push(unflattenCell(field))
      field = ''
    } else if (char === '\n') {
      record.push(unflattenCell(field))
      records.push(record)
      record = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }
  // 文件末尾没有换行时补最后一条记录。
  if (field !== '' || record.length > 0) {
    record.push(unflattenCell(field))
    records.push(record)
  }
  return records
}

/**
 * 旧工具二：按固定分隔符读取，不识别双引号。
 * 依赖序列化时把真实换行拍平成字面量、且分隔符对数据安全，
 * 因此每个物理行就是一条记录，直接按分隔符切列即可。
 * 为了和转义读法的列数严格一致，这里把转义读法的引号外壳也剥掉。
 */
export function parseCsvFixed(content: string): string[][] {
  const rule = parseDeclaration(content)
  const body = stripDeclarationAndBom(content)
  return body
    .split('\n')
    .filter((line) => line !== '')
    .map((line) =>
      line
        .split(rule.delimiter)
        .map((cell) => unflattenCell(stripQuotes(cell))),
    )
}

function stripQuotes(cell: string): string {
  if (cell.length >= 2 && cell.startsWith(QUOTE) && cell.endsWith(QUOTE)) {
    return cell.slice(1, -1).replace(/""/g, '"')
  }
  return cell
}

/** 两种读法并列回读，列数不一致直接抛错——不允许带边界歧义的清单落盘。 */
export function readBackTable(content: string): {
  header: string[]
  rows: string[][]
  fixedRows: string[][]
  rule: DelimiterRule
} {
  const rule = parseDeclaration(content)
  const quotedRecords = parseCsvQuoted(content)
  const fixedRecords = parseCsvFixed(content)
  const expectedColumns = quotedRecords[0]?.length ?? 0
  if (expectedColumns === 0) {
    throw new Error('清单内容为空，无法回读')
  }
  quotedRecords.forEach((record, index) => {
    if (record.length !== expectedColumns) {
      throw new Error(`转义读法第 ${index + 1} 行列数为 ${record.length}，应为 ${expectedColumns}`)
    }
  })
  fixedRecords.forEach((record, index) => {
    if (record.length !== expectedColumns) {
      throw new Error(`固定分隔符读法第 ${index + 1} 行列数为 ${record.length}，应为 ${expectedColumns}`)
    }
  })
  if (fixedRecords.length !== quotedRecords.length) {
    throw new Error(
      `两种读法行数不一致：转义读法 ${quotedRecords.length} 行，固定分隔符读法 ${fixedRecords.length} 行`,
    )
  }
  return {
    header: quotedRecords[0],
    rows: quotedRecords.slice(1),
    fixedRows: fixedRecords.slice(1),
    rule,
  }
}
