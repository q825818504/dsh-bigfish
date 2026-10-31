/**
 * 灵魂 · Host 侧
 * ============================================================================
 * 大肥鱼的第三块：我是谁。
 *
 * 记忆说「发生过什么」，心情说「此刻怎样」，灵魂说「我是谁」。
 *
 * 本模块干四件事：
 *   1. 按范围读写灵魂文件（见 ./store.js 与 lib/scope-key.js 的 'soul' 档）
 *   2. 往 systemPrompt 里注入人格段（order 860：记忆 850 之后、心情 900 之前）
 *   3. 注册只读工具 soul_read
 *   4. 给面板提供 GET/POST /dsh-bigfish/soul
 *
 * ⚠ 三条硬约束（详见 .planning/task-soul.md）：
 *   · **注入顺序不能动**。人格先立住「我是谁」，记忆再补「发生过什么」，
 *     最后心情说「此刻怎样」。情绪绝不能压过身份 —— 参考项目里有反例：
 *     用一条强制身份反过来压住一切，人格就成了空壳。
 *   · **interpolate 必须 false**。人设文本里出现 {x} 时会被当模板解析，
 *     内容会悄悄消失且不报错。
 *   · **V1 不给模型写入口**。只注册 soul_read，不注册 soul_update。
 *     整卡重写会让模型每轮「顺手重写一遍」，人格在无人察觉时漂移，
 *     且没有版本、没有证据、不能回退。写入口留到第二阶段做增量提案。
 * ============================================================================
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scopeKey, scopeFilePath } from '../scope-key.js'
import { readScope, resolveDataRoot } from '../scope-store.js'
import {
  DEFAULT_ADDRESS,
  TRAIT_DOC,
  defaultSoul,
  readSoul,
  traitSentence,
  writeSoul,
} from './store.js'

export const name = 'bigfish-soul'

/**
 * 只需 systemPrompt 做注入、tools 做只读工具、webServer 做面板路由。
 * 不新增任何依赖：范围读取走本地文件，不碰 agents/sessions 服务。
 */
export const inject = ['systemPrompt', 'tools', 'webServer']

/** 注入顺序：记忆 850 < 灵魂 860 < 心情 900 */
const SECTION_ORDER = 860
const SECTION_NAME = 'bigfish:soul'

/** 注入上限。人格摘要必须短 —— 每轮都进上下文，长了就变成背景音把人焊死。 */
const INJECT_MAX_CHARS = 1200

/**
 * 仅供测试：清空诊断日志路径缓存。
 * （旧版本这里复位「路由注册标记」，2.3.0 起路由交给 ctx.effect 管理，标记已删除；
 *   保留这个导出名是为了老测试不用改。）
 */
export function __resetRoutesForTest() {
  diagPath = ''
}

/** 面板写入上限，人格不是聊天记录 */
const BODY_LIMIT = 64 * 1024

/**
 * ⭐ 2.3.0：改成函数现算，不在模块加载时缓存。
 *   模块级求值有两个问题：
 *     1. 测试里改 DSH_HOME 不生效（每个用例得单独起进程才行）
 *     2. 数据根以前各算各的，和记忆、心情对不上
 *   现在统一走 scope-store 的 resolveDataRoot()。
 */
function cfgDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
const ROUTE_PREFIX = '/dsh-bigfish'

