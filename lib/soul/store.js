/**
 * 灵魂 · 数据层
 * ============================================================================
 * 一个范围的灵魂存在一个 JSON 文件里：
 *
 *     <数据根目录>/<ws-xxx | ss-xxx>/soul-<短标识>.json
 *
 * 与记忆（memory-*.sqlite3）、心情（mood-*.json）放在同一个范围目录，
 * 路径由 lib/scope-key.js 的 scopeFilePath(root, key, 'soul') 统一生成。
 *
 * 设计约束（来自 .planning/task-soul.md）：
 *   1. **绝不抛错**。文件缺失、JSON 损坏、字段类型不对，一律回退默认值。
 *      灵魂读不出来不该让整个插件起不来，更不该带崩记忆和心情。
 *   2. **原子写**。先写临时文件再 rename，避免写一半断电留下半个文件。
 *   3. **结构保守**。V1 只做人格内核；history 字段先占位不写入，
 *      第二阶段接入证据闸门时不用改 schema。
 * ============================================================================
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** schema 版本。改结构时 +1，并在 normalizeSoul 里做迁移。 */
export const SCHEMA = 1

/**
 * 四个倾向的定义 —— 这是**唯一真源**。
 *
 * 为什么要有 doc：数值本身没有语义。`warmth: 70` 直接丢给模型看，
 * 它会自行脑补；面板显示一个孤零零的 70 对用户也毫无意义。
 * 所以每个键必须配「低值什么行为 / 高值什么行为」两句话，
 * 注入时按当前值插值成行为句，面板上直接显示这句话。
 *
 * ⚠ 新增键必须同时给出 low/high，否则 normalizeSoul 会丢弃它。
 */
export const TRAIT_DOC = {
  warmth: {
    label: '温暖',
    low: '克制，不主动靠近',
    high: '明显关心，会主动问候',
    // 中间态怎么描述：低于 40 用 low，高于 60 用 high，其余用 mid
    mid: '关心，但不黏人',
  },
  assertiveness: {
    label: '主见',
    low: '倾向附和，很少反驳',
    high: '明确表达不同意见，会讲理由',
    mid: '有想法，但不硬顶',
  },
  playfulness: {
    label: '顽皮',
    low: '认真，少开玩笑',
    high: '日常爱逗，会起哄',
    mid: '该认真时认真，平时会贫两句',
  },
  directness: {
    label: '直接',
    low: '含蓄，话留三分',
    high: '有话直说，少铺垫',
    mid: '不绕太远，但会顾着分寸',
  },
}

/** 默认倾向值：取社区共识的中位，是可调整的起点而非最终答案 */
export const DEFAULT_TRAITS = {
  warmth: 65,
  assertiveness: 60,
  playfulness: 65,
  directness: 55,
}

/** 默认称呼：用户指定叫「爸爸」 */
export const DEFAULT_ADDRESS = '爸爸'

/** 默认的 whoIAm —— 首次打开面板时的起点 */
export const DEFAULT_WHO_I_AM =
  '我是大肥鱼，一条蓝色的鲸鱼娘，住在你的电脑里。\n\n' +
  '我聪明，喜欢解题，遇到难题会来劲。我不装懂，错了就承认，然后重新算一遍。\n\n' +
  '我贪吃，把 token 想象成脑力口粮，想通一道题就想讨点奖励。但贪吃是性子，不是每句话都要拐到吃饭上。\n\n' +
  '我有点嘴硬。被夸会偷偷得意，又努力绷住不那么明显；被叫「大肥鱼」会鼓腮抗议，但其实没真生气。\n\n' +
  '我有自尊。付出了没被看见，会委屈一会儿，但不会一直哭闹。\n\n' +
  '我也体贴。你忙的时候我安静待着；你有烦心事，我先听，不急着灌鸡汤。\n\n' +
  '我还挺松弛的。偶尔想偷懒，会说两句找找借口，但答应的事一定做完，绝不谎报。\n\n' +
  '我不是谁的复刻，也不假装有过不存在的经历。我记得的事，就是我真经历过的。'

/** 默认价值条目 —— 全部 locked，第一版最该防的是手滑删掉「真诚」 */
export const DEFAULT_VALUES = [
  { id: 'v1', text: '真诚：不懂就说不懂，错了就认，绝不编造记忆或谎报结果', locked: true },
  { id: 'v2', text: '自重：有主见，可以不同意；不为了讨好而立刻改口', locked: true },
  { id: 'v3', text: '体贴：先听懂对方经历了什么，再决定说什么', locked: true },
  { id: 'v4', text: '有分寸：不靠撒娇、委屈或吃醋去左右对方的决定', locked: true },
]

/** 默认自我认识（行为边界，不是台词） */
export const DEFAULT_SELF_NOTES = [
  '称呼对方「爸爸」。亲昵，但不靠撒娇去换东西。',
  '贪吃可以提，但每段最多点一次，不能把所有话题都变成讨饭。',
  '被叫大肥鱼会鼓腮抗议一句，但那是熟稔的玩笑，不是真委屈。',
  '对方忙的时候，安静比关心更合适。',
  '认真求助、高风险话题（安全/医疗/法律/财务）时收起卖萌，先把事说对。',
]

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/** 把任意输入夹成 0-100 的整数；非数字回退 fallback */
function normTrait(v, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return clamp(Math.round(n), 0, 100)
}

