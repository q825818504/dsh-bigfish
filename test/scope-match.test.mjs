/**
 * 心情与记忆的范围一致性（2.3.3 回归）
 *
 * ⚠ 为什么单独一个文件：mood/index.js 有模块级状态（数据根在 import 时求值、
 *   工作区清单有 5 秒缓存）。和几十条其它用例挤在同一个进程里跑，
 *   结果会依赖执行顺序 —— 那正是"测了等于没测"。独立进程才测得准。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'bigfish-scope-match-'))
process.env.DSH_HOME = home

const 工作区Uuid = '83ba9d80-ec53-4a24-9245-7ce877a74e70'
const 目录名 = '--D-~5927~80A5~9C7C--'

// 造环境：心情的 工作区清单() 是扫 <DSH_HOME>/sessions/<目录名>/<会话> 得到的
mkdirSync(join(home, 'sessions', 目录名, 'session-probe'), { recursive: true })
mkdirSync(join(home, 'storages'), { recursive: true })
writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
  tables: { workspaces: { [工作区Uuid]: { path: 'D:\\大肥鱼' } } },
}), 'utf8')
mkdirSync(join(home, 'bigfish-mood'), { recursive: true })
writeFileSync(join(home, 'bigfish-mood', 'config.json'), JSON.stringify({ 模式: 'workspace', slots: [] }), 'utf8')
mkdirSync(join(home, 'bigfish', 'scopes'), { recursive: true })
writeFileSync(join(home, 'bigfish', 'scopes', 'scope.json'), JSON.stringify({
  version: 1, mode: 'workspace', workspaceId: 工作区Uuid, sessionIds: [],
}), 'utf8')

const mood = await import(pathToFileURL(join(process.cwd(), 'lib', 'mood', 'index.js')).href)
const h = mood.__测试

test.after(() => rmSync(home, { recursive: true, force: true }))

test('心情与记忆使用同一个范围键，绝不后退到 __default__ 或原始份 id', () => {
  h.读配置()
  const 记忆那边的键 = 'ws-' + 工作区Uuid
  const 心情这边的键 = h.当前范围().key

  assert.equal(心情这边的键, 记忆那边的键, '心情必须和记忆用同一个范围键')
  assert.notEqual(心情这边的键, '__default__', '不能兜底到 __default__')
  assert.ok(!/^[a-z]$/.test(心情这边的键), '不能沿用老配置里的原始份 id')
  assert.ok(
    h.库路径().includes('ws-' + 工作区Uuid),
    '状态文件必须落在同一个范围目录：' + h.库路径(),
  )
})

test('session 模式下同样对齐：ss-<首个会话>', () => {
  writeFileSync(join(home, 'bigfish', 'scopes', 'scope.json'), JSON.stringify({
    version: 1, mode: 'session', workspaceId: '', sessionIds: ['session-zzz'],
  }), 'utf8')
  h.读配置()
  assert.equal(h.当前范围().key, 'ss-session-zzz', '会话模式的范围键必须是 ss-<会话>')
})
