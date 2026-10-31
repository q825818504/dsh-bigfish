/**
 * 灵魂模块测试（test-soul）
 * ============================================================================
 * 覆盖 .planning/task-soul.md 第八节列出的九条。
 * 不依赖 DSH 运行时：数据层直接测，注入层用一个假的 ctx 测。
 * ============================================================================
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

let pass = 0
let fail = 0
const results = []

function test(label, fn) {
  try {
    fn()
    pass++
    results.push(['PASS', label])
  } catch (e) {
    fail++
    results.push(['FAIL', label + ' — ' + (e && e.message)])
  }
}

const store = await import('../lib/soul/store.js')
const scopeKeyMod = await import('../lib/scope-key.js')

const tmpRoots = []
function mkRoot() {
  const d = mkdtempSync(join(tmpdir(), 'soul-test-'))
  tmpRoots.push(d)
  return d
}

// ── 1. scopeFilePath 新增 soul 档，且不影响已有两档 ─────────────────────────

test('1a scopeFilePath soul 路径正确', () => {
  const p = scopeKeyMod.scopeFilePath('/root', 'ws-abc123', 'soul')
  assert.ok(p.endsWith('soul-ws-abc123.json'), p)
  assert.ok(p.includes('ws-abc123'), p)
})

test('1b memory 与 mood 两档行为不变', () => {
  assert.equal(scopeKeyMod.scopeFilePath('/root', 'ws-x', 'memory'), join('/root', 'ws-x', 'memory-ws-x.sqlite3'))
  assert.equal(scopeKeyMod.scopeFilePath('/root', 'ws-x', 'mood'), join('/root', 'ws-x', 'mood-ws-x.json'))
})

test('1c 非法 kind 仍然抛错', () => {
  assert.throws(() => scopeKeyMod.scopeFilePath('/root', 'ws-x', 'nope'))
})

test('1d 空 key 返回空串', () => {
  assert.equal(scopeKeyMod.scopeFilePath('/root', '', 'soul'), '')
})

// ── 2. normalizeSoul 永不抛错 ──────────────────────────────────────────────

test('2a 空对象得到完整默认结构', () => {
  const s = store.normalizeSoul({})
  assert.equal(s.identity.name, '大肥鱼')
  assert.equal(s.identity.address, '爸爸')
  assert.equal(s.values.length, 4)
  assert.ok(s.values.every((v) => v.locked === true))
  assert.deepEqual(Object.keys(s.traits).sort(), ['assertiveness', 'directness', 'playfulness', 'warmth'])
  assert.ok(s.identity.whoIAm.length > 0)
})

test('2b null / 字符串 / 数组输入都不抛错', () => {
  for (const bad of [null, undefined, 'string', 123, []]) {
    const s = store.normalizeSoul(bad)
    assert.equal(s.identity.name, '大肥鱼')
  }
})

test('2c 字段类型错时逐个回退，不整体丢弃', () => {
  const s = store.normalizeSoul({
    identity: 'not-an-object',
    traits: { warmth: 'abc', assertiveness: -50 },
    values: 'not-an-array',
    selfNotes: 42,
  })
  assert.equal(s.traits.warmth, store.DEFAULT_TRAITS.warmth) // 非数字回退默认
  assert.equal(s.traits.assertiveness, 0) // 数字但越界 → 夹紧
  assert.equal(s.values.length, 4)
  assert.ok(Array.isArray(s.selfNotes))
})

test('2d 未知 trait 键被丢弃', () => {
  const s = store.normalizeSoul({ traits: { warmth: 10, 不存在的键: 99 } })
  assert.equal(s.traits['不存在的键'], undefined)
})

test('2e 价值全删是真实意图，不偷偷补回来', () => {
  const s = store.normalizeSoul({ values: [] })
  assert.equal(s.values.length, 0)
})

test('2f 价值条目缺 id / id 重复会被重新分配而不是丢弃', () => {
  const s = store.normalizeSoul({
    values: [
      { text: '第一条' },
      { id: 'dup', text: '第二条' },
      { id: 'dup', text: '第三条' },
    ],
  })
  assert.equal(s.values.length, 3)
  assert.equal(new Set(s.values.map((v) => v.id)).size, 3)
})

// ── 3. 损坏 JSON 不抛错 ───────────────────────────────────────────────────

test('3a 损坏 JSON 回退默认并带出原因', () => {
  const d = mkRoot()
  const f = join(d, 'soul-bad.json')
  writeFileSync(f, '{ 这不是 json', 'utf8')
  const r = store.readSoul(f)
  assert.equal(r.exists, false)
  assert.equal(r.soul.identity.name, '大肥鱼')
  assert.ok(r.error.length > 0)
})

// ── 4. 文件不存在 → exists=false ──────────────────────────────────────────

test('4a 文件不存在返回 exists=false 且不是错误', () => {
  const d = mkRoot()
  const r = store.readSoul(join(d, 'nope.json'))
  assert.equal(r.exists, false)
  assert.equal(r.error, '')
})

test('4b 空路径直接返回默认', () => {
  const r = store.readSoul('')
  assert.equal(r.exists, false)
})

// ── 5. 读写往返 + 原子写 + revision ───────────────────────────────────────

test('5a 写入后能原样读回', () => {
  const d = mkRoot()
  const f = join(d, 'soul-x.json')
  const w = store.writeSoul(f, { identity: { whoIAm: '我是测试鱼', address: '爸爸' }, traits: { warmth: 20 } })
  assert.equal(w.ok, true)
  const r = store.readSoul(f)
  assert.equal(r.exists, true)
  assert.equal(r.soul.identity.whoIAm, '我是测试鱼')
  assert.equal(r.soul.traits.warmth, 20)
})

test('5b revision 每次写盘递增', () => {
  const d = mkRoot()
  const f = join(d, 'soul-y.json')
  const w1 = store.writeSoul(f, {})
  const w2 = store.writeSoul(f, w1.soul)
  assert.equal(w2.soul.revision, w1.soul.revision + 1)
})

test('5c 原子写不留 .tmp 残留', () => {
  const d = mkRoot()
  const f = join(d, 'soul-z.json')
  store.writeSoul(f, {})
  const listed = readdirSync(d)
  assert.ok(!listed.some((n) => n.endsWith('.tmp')), JSON.stringify(listed))
  assert.ok(listed.includes('soul-z.json'), JSON.stringify(listed))
})

test('5d 写入空路径返回失败而不是抛错', () => {
  const w = store.writeSoul('', {})
  assert.equal(w.ok, false)
  assert.ok(w.error.length > 0)
})

// ── 6. traitSentence 三档 ─────────────────────────────────────────────────

test('6a traitSentence 低 / 中 / 高三档描述正确', () => {
  assert.match(store.traitSentence('warmth', 30), /克制/)
  assert.match(store.traitSentence('warmth', 50), /不黏人/)
  assert.match(store.traitSentence('warmth', 85), /主动问候/)
})

test('6b 未定义的键返回空串', () => {
  assert.equal(store.traitSentence('nope', 50), '')
})

test('7 每个 trait 都有 low/mid/high 三句话', () => {
  for (const [k, doc] of Object.entries(store.TRAIT_DOC)) {
    assert.ok(doc.low && doc.mid && doc.high, k + ' 缺描述')
    assert.ok(doc.label, k + ' 缺 label')
  }
})

// ── 8. 注入层（假 ctx）───────────────────────────────────────────────────
//
// ⚠ 顺序很重要：lib/soul/index.js 在**模块加载时**读 process.env.DSH_HOME，
//   所以必须先设环境变量、写好范围文件，再 import 它。反过来会读到真实 homedir。

const injHome = mkdtempSync(join(tmpdir(), 'soul-inj-'))
process.env.DSH_HOME = injHome
const injScopes = join(injHome, 'bigfish', 'scopes')
mkdirSync(injScopes, { recursive: true })
writeFileSync(
  join(injScopes, 'scope.json'),
  JSON.stringify({ version: 1, mode: 'workspace', workspaceId: 'WSID-T', sessionIds: [], updatedAt: 0 }),
  'utf8',
)
const injKey = scopeKeyMod.scopeKey({ mode: 'workspace', workspaceId: 'WSID-T' })
const injFile = scopeKeyMod.scopeFilePath(injScopes, injKey, 'soul')
const soulHost = await import('../lib/soul/index.js')

function fakeCtx() {
  const rec = { section: null, tools: [], routes: [] }
  const ctx = {
    systemPrompt: { section(a) { rec.section = a; return () => {} } },
    tools: { register(t) { rec.tools.push(t); return () => {} } },
    webServer: { register(r) { rec.routes.push(r); return () => {} } },
    effect(fn) { return fn() },
  }
  return { ctx, rec }
}

test('8a 注入 order=860，interpolate=false', () => {
  const { ctx, rec } = fakeCtx()
  soulHost.apply(ctx)
  assert.equal(rec.section.order, 860)
  assert.equal(rec.section.interpolate, false)
  assert.equal(rec.section.name, 'bigfish:soul')
})

test('8b 顺序落在记忆 850 与心情 900 之间', () => {
  const { ctx, rec } = fakeCtx()
  soulHost.apply(ctx)
  assert.ok(rec.section.order > 850, '必须晚于记忆')
  assert.ok(rec.section.order < 900, '必须早于心情')
})

test('8c 只注册只读工具，没有写入口', () => {
  const { ctx, rec } = fakeCtx()
  soulHost.apply(ctx)
  const names = rec.tools.map((t) => t.name)
  assert.ok(names.includes('soul_read'), JSON.stringify(names))
  assert.ok(!names.some((n) => /update|write|set|propose/.test(n)), 'V1 不应有写工具：' + JSON.stringify(names))
})

test('8d 范围未定时不注入', () => {
  const { ctx, rec } = fakeCtx()
  soulHost.apply(ctx)
  // 此时范围文件里写的是 workspace WSID-T，是有效的；先确认有效时能注入
  store.writeSoul(injFile, { identity: { whoIAm: '我是大肥鱼' } })
  assert.ok(rec.section.text().includes('大肥鱼'))
})

test('8e 注入文本含称呼、价值、倾向，且不含裸数字', () => {
  store.writeSoul(injFile, {
    identity: { whoIAm: '我是大肥鱼', address: '爸爸' },
    traits: { warmth: 85, assertiveness: 20 },
    values: [{ id: 'v1', text: '真诚：不编造', locked: true }],
  })
  const { ctx, rec } = fakeCtx()
  soulHost.apply(ctx)
  const t = rec.section.text()
  assert.ok(t.includes('爸爸'))
  assert.ok(t.includes('真诚：不编造'))
  assert.ok(t.includes('主动问候'), 'warmth 85 应映射成高值句')
  assert.ok(t.includes('倾向附和'), 'assertiveness 20 应映射成低值句')
  // 倾向值绝不能以数字形式进入提示词
  assert.ok(!/85|20\b/.test(t.replace(/\d{4}/g, '')), '注入文本里出现了倾向数字：' + t)
})

test('8f 超长人格保留开头并截断到 1200', () => {
  store.writeSoul(injFile, { identity: { whoIAm: '【开头】' + '啊'.repeat(5000) } })
  const { ctx, rec } = fakeCtx()
  soulHost.apply(ctx)
  const t = rec.section.text()
  assert.ok(t.length <= 1200, '长度 ' + t.length)
  assert.ok(t.startsWith('【开头】'))
})

test('8g interpolate=false：花括号原样保留', () => {
  store.writeSoul(injFile, { identity: { whoIAm: '测试 {{不存在的变量}} 原样保留' } })
  const { ctx, rec } = fakeCtx()
  soulHost.apply(ctx)
  const t = rec.section.text()
  assert.ok(t.includes('{{不存在的变量}}'), t)
})

// ── 9. 隔离：模块内部抛错不能带崩外层 ─────────────────────────────────────

test('9a 注入注册失败时，工具仍然注册', () => {
  let toolRegistered = false
  const ctx = {
    systemPrompt: { section() { throw new Error('模拟 section 炸了') } },
    tools: { register() { toolRegistered = true; return () => {} } },
    webServer: { register() { return () => {} } },
    effect(fn) { return fn() },
  }
  assert.doesNotThrow(() => soulHost.apply(ctx))
  assert.equal(toolRegistered, true)
})

test('9b 装配层对单个模块失败做隔离，apply 不抛', async () => {
  const bigfish = await import('../index.js')
  const ctx = {
    systemPrompt: { section() { return () => {} }, context() { return () => {} } },
    tools: { register() { throw new Error('模拟崩溃') } },
    webServer: { register() { return () => {} }, get() {} },
    effect(fn) { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    get() { return undefined }, set() {}, on() { return () => {} },
    logger: { warn() {}, info() {} }, emit() {},
    sessions: { list() { return [] } },
    sessionQuery: {}, agents: {}, connection: {},
    workspaceRegistry: { list() { return [] } },
    settings: { register() {}, get() {} },
    llm: {}, timer: {},
  }
  assert.doesNotThrow(() => bigfish.apply(ctx, {}))
  assert.deepEqual(Object.keys(bigfish.parts).sort(), ['memory', 'mood', 'soul'])
})

// ── 10. 路由注册的幂等与清理（2026-10-31 实机 bug 的回归）──────────────────
//
// 实机日志：`注册路由失败：webserver: duplicate exact route "/dsh-bigfish/soul"`。
// 根因是 effect 回调返回了数组而不是清理函数，重复 apply 时旧路由没被拆掉。
//
// ⚠ 2.3.0 起幂等由 ctx.effect 的生命周期负责（模块级布尔标记已删除）——
//   下面的用例各自用 mock 的 effect 清理来模拟 cordis 行为，不依赖执行顺序。

test('10a effect 回调返回的是函数，不是数组', () => {
  soulHost.__resetRoutesForTest()
  const effects = []
  const ctx = {
    systemPrompt: { section() { return () => {} } },
    tools: { register() { return () => {} } },
    webServer: { register() { return () => {} } },
    effect(fn) { const d = fn(); effects.push(d); return () => {} },
  }
  soulHost.apply(ctx)
  assert.equal(effects.length, 1, '应只有一个 effect（实际 ' + effects.length + '）')
  assert.equal(typeof effects[0], 'function', '必须是清理函数，不能是数组')
})

test('10b 重复 apply 不会重复注册路由', () => {
  let registered = 0
  let lastCleanup = null
  soulHost.__resetRoutesForTest()
  /* ⭐ 2.3.0 起幂等改由 ctx.effect 的生命周期负责（旧的模块级布尔标记有加载顺序隐患）：
     用和 cordis 一致的 mock —— 再次 apply 前先执行上一个 effect 的清理函数。 */
  const ctx = {
    systemPrompt: { section() { return () => {} } },
    tools: { register() { return () => {} } },
    webServer: { register() { registered++; return () => { registered-- } } },
    effect(fn) {
      if (typeof lastCleanup === 'function') lastCleanup()   // cordis 会先清掉上一个 effect
      const d = fn()
      lastCleanup = typeof d === 'function' ? d : null
      return () => { if (typeof d === 'function') d() }
    },
  }
  soulHost.apply(ctx)
  assert.equal(registered, 1, '第一次应注册且只剩一条路由（实际 ' + registered + '）')
  soulHost.apply(ctx) // 模拟重新装载
  assert.equal(registered, 1, '重新装载后仍只有一条路由（实际 ' + registered + '）')
})

