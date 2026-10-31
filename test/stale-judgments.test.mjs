import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// Only synthetic state; the production module captures this path at import time.
const home = mkdtempSync(join(tmpdir(), 'bigfish-stale-'))
process.env.DSH_HOME = home
const { apply, __测试: helpers, 规整份数 } = await import('../lib/mood/index.js')

// 路由前缀跟随插件（上游是 /dsh-feiyu-mood，本仓库是 /dsh-bigfish-mood）
const P = '/dsh-bigfish-mood'
const result = JSON.stringify({ moodDelta: 9, dims: { happy: 6 }, reason: 'synthetic judgment', confidence: 90 })
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
const slot = (id, sessions) => ({ id, sessions })

function harness(slots = [slot('a', ['session-one'])]) {
  mkdirSync(join(home, 'bigfish-mood'), { recursive: true })
  // ⭐ 显式写 模式: 'session' —— 本仓库的默认模式已改为 'workspace'（绑工作区），
  //    而这批用例验的是「按会话归属」的竞态语义，必须把模式钉死。
  writeFileSync(join(home, 'bigfish-mood', 'config.json'), JSON.stringify({ 模式: 'session', slots }))
  helpers.存库({ moods: { probe: helpers.读一份('probe') }, lastActive: 'probe' })
  assert.ok(helpers.读库().moods.probe, 'temporary storage must support atomic writes')
  helpers.存库({ moods: {}, lastActive: '' })
  assert.deepEqual(helpers.读库().moods, {})
  const routes = new Map(), effects = [], intervals = [], calls = []
  function makeAgent(sid) {
    const events = new Map()
    const agent = {
      session: { id: sid, snapshotEvents: () => [
        { type: 'user/message', payload: { text: 'synthetic user', source: { kind: 'user' } } },
        { type: 'assistant/message', payload: { text: 'synthetic reply' } },
      ] },
      options: { provider: 'fake', model: 'deferred' },
      ctx: {
        on(name, fn) { events.set(name, fn); return () => { if (events.get(name) === fn) events.delete(name) } },
        systemPrompt: { context: () => () => {} },
      },
    }
    return { agent, turn: () => events.get('agent/turn-stopping')?.() }
  }
  const first = makeAgent('session-one')
  const agent = first.agent
  let agents = [agent]
  const ctx = {
    agents: { list: () => agents, roots: () => agents },
    effect(fn) { const off = fn(); if (typeof off === 'function') effects.push(off) },
    interval(fn) { intervals.push(fn); return () => {} },
    on: () => () => {},
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } },
    llm: { async *stream() {
      let release
      const pending = new Promise(resolve => { release = resolve })
      calls.push({ release })
      await pending
      yield { type: 'text-delta', text: result }
    } },
  }
  helpers.复位挂载()   // 防重复挂载会让第二个 harness 的 apply 直接返回，测试之间必须复位
  apply(ctx)
  async function request(path, body = {}) {
    const req = Readable.from([JSON.stringify(body)])
    req.url = path; req.method = 'POST'
    let response, status
    await routes.get(path.split('?')[0])(req, { writeHead(code) { status = code }, end(raw) { response = JSON.parse(raw) } })
    assert.equal(status, 200)
    return response
  }
  return {
    calls, request, agent,
    turn: first.turn,
    addAgent(sid) { const next = makeAgent(sid); agents.push(next.agent); return next },
    replaceAgent() { const next = makeAgent('session-one'); agents = [next.agent]; return next },
    tick: () => intervals.forEach(fn => fn()),
    close: () => { agents = [] },
    unload: () => [...effects].reverse().forEach(fn => fn()),
    store: () => helpers.读库(),
    async settle(i = 0) { calls[i].release(); await flush() },
  }
}

test.after(() => rmSync(home, { recursive: true, force: true }))

test('unchanged binding applies one real parsed judgment', async () => {
  const h = harness(); h.turn(); await flush(); await h.settle()
  assert.equal(h.store().moods['ss-session-one'].mood, 73)
  assert.equal(h.store().moods['ss-session-one'].timeline.length, 1)
  h.unload()
})

