import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyDataRoot, dataRootStamp, inspectMove } from '../lib/data-root-migrate.js'
import { MemoryStore } from '../lib/memory/store.js'

function 临时目录() {
  return mkdtempSync(join(tmpdir(), 'dafeiyu-root-move-'))
}

/** 造一个像真的数据根：scope.json + 一个范围目录（库 + 心情） */
function 造数据根(根) {
  mkdirSync(join(根, 'ws-abc'), { recursive: true })
  writeFileSync(join(根, 'scope.json'), JSON.stringify({ version: 1, mode: 'workspace', workspaceId: 'abc' }), 'utf8')
  const 库 = join(根, 'ws-abc', 'memory-ws-abc.sqlite3')
  const store = new MemoryStore(库)
  store.capture({ session: 's@1000', eventKey: '1', role: 'user', content: '搬家也要记得这条', sourceTime: 1000 })
  store.close()
  writeFileSync(join(根, 'ws-abc', 'mood-ws-abc.json'), JSON.stringify({ value: 66 }), 'utf8')
  return 库
}

test('inspect refuses to copy into a non-empty target and lists what is in the way', t => {
  const 家 = 临时目录()
  t.after(() => rmSync(家, { recursive: true, force: true }))
  const 源 = join(家, 'src')
  const 目标 = join(家, 'dst')
  mkdirSync(源, { recursive: true })
  造数据根(源)
  mkdirSync(目标, { recursive: true })
  writeFileSync(join(目标, '别人的东西.txt'), 'do not touch', 'utf8')

  const 结果 = inspectMove({ from: 源, to: 目标 })
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'target-not-empty')
  assert.deepEqual(结果.conflict, ['别人的东西.txt'])
  // 预演不能有任何副作用
  assert.deepEqual(readdirSync(目标), ['别人的东西.txt'])
})

test('inspect rejects the same directory and nested directories', t => {
  const 家 = 临时目录()
  t.after(() => rmSync(家, { recursive: true, force: true }))
  const 源 = join(家, 'src')
  mkdirSync(源, { recursive: true })

  assert.equal(inspectMove({ from: 源, to: 源 }).code, 'same-root')
  assert.equal(inspectMove({ from: 源, to: join(源, 'inner') }).code, 'nested')
  assert.equal(inspectMove({ from: 源, to: join(家, 'missing') }).ok, true, 'a fresh target is fine')
})

test('copyDataRoot copies everything, verifies it, and never deletes the source', t => {
  const 家 = 临时目录()
  t.after(() => rmSync(家, { recursive: true, force: true }))
  const 源 = join(家, 'src')
  const 目标 = join(家, 'dst')
  mkdirSync(源, { recursive: true })
  造数据根(源)

  const 源指纹 = dataRootStamp(源)
  const 结果 = copyDataRoot({ from: 源, to: 目标 })

  assert.equal(结果.ok, true, JSON.stringify(结果.warnings))
  assert.equal(结果.verified, true)
  assert.ok(结果.copied.length >= 3, 'scope.json + 库 + 心情')
  assert.deepEqual(结果.warnings, [])

  // 内容一致
  assert.equal(dataRootStamp(目标), 源指纹)
  assert.equal(
    JSON.parse(readFileSync(join(目标, 'scope.json'), 'utf8')).workspaceId,
    'abc',
  )
  // 复制出来的库是真能打开的，数据也在
  const 复制库 = new MemoryStore(join(目标, 'ws-abc', 'memory-ws-abc.sqlite3'))
  assert.equal(复制库.stats().messages, 1)
  assert.equal(复制库.integrityCheck().ok, true)
  复制库.close()

  // 源一个字节都没动
  assert.equal(dataRootStamp(源), 源指纹)
  assert.equal(existsSync(join(源, 'scope.json')), true)

  // 不留临时文件
  assert.equal(readdirSync(目标).some((n) => n.endsWith('.copying')), false)
  assert.equal(readdirSync(join(目标, 'ws-abc')).some((n) => n.endsWith('.copying')), false)
})

test('copyDataRoot refuses a non-empty target instead of overwriting', t => {
  const 家 = 临时目录()
  t.after(() => rmSync(家, { recursive: true, force: true }))
  const 源 = join(家, 'src')
  const 目标 = join(家, 'dst')
  mkdirSync(源, { recursive: true })
  造数据根(源)
  mkdirSync(目标, { recursive: true })
  writeFileSync(join(目标, 'scope.json'), '{"mine":true}', 'utf8')

  const 结果 = copyDataRoot({ from: 源, to: 目标 })
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'target-not-empty')
  assert.equal(readFileSync(join(目标, 'scope.json'), 'utf8'), '{"mine":true}', 'existing file untouched')
  assert.deepEqual(结果.copied, [])
})

test('dry run reports the plan without writing anything', t => {
  const 家 = 临时目录()
  t.after(() => rmSync(家, { recursive: true, force: true }))
  const 源 = join(家, 'src')
  const 目标 = join(家, 'dst')
  mkdirSync(源, { recursive: true })
  造数据根(源)

  const 结果 = copyDataRoot({ from: 源, to: 目标, dryRun: true })
  assert.equal(结果.ok, true)
  assert.equal(结果.dryRun, true)
  assert.equal(existsSync(目标), false, 'dry run must not create the target')
  assert.ok(结果.files >= 3)
})

test('a live store is snapshotted through SQLite instead of a raw file copy', t => {
  const 家 = 临时目录()
  const 源 = join(家, 'src')
  const 目标 = join(家, 'dst')
  mkdirSync(join(源, 'ws-abc'), { recursive: true })
  const 库 = join(源, 'ws-abc', 'memory-ws-abc.sqlite3')
  const store = new MemoryStore(库)
  // ⚠️ Windows 上库句柄没关就删不掉目录，所以清理钩子必须先关再删
  t.after(() => { try { store.close() } catch { /* 已关 */ } rmSync(家, { recursive: true, force: true }) })
  store.capture({ session: 's@1000', eventKey: '1', role: 'user', content: '在线备份要拿到这条', sourceTime: 1000 })
  writeFileSync(join(源, 'scope.json'), JSON.stringify({ version: 1, mode: 'workspace', workspaceId: 'abc' }), 'utf8')

  const 结果 = copyDataRoot({ from: 源, to: 目标, store })
  assert.equal(结果.ok, true, JSON.stringify(结果.warnings))
  const 主库条目 = 结果.copied.find((x) => x.file.endsWith('.sqlite3'))
  assert.ok(主库条目, '主库必须在复制清单里')
  assert.equal(主库条目.mode, 'sqlite-backup', '有活句柄时要走 SQLite 在线备份')

  const 副本 = new MemoryStore(join(目标, 'ws-abc', 'memory-ws-abc.sqlite3'))
  assert.equal(副本.stats().messages, 1)
  assert.equal(副本.integrityCheck().ok, true)
  副本.close()
})