test('10c 清理函数被调用后可以重新注册', () => {
  let registered = 0
  let lastCleanup = null
  soulHost.__resetRoutesForTest()
  const ctx = {
    systemPrompt: { section() { return () => {} } },
    tools: { register() { return () => {} } },
    webServer: { register() { registered++; return () => {} } },
    effect(fn) { const d = fn(); lastCleanup = typeof d === 'function' ? d : null; return () => {} },
  }
  soulHost.apply(ctx)
  const afterFirst = registered
  assert.ok(afterFirst > 0, '第一次应注册（实际 ' + afterFirst + '）')
  assert.equal(typeof lastCleanup, 'function', '应拿到清理函数')
  lastCleanup() // 模拟卸载
  soulHost.apply(ctx)
  assert.ok(registered > afterFirst, '清理后应能重新注册（' + registered + ' vs ' + afterFirst + '）')
})

// ── 11. 同一 path 不能注册两次（2026-10-31 第二次实机 bug）────────────────
//
// 真实 webServer 按 path 做唯一性检查，**不区分 method**。
// 最初把 GET / POST 注册成两条同 path 路由，于是必然崩：
//   "webserver: duplicate exact route /dsh-bigfish/soul"
// 下面的 mock 按真实语义来：同一 path 第二次注册直接抛错。

