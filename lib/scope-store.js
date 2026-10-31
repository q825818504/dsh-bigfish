/**
 * 伙伴范围 —— 唯一真源
 * ============================================================================
 * 记忆和心情都必须指向同一个范围。以前是两套配置各存一份（记忆在 cordis
 * Config，心情在 config.json），改一处另一处不动，迟早对不上。
 *
 * 现在范围只存在这里：
 *
 *     <数据根目录>/scope.json
 *     {
 *       "version": 1,
 *       "mode": "workspace" | "session",
 *       "workspaceId": "<工作区 UUID>",
 *       "sessionIds": ["<会话 id>", ...],
 *       "updatedAt": 1793...
 *     }
 *
 * 「设置」板块只写这个文件；记忆和心情在启动时读它，读不到才回退到各自
 * 原有的配置（兼容老部署）。
 *
 * 这是「拉」模式：设置保存 = 写一个文件，瞬时完成，不会触发记忆侧的
 * 热切换数据库与回灌。代价是改完要重启 DSH 才生效 —— 这是刻意的取舍。
 * ============================================================================
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** scope.json 的路径 */
export function scopeStorePath(root) {
  return root ? join(root, 'scope.json') : ''
}

/** 读范围配置；没有或损坏时返回 null（调用方回退到自己的配置） */
export function readScope(root) {
  if (!root) return null
  const p = scopeStorePath(root)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const mode = raw.mode === 'workspace' || raw.mode === 'session' ? raw.mode : ''
    if (!mode) return null
    const sessionIds = Array.isArray(raw.sessionIds)
      ? raw.sessionIds.map((x) => String(x || '').trim()).filter(Boolean)
      : []
    return {
      mode,
      workspaceId: String(raw.workspaceId || '').trim(),
      sessionIds: [...new Set(sessionIds)],
      updatedAt: Number(raw.updatedAt) || 0,
    }
  } catch {
    return null
  }
}

/** 写范围配置（覆盖式）。返回落盘的规范化内容。 */
export function writeScope(root, scope) {
  if (!root) throw new Error('scope root is required')
  const mode = scope && (scope.mode === 'workspace' || scope.mode === 'session') ? scope.mode : ''
  if (!mode) throw new Error('scope mode must be workspace or session')
  const workspaceId = String((scope && scope.workspaceId) || '').trim()
  const sessionIds = Array.isArray(scope && scope.sessionIds)
    ? [...new Set(scope.sessionIds.map((x) => String(x || '').trim()).filter(Boolean))]
    : []
  if (mode === 'workspace' && !workspaceId) throw new Error('workspace mode needs a workspaceId')
  if (mode === 'session' && !sessionIds.length) throw new Error('session mode needs at least one sessionId')

  mkdirSync(root, { recursive: true })
  const body = { version: 1, mode, workspaceId, sessionIds, updatedAt: Date.now() }
  // 原子写：这个文件是唯一真源，写一半断电会让三方一起退回各自的旧配置，
  // 现象是「记忆突然少了一半」—— 查起来极难，所以必须 tmp + rename。
  const target = scopeStorePath(root)
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8')
  renameSync(tmp, target)
  return body
}

/** 把范围覆盖到一份配置值上（记忆侧用） */
export function applyScopeToValue(value, scope) {
  if (!scope) return value
  return {
    ...value,
    bindingMode: scope.mode,
    bindingWorkspaceId: scope.workspaceId || '',
    bindingSessionIds: scope.sessionIds.length ? scope.sessionIds : undefined,
  }
}

/* ── 数据根目录 ─────────────────────────────────────────────────────────────
 * scope.json 自己就住在数据根目录里，所以「根目录在哪」不能存在 scope.json 里。
 * 单独放一个固定位置的文件：
 *
 *     <DSH_HOME>/bigfish/root.json
 *     { "dataRoot": "D:\大肥鱼\数据" }
 *
 * 记忆和心情都读它；设置板块写它。没这个文件时各自回退到默认值。
 * ------------------------------------------------------------------------- */

import { homedir as _homedir } from 'node:os'

/**
 * ⚠ 必须每次调用现算，不能在模块加载时缓存 —— 测试会改 DSH_HOME。
 */
function _dshHome() {
  return process.env.DSH_HOME || join(_homedir(), '.dsh')
}

export function dataRootStorePath() {
  return join(_dshHome(), 'bigfish', 'root.json')
}

/**
 * DSH 内置的默认数据根 —— **三方唯一真源**。
 *
 * 以前记忆（profile 的 scopeDirectory）、心情、灵魂各算各的默认值，三者不同：
 *   记忆 → D:\大肥鱼\数据（profile 里写的）
 *   心情 → <DSH_HOME>/bigfish/scopes
 *   灵魂 → <DSH_HOME>/bigfish/scopes
 * root.json 一旦为空，记忆写一边、心情写另一边，同一次对话的记忆和心情就分居了。
 *
 * 现在统一走这里：root.json 有值就用它，没有就都用这个。
 * profile 的 scopeDirectory 只在**首次**建 root.json 时作为种子（见 seedDataRootFromProfile）。
 */
export function defaultDataRoot() {
  return join(_dshHome(), 'bigfish', 'scopes')
}

/** 读自定义数据根目录；没有返回空串 */
export function readDataRoot() {
  try {
    const raw = JSON.parse(readFileSync(dataRootStorePath(), 'utf8'))
    return String((raw && raw.dataRoot) || '').trim()
  } catch {
    return ''
  }
}

/**
 * 最终生效的数据根：自定义优先，否则默认。
 * @param {string} [fallback] 给了就用它当默认（记忆侧传 profile 的 scopeDirectory）
 */
export function resolveDataRoot(fallback) {
  const custom = readDataRoot()
  if (custom) return custom
  const fb = String(fallback || '').trim()
  return fb || defaultDataRoot()
}

/** 原子写：先写 .tmp 再 rename，写一半断电不会留下半个文件 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/** 写自定义数据根目录；传空串表示恢复默认（文件里留空串） */
export function writeDataRoot(dataRoot) {
  const p = dataRootStorePath()
  const v = String(dataRoot || '').trim()
  if (!v) {
    try { writeJsonAtomic(p, { dataRoot: '' }) } catch {}
    return ''
  }
  writeJsonAtomic(p, { dataRoot: v })
  return v
}

/**
 * 首次迁移：root.json 还不存在、而 profile 里写了一个自定义 scopeDirectory 时，
 * 把它落成 root.json，让心情和灵魂也用同一个根。
 *
 * 只在 root.json **不存在**时动手 —— 用户点了「恢复默认」（文件里写成空串）
 * 之后绝不能又被 profile 拉回去。
 *
 * @returns {string} 落盘的值（没动就返回空串）
 */
export function seedDataRootFromProfile(profileScopeDirectory) {
  const v = String(profileScopeDirectory || '').trim()
  if (!v) return ''
  if (existsSync(dataRootStorePath())) return ''
  try {
    writeJsonAtomic(dataRootStorePath(), { dataRoot: v })
    return v
  } catch {
    return ''
  }
}
