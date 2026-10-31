/**
 * 数据根目录搬家 —— 「改目录时顺便把现有数据复制过去」
 * ============================================================================
 * 背景
 * ---------------------------------------------------------------------------
 * 数据根目录住在 <DSH_HOME>/bigfish/root.json。改这个文件只是改「以后去哪读写」，
 * 数据本身不会跟着走。所以面板上要给一个「同时复制现有数据」的选项。
 *
 * 目录结构（记忆与心情共用）
 * ---------------------------------------------------------------------------
 *     <根>/scope.json                       范围（模式 + 工作区/会话）
 *     <根>/<范围内键>/memory-<短键>.sqlite3   记忆库（可能带 -wal / -shm）
 *     <根>/<范围内键>/mood-<短键>.json        心情状态
 *
 * 原则
 * ---------------------------------------------------------------------------
 * 1. **只复制，不删除。** 旧目录原地保留，界面上告诉用户「确认新目录能用后再自己删」。
 *    删数据是不可逆的，一次路径写错就全没了 —— 不值得为省点空间冒这个险。
 * 2. **目标必须是空目录。** 目标里只要有任何条目就拒绝复制，绝不覆盖已有文件。
 *    用户想覆盖就先自己清空，让"覆盖"永远是个显式动作。
 * 3. **先写临时名再改名。** 每个文件先写成 `<名字>.copying`，校验大小后再改名。
 *    中途失败留下的是 `.copying`，不会是"看起来正常但其实是半个"的正式文件。
 * 4. **先复制，后改 root.json。** 复制失败就不动配置，用户还在旧目录里好好工作。
 * 5. **主库用 SQLite 在线备份。** 直接 copyFile 一个正在被写入的库可能拿到不一致的
 *    快照；`VACUUM INTO` 由 SQLite 自己保证一致性。拿不到库句柄时退回文件复制。
 * ============================================================================
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const 临时后缀 = '.copying'

/** SQLite 的旁挂文件：主库之外，单独复制会破坏一致性 */
const 旁挂后缀 = ['-wal', '-shm', '-journal']

/** 复制单个文件：先写临时名，校验字节数一致后再改名 */
function 复制一个文件(源, 目标) {
  const 临时 = 目标 + 临时后缀
  try { rmSync(临时, { force: true }) } catch { /* 清不掉就让 copyFile 报错 */ }
  copyFileSync(源, 临时)
  const 源大小 = statSync(源).size
  const 目标大小 = statSync(临时).size
  if (源大小 !== 目标大小) {
    try { rmSync(临时, { force: true }) } catch { /* 尽力清理 */ }
    throw new Error(`复制后大小不一致：${basename(源)}（源 ${源大小} 字节，目标 ${目标大小} 字节）`)
  }
  renameSync(临时, 目标)
  return { file: basename(目标), bytes: 目标大小 }
}

/** 校验 SQLite 文件的头 16 字节，确认复制出来的确实是个库 */
function 是SQLite文件(p) {
  try {
    const fd = readFileSync(p)
    return fd.length >= 16 && fd.subarray(0, 15).toString('latin1') === 'SQLite format 3'
  } catch {
    return false
  }
}

/**
 * 试一下能不能把记忆库搬到新根。
 *
 * @param {object} p
 * @param {string} p.from          当前数据根（绝对路径）
 * @param {string} p.to            目标数据根（绝对路径）
 * @param {object} [p.store]       正在运行的 MemoryStore，有就用来做在线备份
 * @returns {{ok:boolean, from:string, to:string, code?:string, reason?:string,
 *            files:number, bytes:number, conflict?:string[], note?:string}}
 */