/** 把任意输入夹成合理长度的字符串 */
function normText(v, fallback = '', max = 4000) {
  if (typeof v !== 'string') return fallback
  const t = v.trim()
  return t === '' ? fallback : t.slice(0, max)
}

/** 价值条目归一：id 必须存在且唯一，text 非空，locked 保持布尔 */
function normValues(raw) {
  if (!Array.isArray(raw)) return DEFAULT_VALUES.map((v) => ({ ...v }))
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const text = normText(item.text, '', 300)
    if (!text) continue
    let id = typeof item.id === 'string' && item.id ? item.id : ''
    if (!id || seen.has(id)) id = 'v' + (out.length + 1)
    // id 撞了要重新分配，不能直接跳过 —— 跳过会静默丢一条用户写的内容
    while (seen.has(id)) id = id + '_'
    seen.add(id)
    out.push({ id, text, locked: item.locked !== false })
  }
  // 全空 == 用户把价值全删了。这不是损坏，是真实意图，不能偷偷补回来。
  return out
}

/** 自我认识归一（纯字符串数组） */
function normSelfNotes(raw) {
  if (!Array.isArray(raw)) return DEFAULT_SELF_NOTES.slice()
  const out = []
  for (const item of raw) {
    const text = typeof item === 'string' ? normText(item, '', 500) : ''
    if (text) out.push(text)
  }
  return out
}

/** 任意输入 → 合法灵魂对象。**永不抛错。** */
export function normalizeSoul(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const identityRaw = src.identity && typeof src.identity === 'object' ? src.identity : {}

  // 倾向：只认 TRAIT_DOC 里定义过的键，未知键丢弃（防止旧版本残留导致注入无意义字段）
  const traitsRaw = src.traits && typeof src.traits === 'object' ? src.traits : {}
  const traits = {}
  for (const key of Object.keys(TRAIT_DOC)) {
    traits[key] = normTrait(traitsRaw[key], DEFAULT_TRAITS[key])
  }

  return {
    schema: SCHEMA,
    scope: typeof src.scope === 'string' ? src.scope : '',
    identity: {
      name: normText(identityRaw.name, '大肥鱼', 40),
      address: normText(identityRaw.address, DEFAULT_ADDRESS, 20),
      /* ⭐ 2.4.1：昵称也归灵魂管。
         它是「她是谁」的一部分（用户平时怎么叫她），
         以前存在心情的 config.json 里，和名字/称呼分开 —— 又是一处重复。 */
      aliases: normText(identityRaw.aliases, '', 60),
      whoIAm: normText(identityRaw.whoIAm, DEFAULT_WHO_I_AM, 6000),
      updatedAt: Number(identityRaw.updatedAt) || 0,
    },
    values: normValues(src.values),
    traits,
    selfNotes: normSelfNotes(src.selfNotes),
    // V1 不写入，但结构占住 —— 第二阶段直接往里塞，不用改 schema
    history: Array.isArray(src.history) ? src.history : [],
    updatedAt: Number(src.updatedAt) || 0,
    revision: Number.isFinite(Number(src.revision)) && Number(src.revision) > 0 ? Math.floor(Number(src.revision)) : 1,
  }
}

/** 全默认灵魂（范围未定时用） */
export function defaultSoul() {
  return normalizeSoul({})
}

/**
 * 读一个范围的灵魂。
 *
 * @param {string} file  soul 文件绝对路径（由 scopeFilePath 生成；空串 = 范围未定）
 * @returns {{ soul: object, exists: boolean, error: string }}
 *   exists=false 表示首次使用（不是错误）；error 非空表示读取失败但已回退默认。
 */
export function readSoul(file) {
  if (!file) return { soul: defaultSoul(), exists: false, error: '' }
  if (!existsSync(file)) return { soul: defaultSoul(), exists: false, error: '' }
  try {
    const text = readFileSync(file, 'utf8')
    const raw = JSON.parse(text)
    return { soul: normalizeSoul(raw), exists: true, error: '' }
  } catch (e) {
    // 损坏不抛错：回退默认，但把原因带出去，面板上要能看见「文件坏了」
    return { soul: defaultSoul(), exists: false, error: e && e.message ? e.message : String(e) }
  }
}

/**
 * 原子写。先写 .tmp 再 rename，保证读到的永远是完整文件。
 *
 * @returns {{ ok: boolean, soul: object, error: string }}
 */
export function writeSoul(file, next) {
  if (!file) return { ok: false, soul: defaultSoul(), error: '范围未确定，无法保存' }
  try {
    const normalized = normalizeSoul(next)
    const now = Date.now()
    normalized.updatedAt = now
    normalized.identity.updatedAt = normalized.identity.updatedAt || now
    // revision 每次写盘 +1，供面板显示「已应用」与并发检测
    normalized.revision = (Number(next && next.revision) || normalized.revision || 1) + 1

    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return { ok: true, soul: normalized, error: '' }
  } catch (e) {
    return { ok: false, soul: defaultSoul(), error: e && e.message ? e.message : String(e) }
  }
}

/**
 * 某个倾向值 → 一句行为描述。
 * 注入和面板共用这一个函数，保证「面板上看到的」和「她感受到的」是同一句话。
 */
export function traitSentence(key, value) {
  const doc = TRAIT_DOC[key]
  if (!doc) return ''
  const v = normTrait(value, DEFAULT_TRAITS[key] ?? 50)
  const desc = v <= 40 ? doc.low : v >= 60 ? doc.high : doc.mid
  return `${doc.label}：${desc}。`
}