/** 诊断日志（与心情的 diag.log 同一思路，但写自己的一份，免得互相覆盖） */
let diagPath = ''
function diag(msg) {
  if (!diagPath) diagPath = join(cfgDir(), 'bigfish', 'soul-diag.log')
  try {
    mkdirSync(dirname(diagPath), { recursive: true })
    appendFileSync(diagPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

/** 当前数据根目录。⭐ 2.3.0：和记忆、心情走同一个真源，不再自己算默认值 */
function dataRoot() {
  try {
    return resolveDataRoot()
  } catch {
    return cfgDir()
  }
}

/**
 * 从 workspace.json 反查工作区 UUID。
 * 与心情模块的口径一致（`工作区UUID()`），保证两边算出同一个键。
 */
function workspaceUuidOf(dirPath) {
  const target = String(dirPath || '').trim()
  if (!target) return ''
  try {
    const w = JSON.parse(readFileSync(join(cfgDir(), 'storages', 'workspace.json'), 'utf8'))
    const table = (w && w.tables && w.tables.workspaces) || {}
    const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
    for (const [uuid, v] of Object.entries(table)) {
      if (norm(v && v.path) === norm(target)) return String(uuid || '')
    }
  } catch {
    /* 读不到就当没有 */
  }
  return ''
}

/**
 * 当前范围键。灵魂与记忆、心情必须指向**同一个**范围。
 *
 * 解析顺序：
 *   1. `scope.json` —— 唯一真源，在「设置」里保存过的范围
 *   2. **推导兜底**：scope.json 还没写过时，从 `scopes/` 下已经存在的目录反推
 *      （记忆/心情已经在用的那个），保证三边指向同一处
 *   3. 都没有 → 空串，此时不注入、不读写，绝不回退到别人的文件
 *
 * 为什么要有第 2 步：心跳和记忆用的是各自的配置（心情 config.json 里有工作区 id），
 * 它们没等用户去「设置」就先落盘了。灵魂如果死等 scope.json，
 * 用户会看到一个「请先去设置」的死胡同 —— 而实际上数据目录早就存在了。
 */
function currentScopeKey() {
  try {
    const root = dataRoot()
    const scope = readScope(root)
    if (scope) {
      const key = scopeKey({ mode: scope.mode, workspaceId: scope.workspaceId, sessionIds: scope.sessionIds })
      if (key) return key
    }
    return inferScopeKey(root)
  } catch {
    return ''
  }
}

/**
 * scope.json 不存在时的兜底：看 scopes/ 下已经有哪些范围目录。
 * 只有一个 → 直接用它（绝大多数情况）。
 * 有多个 → 优先取带 soul 文件的，其次取带 mood 文件的，再不行取最新的。
 * 这样不会凭空造一个新的空范围出来。
 */
function inferScopeKey(root) {
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (d.name.startsWith('ws-') || d.name.startsWith('ss-')))
      .map((d) => d.name)
    if (!entries.length) return ''
    if (entries.length === 1) return entries[0]

    const scored = entries.map((name) => {
      const dir = join(root, name)
      let score = 0
      let mtime = 0
      try {
        const files = readdirSync(dir)
        if (files.some((f) => f.startsWith('soul-'))) score += 2
        if (files.some((f) => f.startsWith('mood-'))) score += 1
        for (const f of files) {
          try { mtime = Math.max(mtime, statSync(join(dir, f)).mtimeMs) } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      return { name, score, mtime }
    })
    scored.sort((a, b) => (b.score - a.score) || (b.mtime - a.mtime))
    return scored[0].name
  } catch {
    return ''
  }
}

/** 当前范围的 soul 文件路径（空串 = 范围未定） */
function currentSoulFile() {
  const key = currentScopeKey()
  if (!key) return ''
  try {
    return scopeFilePath(dataRoot(), key, 'soul')
  } catch {
    return ''
  }
}

/**
 * 注入预算 —— 按段分配，**不再整段截断**。
 *
 * 以前是 `text.slice(0, INJECT_MAX_CHARS)`：whoIAm 一写长，
 * 「你珍视」「你平时」「你自己知道的事」会**整段消失**且不报错，
 * 用户只会觉得"我写的东西她怎么不知道"。
 *
 * 现在每段有自己的上限：超了只折这一段的尾部，其余段照常进来。
 * 总和仍受 INJECT_MAX_CHARS 约束 —— 人格是背景，不是正文。
 */
const SEG_BUDGET = {
  who: 520,      // 我是谁：最该稳住，给最多
  address: 40,   // 称呼：一句话
  values: 260,   // 你珍视
  traits: 200,   // 你平时
  notes: 240,    // 你自己知道的事
}

/** 折一段文本：超长就在最近的句读处收尾，并标出省略 */
function clipSegment(text, max) {
  const s = String(text || '')
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  // 尽量在句号/换行/逗号处断开，别把词砍成半截
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'))
  const head = at > max * 0.5 ? cut.slice(0, at + 1) : cut
  return head + '……'
}

/** 把灵魂渲染成注入文本。任何异常都返回 ''，绝不打断对话。 */
function renderSoulOf(soul) {
  if (!soul) return ''
  const parts = []
  const { identity } = soul

  // 身份段
  const who = String(identity.whoIAm || '').trim()
  if (who) parts.push(clipSegment(who, SEG_BUDGET.who))

  // 称呼：单独一句，因为这是最容易被历史和记忆冲掉的东西
  const address = String(identity.address || DEFAULT_ADDRESS).trim()
  if (address) parts.push(clipSegment(`称呼对方「${address}」。`, SEG_BUDGET.address))

  // 价值段：只注入条目本身，不加序号
  if (Array.isArray(soul.values) && soul.values.length) {
    parts.push(clipSegment('你珍视：\n' + soul.values.map((v) => `- ${v.text}`).join('\n'), SEG_BUDGET.values))
  }

  // 倾向段：**绝不输出数字**。数字没有语义，模型会自行脑补。
  const traitLines = Object.keys(TRAIT_DOC)
    .map((k) => traitSentence(k, soul.traits[k]))
    .filter(Boolean)
  if (traitLines.length) {
    parts.push(clipSegment('你平时：\n' + traitLines.map((s) => `- ${s}`).join('\n'), SEG_BUDGET.traits))
  }

  // 自我认识段
  if (Array.isArray(soul.selfNotes) && soul.selfNotes.length) {
    parts.push(clipSegment('你自己知道的事：\n' + soul.selfNotes.map((n) => `- ${n}`).join('\n'), SEG_BUDGET.notes))
  }

  if (!parts.length) return ''
  const text = parts.join('\n\n')
  // 兜底：各段都贴着上限时总和仍可能超出，最后再折一次整体
  return text.length > INJECT_MAX_CHARS ? clipSegment(text, INJECT_MAX_CHARS) : text
}

/**
 * 读一次就用一次 —— 返回 { file, exists, soul, text }。
 * ⭐ 2.3.0：以前 soul_read 里先 readSoul() 查 exists，再 renderSoul()，
 *   而 renderSoul 内部又 readSoul() 一遍：一次工具调用读两遍磁盘、解析两遍 JSON。
 */
function loadSoulOnce() {
  const file = currentSoulFile()
  if (!file) return { file: '', exists: false, soul: null, text: '' }
  const { soul, exists } = readSoul(file)
  // 文件不存在 == 用户还没写人格。此时不注入空段，也不注入默认值，
  // 免得「没设过」和「设了但就是这样」在对话里无法区分。
  return { file, exists, soul, text: exists ? renderSoulOf(soul) : '' }
}

/** 跨源判定（CSRF 面），与心情的 isCrossOrigin 同口径 */
function isCrossOrigin(headers, host) {
  const site = headers && headers['sec-fetch-site']
  if (site !== undefined) return site !== 'same-origin' && site !== 'none'
  const origin = headers && headers['origin']
  if (origin !== undefined) {
    try {
      return new URL(origin).host !== host
    } catch {
      return true
    }
  }
  return false
}

async function readBody(req, limit = BODY_LIMIT) {
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (data.length > limit) return null
  }
  return data
}

export function apply(ctx) {
  diagPath = join(cfgDir(), 'bigfish', 'soul-diag.log')
  diag('apply() 开始')

  // ── 1) 注入 ────────────────────────────────────────────────────────────
  try {
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      // 必须 false：人设里的花括号要原样保留
      interpolate: false,
      // 函数式 text：每次装配现算，面板改完下一轮就生效，不用重启
      text: () => {
        try {
          // 一次读盘、一次渲染（以前这里和 soul_read 各读一遍）
          return loadSoulOnce().text
        } catch (e) {
          diag('渲染灵魂失败：' + (e && e.message))
          return ''
        }
      },
    })
  } catch (e) {
    diag('注册注入失败：' + (e && e.message))
  }

  // ── 2) 只读工具 ────────────────────────────────────────────────────────
  try {
    ctx.tools.register(defineTool({
      name: 'soul_read',
      description:
        '读取你当前生效的人格设定（你是谁、珍视什么、平时怎样、自己知道什么）。'
        + '当你需要确认自己的定位、边界或口吻时使用。这是只读的 —— 人格由用户维护，你不能自行改写。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            exists: { type: 'boolean' },
            text: { type: 'string' },
          },
        },
        render(_args, value) {
          return [{
            type: 'text',
            text: value.exists ? `当前人格：\n${value.text}` : '当前范围还没有设置人格。',
          }]
        },
      },
      isConcurrencySafe: () => true,
      async execute() {
        // 一次读盘搞定：以前是 readSoul 查 exists、renderSoul 再 readSoul 一遍
        const { exists, text } = loadSoulOnce()
        return { exists: exists && text !== '', text }
      },
    }))
  } catch (e) {
    diag('注册 soul_read 失败：' + (e && e.message))
  }

  // ── 3) 面板路由 ────────────────────────────────────────────────────────
  // ⚠ 三条硬规矩（前两条是 2026-10-31 实机踩出来的）：
  //   1. **一个 path 只能 register 一次**。webServer 按 path 做唯一性检查，
  //      不区分 method；把 GET 和 POST 注册成两条会直接崩
  //      "duplicate exact route"。所以只注册一条，在 handler 里按 req.method 分发。
  //   2. effect 回调必须返回**清理函数**，不能返回数组 —— 否则重新装载时
  //      旧路由不会被卸载。
  //   3. 幂等靠 ctx.effect 自身的生命周期，**不再用模块级布尔标记**。
  //      以前的写法有隐患：标记在 effect 回调里置 true，重复 apply 时提前 return，
  //      而第一次的清理函数又会把它置回 false —— 是否注册完全取决于加载顺序。
  //      现在由 ctx 负责 dispose，重复 apply 时 cordis 会先清掉上一个 effect。
  // ⚠ 但 webServer 对同一 path 二次 register 会抛 duplicate。所以这里用
  //   try/catch 兜住：真抛了就记日志，不把整个模块带崩。
  try {
    ctx.effect(() => {
      const dispose = ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + '/soul',
        handler: async (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(body))
          }

          // ── GET：读当前范围 ────────────────────────────────────────
          if (req.method === 'GET') {
            try {
              const file = currentSoulFile()
              if (!file) {
                // 范围未定：告诉面板，但不当成错误
                send(200, { ok: true, scopeReady: false, soul: null })
                return
              }
              const { soul, exists, error } = readSoul(file)
              send(200, {
                ok: true,
                scopeReady: true,
                exists,
                error: error || '',
                // 把当前范围写进去：面板/排障时能直接看出这是哪一份灵魂
                soul: { ...soul, scope: currentScopeKey() },
                traitDoc: TRAIT_DOC,
              })
            } catch (e) {
              send(500, { ok: false, error: e && e.message ? e.message : String(e) })
            }
            return
          }

          // ── POST：写当前范围 ───────────────────────────────────────
          if (req.method === 'POST') {
            try {
              if (isCrossOrigin(req.headers, req.headers.host)) {
                send(403, { ok: false, error: 'cross-origin request rejected' })
                return
              }
              const raw = await readBody(req)
              if (raw === null) {
                send(413, { ok: false, error: 'request body too large' })
                return
              }
              let body
              try {
                body = JSON.parse(raw || '{}')
              } catch {
                send(400, { ok: false, error: 'invalid JSON body' })
                return
              }
              const file = currentSoulFile()
              if (!file) {
                send(409, { ok: false, error: '范围未确定，请先在设置里选定范围' })
                return
              }

              /* ⭐ 2.3.0：reset —— 回到出厂设置。
                 以前只能逐条删，想推倒重来没有入口。 */
              if (body && body.reset === true) {
                const fresh = defaultSoul()
                fresh.scope = currentScopeKey()
                const out = writeSoul(file, fresh)
                if (!out.ok) {
                  send(500, { ok: false, error: out.error })
                  return
                }
                send(200, { ok: true, scopeReady: true, exists: true, soul: out.soul, traitDoc: TRAIT_DOC, reset: true })
                return
              }

              // 锁定的价值不许删：面板可能被绕过，服务端再挡一次
              const { soul: prev, exists: prevExists } = readSoul(file)
              const lockedTexts = (prev.values || []).filter((v) => v.locked).map((v) => v.text)
              const incoming = body && body.soul && typeof body.soul === 'object' ? body.soul : null

              /* ⭐ 2.3.0：revision 并发校验。
                 以前写盘只是 revision++，面板也从不下发自己基于哪一版，
                 两个面板同时开着时后保存的会直接盖掉前一个，且悄无声息。
                 现在：请求里带了 baseRevision 且与磁盘不一致 → 409，让用户重新载入。
                 老面板 / 手写请求不带这个字段，行为不变（向后兼容）。 */
              const baseRevision = Number(body && body.baseRevision)
              if (prevExists && Number.isFinite(baseRevision) && baseRevision > 0) {
                const currentRevision = Number(prev.revision) || 1
                if (baseRevision !== currentRevision) {
                  send(409, {
                    ok: false,
                    code: 'revision-conflict',
                    error: `这份人格在别处被改过了（你基于第 ${baseRevision} 版，磁盘是第 ${currentRevision} 版）。重新载入后再改，别把对方的改动盖掉。`,
                    currentRevision,
                    soul: prev,
                    traitDoc: TRAIT_DOC,
                  })
                  return
                }
              }

              if (incoming && Array.isArray(incoming.values)) {
                const remaining = new Set(incoming.values.map((v) => (v && v.text) || ''))
                const missing = lockedTexts.filter((t) => !remaining.has(t))
                if (missing.length) {
                  send(409, {
                    ok: false,
                    error: '这些是锁定的价值，需要先在面板上解锁才能删除',
                    locked: missing,
                  })
                  return
                }
              }

              const merged = { ...(incoming || {}), scope: currentScopeKey() }
              const result = writeSoul(file, merged)
              if (!result.ok) {
                send(500, { ok: false, error: result.error })
                return
              }
              send(200, { ok: true, scopeReady: true, exists: true, soul: result.soul, traitDoc: TRAIT_DOC })
            } catch (e) {
              send(500, { ok: false, error: e && e.message ? e.message : String(e) })
            }
            return
          }

          // ── 其它 method ────────────────────────────────────────────
          res.writeHead(405, { allow: 'GET, POST' })
          res.end()
        },
      })

      return () => {
        try { dispose() } catch { /* 已卸载 */ }
      }
    }, 'bigfish-soul: routes')
  } catch (e) {
    diag('注册路由失败：' + (e && e.message))
  }
}
