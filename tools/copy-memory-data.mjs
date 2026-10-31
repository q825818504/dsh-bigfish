/**
 * 把旧记忆库的数据搬进新的范围库（在线执行，不用关 DSH）
 * ============================================================================
 * 旧：D:\大肥鱼\记忆\workspace-f60efa11.sqlite3        （9.88 MB，有数据）
 * 新：D:\大肥鱼\数据\ws-f60efa11-…\memory-ws-f60efa11-cf48.sqlite3  （4 KB，空壳）
 *
 * 做法：打开新库，ATTACH 旧库，逐表 INSERT。不替换文件，所以 DSH 手里的
 * 句柄依然有效；旧库只读打开，不会动它。
 *
 * 用法：node --experimental-sqlite tools/copy-memory-data.mjs [--dry]
 * ============================================================================
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'

const DRY = process.argv.includes('--dry')

const OLD = 'D:\\大肥鱼\\记忆\\workspace-f60efa11.sqlite3'
const NEW = 'D:\\大肥鱼\\数据\\ws-f60efa11-cf48-49de-9d8b-4a28e45975f3\\memory-ws-f60efa11-cf48.sqlite3'

const MB = (n) => (n / 1024 / 1024).toFixed(2) + ' MB'

if (!existsSync(OLD)) { console.error('旧库不存在:', OLD); process.exit(1) }
if (!existsSync(NEW)) { console.error('新库不存在:', NEW); process.exit(1) }

console.log('旧库:', OLD, MB(statSync(OLD).size))
console.log('新库:', NEW, MB(statSync(NEW).size))
console.log('模式:', DRY ? 'DRY RUN' : '实际执行')
console.log('')

const src = new DatabaseSync(OLD, { readOnly: true })
const dst = new DatabaseSync(NEW)

// 旧库的表清单（跳过 SQLite 内部表）
// ⚠️ search_index_* 是 FTS5 虚拟表的内部影子表，直接写会报
//    "table search_index_config may not be modified"。
//    只写虚拟表 search_index 本身，影子表由 FTS5 自动重建。
const SHADOW = /^search_index_(config|content|data|docsize|idx)$/
const tables = src.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map((r) => r.name).filter((n) => !SHADOW.test(n))

console.log('表:', tables.join(', '))
console.log('')

// 每张表在两边各有多少行
const report = []
for (const t of tables) {
  let oldCount = 0, newCount = 0
  try { oldCount = src.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c } catch {}
  try { newCount = dst.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c } catch {}
  report.push({ table: t, oldCount, newCount })
}
for (const r of report) {
  console.log(`  ${r.table.padEnd(16)} 旧=${String(r.oldCount).padStart(6)}  新=${String(r.newCount).padStart(6)}`)
}
console.log('')

if (DRY) {
  console.log('DRY RUN 结束，没有写入。')
  src.close(); dst.close()
  process.exit(0)
}

// 真正搬数据：逐表「先清空再复制」，保持旧库的完整内容
dst.exec('PRAGMA foreign_keys = OFF')
dst.exec(`ATTACH DATABASE '${OLD.replace(/'/g, "''")}' AS old`)

let copied = 0
dst.exec('BEGIN')
try {
  for (const r of report) {
    const t = r.table
    if (r.oldCount === 0) continue
    dst.exec(`DELETE FROM main."${t}"`)
    const info = dst.prepare(`INSERT INTO main."${t}" SELECT * FROM old."${t}"`).run()
    copied += Number(info.changes || 0)
    console.log(`  ${t}: 写入 ${info.changes}`)
  }
  dst.exec('COMMIT')
  console.log('')
  console.log('提交完成，共写入', copied, '行')
} catch (e) {
  dst.exec('ROLLBACK')
  console.error('失败，已回滚:', e.message)
  process.exitCode = 1
} finally {
  try { dst.exec('DETACH DATABASE old') } catch {}
  src.close()
  dst.close()
}

console.log('')
console.log('新库现在大小:', MB(statSync(NEW).size))
console.log('旧库原样保留:', OLD)
