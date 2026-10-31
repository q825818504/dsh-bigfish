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

import {
  apply as applySoul,
  inject as soulInject,
  name as soulName,
  getSoulIdentity,
} from './lib/soul/index.js'

/** 合并后的插件名（cordis 里用它标识这一条） */
export const name = 'bigfish'

/**
 * 合并 inject。三边的依赖取并集：
 *   记忆：sessions, sessionQuery, agents, systemPrompt, tools, connection, workspaceRegistry, settings
 *   心情：systemPrompt, agents, webServer, llm, timer
 *   灵魂：systemPrompt, tools, webServer（全被前两者覆盖，并集不变）
 */
export const inject = [...new Set([...memoryInject, ...moodInject, ...soulInject])]

/**
 * 对外配置仍沿用记忆插件那套（bank / bindingMode / recallChars / ...）。
 * 心情的配置在 `<DSH_HOME>/bigfish-mood/config.json`，不走这里。
 *
 * 待办：后续可把心情配置也收进 Config，让面板与配置一处管理。
 */
export const Config = MemoryConfig

/**
 * 装配三个模块：记忆 → 心情 → 灵魂。
 *
 * ⚠ 每个模块单独 try/catch（architecture.md L5）。
 *   合并前它们同生共死：灵魂里任何一处手误抛错，会把记忆和心情一起带崩，
 *   整条 web boot 失败。现在一个模块挂了只丢它自己，其余照常。
 */
export function apply(ctx, config) {
  const failures = []
  const run = (label, fn) => {
    try {
      fn()
    } catch (e) {
      failures.push({ module: label, message: e && e.message ? e.message : String(e) })
      console.error(`[bigfish] ${label} 模块启动失败，其余模块继续：`, e)
    }
  }
  run(memoryName, () => applyMemory(ctx, config))
  /* ⭐ 2.4.0：名字与称呼的唯一真源是灵魂。
     心情判断要把「你是『大肥鱼』，是『爸爸』的伴侣」写进提示词，
     以前它自己存了一份 selfName/ownerName，和灵魂重复 —— 改了一边另一边不生效。
     现在把灵魂的**只读**接口传给它，心情不再自己存这两个字段。 */
  run(moodName, () => applyMood(ctx, { 取身份: getSoulIdentity }))
  run(soulName, () => applySoul(ctx))
  // 有失败也返回：cordis 只关心 apply 有没有抛。详情挂在 ctx 上供诊断读取。
  if (failures.length) {
    try {
      ctx.set?.('bigfish:failures', failures)
    } catch {
      /* 诊断写入失败不影响启动 */
    }
  }
}

/** 供测试与诊断使用：三个子模块的标识 */
export const parts = { memory: memoryName, mood: moodName, soul: soulName }