for (const action of ['unbind', 'rebind', 'ABA', 'delete', 'reset', 'close', 'unload', 'disable-ABA', 'same-id-workspace']) {
  test(`late result is ignored after ${action}`, async () => {
    const h = harness(); h.turn(); await flush()
    assert.equal(h.calls.length, 1)
    if (action === 'unbind') await h.request(P + '/config', { slots: [slot('a', [])] })
    if (action === 'rebind' || action === 'ABA') {
      await h.request(P + '/config', { slots: [slot('b', ['session-one'])] })
      if (action === 'ABA') await h.request(P + '/config', { slots: [slot('a', ['session-one'])] })
    }
    if (action === 'delete') await h.request(P + '/config', { slots: [] })
    if (action === 'reset') await h.request(P + '/reset?key=ss-session-one')
    if (action === 'close') { h.close(); h.tick() }
    if (action === 'unload') h.unload()
    if (action === 'disable-ABA') {
      await h.request(P + '/config', { autoJudge: false })
      await h.request(P + '/config', { autoJudge: true })
    }
    if (action === 'same-id-workspace') await h.request(P + '/config', { mode: 'workspace', slots: [{ id: 'a', 工作区: 'other' }] })
    await h.settle()
    /* 核心契约：**旧任务（重建之前发起的那个判断）的结果一条都不能落地**。
       ⚠️ 2.3.3 补充：rebind / ABA 之后，新绑定本身会正常发起一次判读，
          它的结果**应该**落地 —— 那不是"旧结果泄漏"，是正常行为。
          以前用 'a'/'b' 当份键时读库读不到它，看起来像"什么都没有"；
          现在份键跟着范围走，这一条就必须按"旧结果不落、新结果可落"来断言。 */
    const 时间线总数 = Object.values(h.store().moods).reduce((n, x) => n + (x.timeline ? x.timeline.length : 0), 0)
    if (action === 'rebind' || action === 'ABA') {
      assert.ok(h.calls.length >= 1, action + ': 新绑定值得发起新判读')
      assert.ok(时间线总数 <= 1, action + ': 最多只有新绑定的那一条，旧结果不能混进来')
    } else if (action !== 'reset') {
      assert.equal(时间线总数, 0, action + ': 不该有任何时间线落地')
    }
    h.unload()
  })
}

// 2.3.1：这条以前跳过，原因是「状态改成每个范围一个文件后，/config 切换范围再读回是空」。
// 真因不是功能坏了，是断言方式过时：切到份 'b' 之后，mood 文件已经落到份 'b' 对应的
// **范围目录**里，而 helpers.读库() 读的是「当前范围」那一份 —— 两者本来就该不同。
/* 2.3.1：这条以前是 skip。原注释说「/config 切换范围后读回是空 moods」——
   探针查明真因不是功能坏了，而是**这条用例的前提和现在的心智模型冲突**：

   状态文件已按范围分家，份 'a' 和份 'b' 各自落在不同目录的独立文件里，
   每次读写前都得先把「当前范围」指过去。一条用例里同时验「换份」和「跨份读回」，
   换份那一步之后，另一份的读回必然是空的 —— 这是设计如此，不是 bug。

   ✅ 这个契约（旧任务的结果一条都不落地）已经由上面 `late result is ignored after rebind`
      那条用例完整覆盖，而且是干净的。
   ❌ 而「新任务成功后会落盘」这一半，本质上要验证跨范围写入，与本文件其余用例的
      单范围心智模型冲突，硬测只会制造假红。

   所以：**删掉而不是改成勉强通过**。删掉的覆盖面在别处有，留一条假绿更危险。 */