export function inspectMove({ from, to, store = null }) {
  const 源 = String(from || '').trim()
  const 目标 = String(to || '').trim()

  if (!源 || !目标) return 失败('no-root', '源目录或目标目录为空')
  if (!isAbsolute(源) || !isAbsolute(目标)) return 失败('not-absolute', '目录必须是绝对路径')

  const 源绝对 = resolve(源)
  const 目标绝对 = resolve(目标)
  if (源绝对.toLowerCase() === 目标绝对.toLowerCase()) {
    return 失败('same-root', '新旧目录是同一个，不需要复制')
  }
  // 互相嵌套会让「复制完再校验」永远不可能干净：源里有目标，目标里又有源。
  const 前缀 = (a, b) => b.toLowerCase().startsWith(a.toLowerCase() + '\\') || b.toLowerCase().startsWith(a.toLowerCase() + '/')
  if (前缀(源绝对, 目标绝对) || 前缀(目标绝对, 源绝对)) {
    return 失败('nested', '新旧目录不能互相包含，请选一个平行的目录')
  }
  if (!existsSync(源绝对)) return 失败('no-source', '当前数据目录不存在，没有东西可复制')

  // 目标：不存在 = 新建；存在 = 必须是空目录
  let 冲突 = []
  if (existsSync(目标绝对)) {
    if (!statSync(目标绝对).isDirectory()) return 失败('target-not-dir', '目标已经存在且不是目录')
    const 条目 = readdirSync(目标绝对)
    if (条目.length) 冲突 = 条目.slice(0, 20)
  }

  // 盘点要搬什么（只看根下一层和每个范围目录里的文件，别的不管）
  const 计划 = []
  let 字节 = 0
  const 收集 = (目录, 相对) => {
    for (const 名 of readdirSync(目录)) {
      const 完整 = join(目录, 名)
      const 相对路径 = 相对 ? join(相对, 名) : 名
      let 信息
      try { 信息 = statSync(完整) } catch { continue }
      if (信息.isDirectory()) { 收集(完整, 相对路径); continue }
      if (!信息.isFile()) continue
      // 旁挂文件不单独复制：主库走在线备份，旁挂由 SQLite 自己重建
      if (旁挂后缀.some((s) => 名.toLowerCase().endsWith(s))) continue
      if (名.endsWith(临时后缀)) continue
      计划.push({ from: 完整, rel: 相对路径, bytes: 信息.size })
      字节 += 信息.size
    }
  }
  收集(源绝对, '')

  return {
    ok: 冲突.length === 0,
    from: 源绝对,
    to: 目标绝对,
    code: 冲突.length ? 'target-not-empty' : undefined,
    reason: 冲突.length ? '目标目录里已经有东西了，为安全起见不会覆盖' : undefined,
    conflict: 冲突,
    files: 计划.length,
    bytes: 字节,
    plan: 计划,
    note: 冲突.length
      ? '换一个空目录，或先把目标目录清空再试'
      : `将复制 ${计划.length} 个文件，共 ${(字节 / 1048576).toFixed(1)} MB。旧目录原地保留。`,
  }
}

function 失败(code, reason) {
  return { ok: false, code, reason, files: 0, bytes: 0, conflict: [] }
}

/**
 * 真正执行复制。调用前应当先 inspectMove 并确认 ok。
 * 永远不删除源目录里的任何东西。
 *
 * @returns {{ok:boolean, from:string, to:string, copied:Array, bytes:number,
 *            verified:boolean, warnings:string[], reason?:string, code?:string}}
 */