function makeStrictWebServer() {
  const paths = new Set()
  const handlers = new Map()
  return {
    paths,
    handlers,
    register({ path, handler }) {
      if (paths.has(path)) throw new Error(`webserver: duplicate exact route "${path}"`)
      paths.add(path)
      handlers.set(path, handler)
      return () => { paths.delete(path); handlers.delete(path) }
    },
  }
}

test('11a 模拟真实 webServer 时，apply 不会撞 duplicate', () => {
  soulHost.__resetRoutesForTest()
  const ws = makeStrictWebServer()
  const ctx = {
    systemPrompt: { section() { return () => {} } },
    tools: { register() { return () => {} } },
    webServer: ws,
    effect(fn) { return fn() },
  }
  assert.doesNotThrow(() => soulHost.apply(ctx))
  assert.equal(ws.paths.size, 1, '应该只注册一条路由，实际 ' + ws.paths.size)
  assert.ok(ws.paths.has('/dsh-bigfish/soul'), [...ws.paths].join(','))
})

test('11b 同一条路由能同时处理 GET 和 POST', async () => {
  soulHost.__resetRoutesForTest()
  const ws = makeStrictWebServer()
  const ctx = {
    systemPrompt: { section() { return () => {} } },
    tools: { register() { return () => {} } },
    webServer: ws,
    effect(fn) { return fn() },
  }
  soulHost.apply(ctx)
  const handler = ws.handlers.get('/dsh-bigfish/soul')
  assert.ok(handler, '应注册 handler')

  // GET：范围未定时返回 scopeReady:false，而不是 405
  let got = null
  const resGet = { writeHead() {}, end(b) { got = JSON.parse(b) } }
  await handler({ method: 'GET', headers: {}, url: '/dsh-bigfish/soul' }, resGet)
  assert.ok(got && got.ok === true, 'GET 应成功：' + JSON.stringify(got))

  // 不支持的 method → 405
  let status = null
  const resDel = { writeHead(s) { status = s }, end() {} }
  await handler({ method: 'DELETE', headers: {}, url: '/dsh-bigfish/soul' }, resDel)
  assert.equal(status, 405)
})