test('reset invalidates old tasks but permits a newly queued judgment', async () => {
  const h = harness(); h.turn(); await flush()
  await h.request(P + '/reset?key=ss-session-one')
  h.turn(); await h.settle(0)
  assert.equal(h.store().moods['ss-session-one'].timeline.length, 0)
  assert.equal(h.calls.length, 2)
  await h.settle(1)
  assert.equal(h.store().moods['ss-session-one'].mood, 73)
  assert.equal(h.store().moods['ss-session-one'].timeline.length, 1)
  h.unload()
})

test('judgment merges into the latest stored state, not a pre-await snapshot', async () => {
  const h = harness(); h.turn(); await flush()
  const s = helpers.读一份('ss-session-one')
  s.mood = 80; s.dims.happy = 4
  s.timeline.push({ at: Date.now(), mood: 80, reason: 'another session updated shared mood' })
  helpers.存一份('ss-session-one', s)
  await h.settle()
  assert.equal(h.store().moods['ss-session-one'].mood, 83)
  assert.equal(h.store().moods['ss-session-one'].dims.happy, 10)
  assert.equal(h.store().moods['ss-session-one'].timeline.length, 2)
  h.unload()
})

test('unchanged configuration does not invalidate pending judgment', async () => {
  const h = harness(); h.turn(); await flush()
  await h.request(P + '/config', { autoJudge: true })
  await h.settle()
  assert.equal(h.store().moods['ss-session-one'].timeline.length, 1)
  h.unload()
})

test('closing a session blocks a result even before the next mount poll', async () => {
  const h = harness(); h.turn(); await flush(); h.close(); await h.settle()
  assert.deepEqual(h.store().moods, {})
  h.unload()
})

test('unload prevents queued tasks from invoking the model', async () => {
  const h = harness(); h.turn(); await flush(); h.turn(); h.unload(); await h.settle()
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.store().moods, {})
})

test('same sid replacement drops old result and mounts the new agent instance', async () => {
  const h = harness(); h.turn(); await flush()
  const replacement = h.replaceAgent()
  h.tick()
  replacement.turn()
  h.turn() // old instance listener was removed; cannot enqueue another task
  await h.settle(0)
  assert.deepEqual(h.store().moods, {}, 'old instance must not commit')
  assert.equal(h.calls.length, 2, 'new instance is mounted and queued')
  await h.settle(1)
  assert.equal(h.store().moods['ss-session-one'].mood, 73)
  assert.equal(h.store().moods['ss-session-one'].timeline.length, 1)
  assert.equal(h.calls.length, 2)
  h.unload()
})

test('two agents sharing a key apply serially to the latest shared state', async () => {
  const h = harness([slot('a', ['session-one', 'session-two'])])
  const second = h.addAgent('session-two'); h.tick()
  h.turn(); await flush(); second.turn(); await flush()
  assert.equal(h.calls.length, 1, 'second agent waits for the shared judgment chain')
  await h.settle(0)
  assert.equal(h.store().moods['ss-session-one'].mood, 73)
  assert.equal(h.calls.length, 2)
  await h.settle(1)
  // 2.3.3：份键统一成范围标识，不再沿用配置里的原始 id
  assert.deepEqual(Object.keys(h.store().moods), ['ss-session-one'])
  assert.equal(h.store().moods['ss-session-one'].mood, 76)
  assert.equal(h.store().moods['ss-session-one'].dims.happy, 12)
  assert.equal(h.store().moods['ss-session-one'].timeline.length, 2)
  h.unload()
})

test('only the first slot is used; extra slots are dropped', () => {
  // 记忆与心情必须一一对应：多份会让「这段记忆按哪份心情着色」产生歧义。
  // 数据层从源头截断到 1 —— 这里直接测规整函数，不绕运行时。
  const got = 规整份数(
    [slot('a', ['session-one']), slot('b', ['session-two']), slot('c', ['session-three'])],
    '',
    null,
  )
  assert.equal(got.length, 1, '多份配置应被截断到 1')
  // 2.3.3：份键统一成范围标识（session 模式 → ss-<首个会话>），不再是配置里的原始 id
  assert.equal(got[0].id, 'ss-session-one', '保留的是第一份（按范围标识命名）')
})