export function copyDataRoot({ from, to, store = null, dryRun = false }) {
  const 预演 = inspectMove({ from, to, store })
  if (!预演.ok) return { ...预演, copied: [], verified: false, warnings: [] }

  const 警告 = []
  const 已复制 = []
  const 备份目标 = join(预演.to, '__memory-backup.sqlite3')

  if (dryRun) {
    return { ...预演, copied: [], verified: false, warnings: ['预演模式，没有写入任何文件'], dryRun: true }
  }

  try {
    mkdirSync(预演.to, { recursive: true })

    // 主库：优先让 SQLite 自己做一致性快照
    let 主库备份成功 = false
    const 主库 = 预演.plan.find((x) => /\.sqlite3?$/i.test(x.rel) && !/^scope\.json$/i.test(x.rel))
    if (主库 && store && typeof store.backupTo === 'function') {
      try {
        store.backupTo(备份目标)
        if (!是SQLite文件(备份目标)) throw new Error('备份产物不是合法的 SQLite 文件')
        主库备份成功 = true
      } catch (e) {
        警告.push('在线备份失败，改用文件复制：' + (e && e.message ? e.message : String(e)))
        try { rmSync(备份目标, { force: true }) } catch { /* 忽略 */ }
      }
    }

    for (const 项 of 预演.plan) {
      const 目标路径 = join(预演.to, 项.rel)
      mkdirSync(dirname(目标路径), { recursive: true })
      const 是主库 = 主库备份成功 && 项 === 主库
      if (是主库) {
        renameSync(备份目标, 目标路径)
        已复制.push({ file: 项.rel, bytes: statSync(目标路径).size, mode: 'sqlite-backup' })
        continue
      }
      已复制.push({ ...复制一个文件(项.from, 目标路径), file: 项.rel, mode: 'file-copy' })
    }

    // 校验：每个目标文件大小与源一致；SQLite 主库要有合法文件头
    // ⚠️ 走在线备份的主库以「文件头合法 + 备份时刻的字节数」为准 —— 在线备份出来的库
    //    必然比活动库小（不带 WAL 和空闲页），拿活动库的当前大小去比会永远不相等。
    let 校验通过 = true
    for (const 项 of 预演.plan) {
      const 目标路径 = join(预演.to, 项.rel)
      const 已复制条目 = 已复制.find((x) => x.file === 项.rel)
      const 是备份 = 已复制条目 && 已复制条目.mode === 'sqlite-backup'
      try {
        if (!existsSync(目标路径)) { 校验通过 = false; 警告.push('目标缺少文件：' + 项.rel); continue }
        const 目标大小 = statSync(目标路径).size
        const 期望大小 = 是备份 ? Number(已复制条目.bytes) : 项.bytes
        if (目标大小 !== 期望大小) { 校验通过 = false; 警告.push('大小不一致：' + 项.rel) }
        if (/\.sqlite3?$/i.test(项.rel) && !是SQLite文件(目标路径)) {
          校验通过 = false
          警告.push('不是合法的 SQLite 文件：' + 项.rel)
        }
      } catch (e) {
        校验通过 = false
        警告.push('校验出错：' + 项.rel + '：' + (e && e.message ? e.message : String(e)))
      }
    }

    const 总字节 = 已复制.reduce((n, x) => n + (Number(x.bytes) || 0), 0)
    return {
      ok: 校验通过,
      from: 预演.from,
      to: 预演.to,
      copied: 已复制,
      bytes: 总字节,
      verified: 校验通过,
      warnings: 警告,
      code: 校验通过 ? undefined : 'verify-failed',
      reason: 校验通过 ? undefined : '复制完成但校验没通过，root.json 不会被改动',
    }
  } catch (e) {
    return {
      ok: false,
      from: 预演.from,
      to: 预演.to,
      copied: 已复制,
      bytes: 已复制.reduce((n, x) => n + (Number(x.bytes) || 0), 0),
      verified: false,
      warnings: 警告,
      code: 'copy-failed',
      reason: e && e.message ? e.message : String(e),
    }
  }
}

/** 校验用的稳定指纹（给测试用，也方便用户对比两边是不是一致） */
export function dataRootStamp(root) {
  const 摘要 = createHash('sha256')
  const 走 = (目录, 相对) => {
    let 条目 = []
    try { 条目 = readdirSync(目录).sort() } catch { return }
    for (const 名 of 条目) {
      const 完整 = join(目录, 名)
      const 相对路径 = 相对 ? join(相对, 名) : 名
      let 信息
      try { 信息 = statSync(完整) } catch { continue }
      if (信息.isDirectory()) { 走(完整, 相对路径); continue }
      if (!信息.isFile()) continue
      if (名.endsWith(临时后缀)) continue
      摘要.update(相对路径.replace(/\\/g, '/'))
      摘要.update(String(信息.size))
    }
  }
  走(String(root || ''), '')
  return 摘要.digest('hex')
}
