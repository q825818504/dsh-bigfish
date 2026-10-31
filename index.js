/**
 * dsh-bigfish —— Host 侧合并入口
 * ============================================================================
 * 把「记忆」与「心情」两个原本独立的插件收进同一个包。
 *
 * 设计原则：
 *   1. **不改两边的内部实现**。lib/memory/ 与 lib/mood/ 是原封搬过来的代码，
 *      只修了搬迁导致的相对路径（`./lib/x.js` → `./x.js`）。业务逻辑一行没动。
 *   2. **本文件只做装配**。合并 inject、按顺序调用两个 apply、导出合并后的 Config。
 *   3. **两套存储各归各**。记忆用 SQLite（每工作区一库），心情用 state.json，
 *      互不干扰，零迁移。合并的是"外壳"，不是"数据"。
 *
 * ⚠️ 装配顺序有意义：记忆先于心情启动。
 *    记忆的 apply 会建库、绑定范围；心情的 apply 会起 3 秒 tick 与 turn-stopping 监听。
 *    心情的判断依赖 agent/session 已就绪，放在后面更稳。
 * ============================================================================
 */

import {
  apply as applyMemory,
  Config as MemoryConfig,
  inject as memoryInject,
  name as memoryName,
} from './lib/memory/index.js'

import {
  apply as applyMood,
  inject as moodInject,
  name as moodName,
} from './lib/mood/index.js'

/** 合并后的插件名（cordis 里用它标识这一条） */
export const name = 'bigfish'

/**
 * 合并 inject。两边的依赖取并集：
 *   记忆：sessions, sessionQuery, agents, systemPrompt, tools, connection, workspaceRegistry, settings
 *   心情：systemPrompt, agents, webServer, llm, timer
 */
export const inject = [...new Set([...memoryInject, ...moodInject])]

/**
 * 对外配置仍沿用记忆插件那套（bank / bindingMode / recallChars / ...）。
 * 心情的配置在 `<DSH_HOME>/bigfish-mood/config.json`，不走这里。
 *
 * 待办：后续可把心情配置也收进 Config，让面板与配置一处管理。
 */
export const Config = MemoryConfig

/**
 * 装配两个模块。
 *
 * @param {object} ctx   cordis 上下文
 * @param {object} config  记忆模块的配置（bank / bindingMode / ...）
 */
export function apply(ctx, config) {
  applyMemory(ctx, config)
  applyMood(ctx)
}

/** 供测试与诊断使用：两个子模块的标识 */
export const parts = { memory: memoryName, mood: moodName }