// ── 12. 范围推导兜底（2026-10-31 第三次实机问题）──────────────────────────
//
// 现象：面板一直显示「还没有确定绑定范围」，但 scopes/ 下明明已经有
// ws-xxxx 目录（心情写下的）。根因是灵魂死等 scope.json，而用户从没在
// 「设置」里保存过。现在：scope.json 缺失时，从 scopes/ 下已有目录反推。

test('12a scope.json 不存在时，能从已有数据目录推出范围', () => {
  // 造一个全新的 DSH_HOME，里面只有 scopes/ws-abc（没有 scope.json）
  const home = mkdtempSync(join(tmpdir(), 'soul-infer-'))
  const scopes = join(home, 'bigfish', 'scopes')
  mkdirSync(join(scopes, 'ws-abc'), { recursive: true })
  writeFileSync(join(scopes, 'ws-abc', 'mood-ws-abc.json'), '{}', 'utf8')

  // 独立进程跑，避免 DSH_HOME 已被本文件前面的用例读走
  const soulPath = new URL('../lib/soul/index.js', import.meta.url).href
  const script = `
    process.env.DSH_HOME = ${JSON.stringify(home)}
    const soul = await import(${JSON.stringify(soulPath)})
    const ws = { paths: new Set(), handlers: new Map(), register(r) { if (this.paths.has(r.path)) throw new Error('dup'); this.paths.add(r.path); this.handlers.set(r.path, r.handler); return () => {} } }
    soul.apply({ systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, webServer: ws, effect: (f) => f() })
    let out = null
    await ws.handlers.get('/dsh-bigfish/soul')({ method: 'GET', headers: {} }, { writeHead() {}, end(b) { out = JSON.parse(b) } })
    console.log(JSON.stringify({ scopeReady: out.scopeReady, scope: out.soul && out.soul.scope }))
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  const parsed = JSON.parse(out.trim().split('\n').pop())
  assert.equal(parsed.scopeReady, true, '应能推出范围：' + out)
  assert.equal(parsed.scope, 'ws-abc', '范围键应为 ws-abc：' + out)
  rmSync(home, { recursive: true, force: true })
})

// ── 汇总 ─────────────────────────────────────────────────────────────────

for (const [s, label] of results) {
  console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${label}`)
}
for (const d of tmpRoots) {
  try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
}
console.log(`\n灵魂模块：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
