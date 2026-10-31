/**
 * 伙伴范围 —— 记忆与心情共用的唯一标识
 * ============================================================================
 * 一个范围 = 一个工作区，或一组会话。记忆库和心情状态都按它分家：
 *
 *     <数据根目录>/
 *     └── ws-<工作区 UUID>/                       ← 目录名就是范围标识
 *          ├── memory-ws-f60efa11.sqlite3         ← 文件名也带范围特征
 *          └── mood-ws-f60efa11.json
 *
 * 为什么用 UUID 而不是工作区目录名：目录名会随工作区重命名变，UUID 不会。
 * 换了名字如果标识跟着变，就等于换了个伙伴，旧数据全部读不到。
 *
 * 为什么记忆和心情各一个文件而不是合成一个库：
 *   1. 心情的 state.json 是**外部可读**的 —— 记忆的 mood-bridge 靠读它给星图上色。
 *      合并进 SQLite 后桥接要开库查询，多一层依赖，对方库被锁时容易出错。
 *   2. 心情每轮判断都要写一次（高频小对象），SQLite 事务比直接落 JSON 重。
 *   3. 「不混」靠目录 + 文件名隔离就够了，不需要合并存储。
 * ============================================================================
 */

import { join } from 'node:path'

/* ⭐ 2.3.0：这里原来导出一个 `DEFAULT_DATA_ROOT_NAME = 'scopes'`，全仓库没人用。
   默认数据根的统一真源现在在 lib/scope-store.js 的 defaultDataRoot()，
   那个常量已删除 —— 留着"看似是配置项其实没人读"的符号，比删掉更伤人。 */

/**
 * 由范围配置算出租范围标识。
 *
 *   workspace 模式 → `ws-<工作区 UUID>`
 *   session   模式 → `ss-<排序后第一个会话 id>`（和记忆分库的种子规则一致）
 *
 * 推不出来（没选工作区 / 没绑会话）返回空串 —— 调用方据此拒绝写入，
 * 绝不回退到「上一份」的路径，免得串到别的范围。
 */
export function scopeKey({ mode, workspaceId, sessionIds } = {}) {
  if (mode === 'workspace') {
    const id = String(workspaceId || '').trim()
    return id ? `ws-${id}` : ''
  }
  if (mode === 'session') {
    const ids = (Array.isArray(sessionIds) ? sessionIds : []).filter(Boolean).sort()
    return ids.length ? `ss-${ids[0]}` : ''
  }
  return ''
}

/** 文件名里用的短标识：只留字母数字下划线横线，取前 16 位 */
export function shortKey(key) {
  return String(key || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16)
}

/**
 * 某个范围的文件路径。
 * @param {string} root 数据根目录
 * @param {string} key  范围标识（scopeKey 的返回值）
 * @param {'memory'|'mood'|'soul'} kind 要哪个文件
 */
export function scopeFilePath(root, key, kind) {
  if (!key) return ''
  const dir = join(root, key)
  const short = shortKey(key)
  if (kind === 'memory') return join(dir, `memory-${short}.sqlite3`)
  if (kind === 'mood') return join(dir, `mood-${short}.json`)
  if (kind === 'soul') return join(dir, `soul-${short}.json`)
  throw new Error('scopeFilePath: kind 只能是 memory、mood 或 soul')
}

/** 某个范围的目录 */
export function scopeDir(root, key) {
  return key ? join(root, key) : ''
}
