/**
 * 心情 · 状态持久化
 * ============================================================================
 * ⚠ 这是从 lib/mood/index.js（2047 行单文件）里**原样切出来的一段**，不是重写。
 *   切它的目的是让路径、配置目录、状态读写这三件"存储层"的事能单独读、单独测。
 *
 * 设计要点（都是原来就有的约定，别在这里改）：
 *   1. **每个范围一个状态文件**：<数据根>/<ws-xxx|ss-xxx>/mood-<短标识>.json
 *      按「约定」导出，append/再导出后调用方拿到的是活绑定。
 *   2. **配置目录固定在 <DSH_HOME>/bigfish-mood/**，不跟数据根走 ——
 *      它装的是"怎么判断心情"的参数，跟某一份心情数据无关。
 *   3. 路径一律函数现算，不在模块加载时缓存：测试会改 DSH_HOME。
 * ============================================================================
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { scopeFilePath } from '../scope-key.js'
import { resolveDataRoot } from '../scope-store.js'

// ─────────────────────────────────────────────────────────────────────────────
export const STORE_NAME = 'bigfish-mood'

/** DSH 主目录（每次现算，测试会改 DSH_HOME） */
function cfgDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
function storeDir() {
  return join(cfgDir(), STORE_NAME)
}
function configPath() {
  return join(storeDir(), 'config.json')
}
function diagPath() {
  return join(storeDir(), 'diag.log')
}

/** 状态写入上限：timeline 全量落盘，但有条数上限（记忆星图依赖它） */
const TIMELINE_MAX = Math.max(100, Number(process.env.DSH_BIGFISH_MOOD_TIMELINE_MAX) || 2000)
/** /state 接口默认只返回最近 N 条 */
const STATE_TIMELINE_LIMIT = Math.max(10, Number(process.env.DSH_BIGFISH_MOOD_STATE_TIMELINE) || 200)

const STATE_VERSION = 2

let 当前范围键 = ''
let 数据根目录 = resolveDataRoot()

/** 当前范围键（只读） */
function currentKey() {
  return 当前范围键
}

/**
 * 由 loadConfig() / __测试 推过来：设定当前范围。
 * 空串 = 范围未定 —— 此时 statePath() 返回空串，读写都会被跳过，
 * **绝不回退到上一份的路径**。
 */
function setStateScope(key, root) {
  当前范围键 = String(key || '')
  if (root) 数据根目录 = String(root)
}

/** 当前范围的心情文件路径（空串 = 范围未定，调用方应跳过读写） */
function statePath() {
  return 当前范围键 ? scopeFilePath(数据根目录, 当前范围键, 'mood') : ''
}

/** 当前数据根（诊断/面板用） */
function dataRootNow() {
  return 数据根目录
}

/** 诊断日志（覆盖式写入，只留最后一次，避免无限增长） */
function diag(msg) {
  try {
    mkdirSync(storeDir(), { recursive: true })
    writeFileSync(diagPath(), new Date().toISOString() + '  ' + msg + '\n', { flag: 'a' })
  } catch { /* 诊断失败不影响主流程 */ }
}

/* ── 状态文件读写 ────────────────────────────────────────────────────────── */

function readStore() {
  const p = statePath()
  if (!p) return { version: STATE_VERSION, moods: {}, lastActive: '' }
  const 空 = { version: STATE_VERSION, moods: {}, lastActive: '' }
  if (!existsSync(p)) return 空
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    if (!raw || typeof raw !== 'object') return 空
    const moods = raw.moods && typeof raw.moods === 'object' ? raw.moods : {}
    return { version: STATE_VERSION, moods, lastActive: String(raw.lastActive || '') }
  } catch (e) {
    diag('读状态失败：' + (e && e.message))
    return 空
  }
}

function writeStore(store) {
  const p = statePath()
  if (!p) return false
  try {
    mkdirSync(dirname(p), { recursive: true })
    const tmp = p + '.tmp'
    writeFileSync(tmp, JSON.stringify({
      version: STATE_VERSION,
      moods: store.moods,
      lastActive: store.lastActive || '',
    }, null, 2), 'utf8')
    renameSync(tmp, p)
    return true
  } catch (e) {
    diag('写状态失败：' + (e && e.message))
    return false
  }
}

export {
  STATE_VERSION,
  TIMELINE_MAX,
  STATE_TIMELINE_LIMIT,
  cfgDir,
  storeDir,
  configPath,
  diagPath,
  diag,
  statePath,
  currentKey,
  setStateScope,
  dataRootNow,
  readStore,
  writeStore,
}
