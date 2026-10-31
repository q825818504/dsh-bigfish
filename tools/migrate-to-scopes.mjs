/**
 * 把旧位置的数据搬到「每范围一个目录」的新结构
 * ============================================================================
 * 旧：
 *   记忆  D:\大肥鱼\记忆\workspace-<uuid前8位>.sqlite3
 *   心情  <DSH_HOME>\bigfish-mood\state.json        （所有范围挤在一个文件）
 *
 * 新：
 *   <数据根目录>\ws-<uuid>\memory-ws-<短标识>.sqlite3
 *   <数据根目录>\ws-<uuid>\mood-ws-<短标识>.json
 *
 * 安全措施：
 *   · 只复制，不删除源文件 —— 迁完自己确认没问题再手工清理
 *   · 目标已存在就跳过，不覆盖（避免把新数据冲掉）
 *   · 心情的份键转换交给插件启动时的「迁移份键」，这里只负责搬家
 *
 * 用法：node tools/migrate-to-scopes.mjs
 *      加 --dry 只看会做什么，不落盘
 * ============================================================================
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const DRY = process.argv.includes('--dry')

const DATA_ROOT = 'D:\\大肥鱼\\数据'
const OLD_MEMORY_DIR = 'D:\\大肥鱼\\记忆'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const OLD_MOOD_STATE = join(DSH_HOME, 'bigfish-mood', 'state.json')

// 当前绑定的工作区（与 profile 的 cordis.patch.yml 一致）
const WORKSPACE_ID = 'f60efa11-cf48-49de-9d8b-4a28e45975f3'
const SCOPE_KEY = `ws-${WORKSPACE_ID}`
const SHORT = SCOPE_KEY.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16)
const SCOPE_DIR = join(DATA_ROOT, SCOPE_KEY)

const MB = (n) => (n / 1024 / 1024).toFixed(2) + ' MB'

function log(...a) { console.log(...a) }

log('=== 迁移到「每范围一个目录」 ===')
log('数据根目录 :', DATA_ROOT)
log('范围标识   :', SCOPE_KEY)
log('范围目录   :', SCOPE_DIR)
log('模式       :', DRY ? 'DRY RUN（不落盘）' : '实际执行')
log('')

// ── 1. 记忆库 ────────────────────────────────────────────────────────────
const oldMem = join(OLD_MEMORY_DIR, 'workspace-f60efa11.sqlite3')
const newMem = join(SCOPE_DIR, `memory-${SHORT}.sqlite3`)

log('[记忆]')
if (!existsSync(oldMem)) {
  log('  源库不存在，跳过：', oldMem)
} else if (existsSync(newMem)) {
  log('  目标已存在，跳过（不覆盖）：', newMem)
} else {
  const size = statSync(oldMem).size
  log('  源  :', oldMem, MB(size))
  log('  目标:', newMem)
  if (!DRY) {
    mkdirSync(SCOPE_DIR, { recursive: true })
    copyFileSync(oldMem, newMem)
    // WAL / SHM 一起带上，否则可能丢最近写入
    for (const ext of ['-wal', '-shm']) {
      const s = oldMem + ext
      if (existsSync(s)) {
        copyFileSync(s, newMem + ext)
        log('  附带:', ext)
      }
    }
    log('  完成，新库大小', MB(statSync(newMem).size))
  }
}

// ── 2. 心情状态 ──────────────────────────────────────────────────────────
const newMood = join(SCOPE_DIR, `mood-${SHORT}.json`)

log('')
log('[心情]')
if (!existsSync(OLD_MOOD_STATE)) {
  log('  旧 state.json 不存在，跳过：', OLD_MOOD_STATE)
} else if (existsSync(newMood)) {
  log('  目标已存在，跳过（不覆盖）：', newMood)
} else {
  let raw = null
  try { raw = JSON.parse(readFileSync(OLD_MOOD_STATE, 'utf8')) } catch (e) {
    log('  读不了旧文件：', e.message)
  }
  if (raw && raw.moods && typeof raw.moods === 'object') {
    const keys = Object.keys(raw.moods)
    log('  旧文件里的份键:', keys.join(', ') || '(空)')
    log('  目标:', newMood)
    if (!DRY) {
      mkdirSync(SCOPE_DIR, { recursive: true })
      // 原样搬过去：份键的转换由插件启动时的「迁移份键」完成，
      // 它能反查 workspace.json 把 --D-xxx-- 换成 ws-<uuid>
      writeFileSync(newMood, JSON.stringify(raw, null, 2), 'utf8')
      log('  完成')
    }
  }
}

log('')
log(DRY ? 'DRY RUN 结束，没有改动任何文件。' : '迁移结束。源文件都保留着，确认没问题再手工清理。')
