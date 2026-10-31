/**
 * 三边同源：记忆、心情、灵魂必须落在同一个数据根下（2.3.4 回归）
 *
 * ⚠ 单独一个文件、独立进程：mood/index.js 有模块级缓存（工作区清单 5 秒缓存、
 *   数据根曾经在 import 时求值）。和别的用例挤在一个进程里，测出来的东西
 *   取决于执行顺序 —— 那等于没测。
 *
 * 用户的原话：「我肯定要把所有数据保存在一个目录下呀，好管理」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'bigfish-sameness-'))
process.env.DSH_HOME = home

const 工作区Uuid = '83ba9d80-ec53-4a24-9245-7ce877a74e70'
const 目录名 = '--D-~5927~80A5~9C7C--'

mkdirSync(join(home, 'sessions', 目录名, 'session-probe'), { recursive: true })
mkdirSync(join(home, 'storages'), { recursive: true })
writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
  tables: { workspaces: { [工作区Uuid]: { path: 'D:\\大肥鱼' } } },
}), 'utf8')
mkdirSync(join(home, 'bigfish-mood'), { recursive: true })
writeFileSync(join(home, 'bigfish-mood', 'config.json'), JSON.stringify({ 模式: 'workspace', slots: [] }), 'utf8')

const mood = await import(pathToFileURL(join(process.cwd(), 'lib', 'mood', 'index.js')).href)
const memory = await import(pathToFileURL(join(process.cwd(), 'lib', 'memory', 'index.js')).href)
const ss = await import(pathToFileURL(join(process.cwd(), 'lib', 'scope-store.js')).href)
const h = mood.__测试

test.after(() => rmSync(home, { recursive: true, force: true }))

test('memory resolves its data root from root.json, ignoring profile scopeDirectory', () => {
  const 用户选的 = join(home, '用户选的')
  ss.writeDataRoot(用户选的)
  try {
    const 库 = memory.scopeDatabasePath({
      database: join(home, 'profile写的', 'memory.sqlite3'),
      scopeDirectory: join(home, 'profile写的'),   // ← profile 里那个旧值，必须被忽略
      bank: 'dafeiyu',
      bindingMode: 'workspace',
      bindingWorkspaceId: 工作区Uuid,
      bindingSessionIds: [],
    })
    assert.ok(库.startsWith(用户选的), '记忆库必须在用户选的目录下：' + 库)
    assert.ok(!库.includes('profile写的'), 'profile 的 scopeDirectory 不能参与解析：' + 库)
  } finally {
    ss.writeDataRoot('')
  }
})

test('memory and mood agree on the very same scope directory', () => {
  const 根 = join(home, '统一目录')
  mkdirSync(根, { recursive: true })
  ss.writeDataRoot(根)
  writeFileSync(join(根, 'scope.json'), JSON.stringify({
    version: 1, mode: 'workspace', workspaceId: 工作区Uuid, sessionIds: [],
  }), 'utf8')
  try {
    const 记忆库 = memory.scopeDatabasePath({
      database: join(home, '旧', 'memory.sqlite3'),
      scopeDirectory: join(home, '旧的profile值'),
      bank: 'dafeiyu',
      bindingMode: 'workspace',
      bindingWorkspaceId: 工作区Uuid,
      bindingSessionIds: [],
    })
    h.读配置()
    const 心情文件 = h.库路径()

    assert.equal(
      dirname(dirname(记忆库)).toLowerCase(),
      dirname(dirname(心情文件)).toLowerCase(),
      '数据根必须相同\n记忆：' + 记忆库 + '\n心情：' + 心情文件,
    )
    assert.equal(
      dirname(记忆库).toLowerCase(),
      dirname(心情文件).toLowerCase(),
      '连范围目录也必须相同',
    )
  } finally {
    ss.writeDataRoot('')
  }
})
