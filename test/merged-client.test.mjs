/**
 * 合并客户端入口的装配测试
 * ============================================================================
 * 目的不是测 UI，而是测**装配**：
 *   1. 合并后的 client.js 只注册一个 sidebar.panellist 和一个 main
 *   2. 两个子面板以 embedded 模式启动，不会各自再注册一遍
 *   3. 侧栏 id 与 main 的 key 一致（DSH 靠这个把入口和面板对上）
 *   4. **inject 覆盖两个子面板用到的全部服务** —— 这条是 2026-10-31 线上事故的回归测试
 *
 * 第 4 条的由来：第一次合并时外壳只声明了 `inject: ['slots']`，但记忆面板在 apply 里
 * 用了 `ctx.locale.register(...)`。cordis 只把 inject 里声明的服务挂到 ctx 上，
 * 所以 `ctx.locale` 是 undefined，apply 抛错，整个客户端 entry 激活失败，
 * DSH 直接起不来（报 `web boot: 1 entry did not activate / dsh-bigfish: failed`）。
 *
 * 因此这里的 mock ctx **只提供 inject 里声明的服务**，与真实环境同构。
 * 跑法：node test/merged-client.test.mjs
 * ============================================================================
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const src = readFileSync(join(root, 'client.js'), 'utf8')

/** 极简 React mock：只要能造元素、能用 useState 就够 */
function makeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      return [initial, () => {}]
    },
    useEffect() {},
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    useRef(v) { return { current: v } },
  }
}

/** 极简 document mock */
function makeDocument() {
  const styles = []
  return {
    styles,
    head: {
      appendChild(node) { styles.push(node) },
    },
    createElement() {
      return {
        _attrs: {},
        style: {},
        setAttribute(k, v) { this._attrs[k] = v },
        remove() { const i = styles.indexOf(this); if (i >= 0) styles.splice(i, 1) },
        set textContent(v) { this._text = v },
        get textContent() { return this._text },
      }
    },
  }
}

/** 加载 client.js，返回它的 factory */
function loadFactory() {
  let captured = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) { captured = mod },
      },
    },
    document: makeDocument(),
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  assert.ok(captured, 'client.js 应调用 __ModuleLoader__.load')
  return captured
}

/**
 * 构造一个**与 cordis 同构**的 ctx：
 * 只有 inject 里声明过的服务才会挂在 ctx 上，其余为 undefined。
 * 这样 inject 少写一个，apply 就会在这里抛错，而不是等到线上。
 */
function makeCtx(injectList) {
  const declared = new Set(injectList)
  const registered = []

  const slots = {
    inject(name, thunk) {
      if (typeof thunk === 'function') thunk()
    },
    register(desc, comp) {
      registered.push({ ...desc, comp })
      return { ...desc, comp }
    },
  }

  const ctx = {
    get(key) {
      if (!declared.has(key)) return undefined
      return key === 'slots' ? slots : undefined
    },
    effect(fn) { if (typeof fn === 'function') fn() },
    console,
  }

  if (declared.has('slots')) ctx.slots = slots
  if (declared.has('locale')) {
    ctx.locale = {
      register() {},
      bind() { return (k) => k },
    }
  }
  if (declared.has('connection')) {
    ctx.connection = { fetch: async () => ({}), rpc: { call: async () => ({}) } }
  }
  if (declared.has('uiWorkspace')) {
    ctx.uiWorkspace = {
      listDirectory: async () => ({ entries: [] }),
      createDirectory: async () => ({}),
    }
  }

  return { ctx, registered }
}

/** 载入并返回 client 模块 */
function loadClient() {
  const mod = loadFactory()
  const React = makeReact()
  return { mod, client: mod.factory((name) => (name === 'react' ? React : undefined)) }
}

test('合并入口只注册一个侧栏项和一个主面板', () => {
  const { mod, client } = loadClient()
  assert.equal(mod.id, 'dsh-bigfish', '模块 id 应为合并后的包名')
  assert.ok(Array.isArray(client.inject), 'inject 应为数组')
  assert.equal(typeof client.apply, 'function', 'apply 应为函数')

  const { ctx, registered } = makeCtx(client.inject)
  client.apply(ctx)

  const sidebars = registered.filter((r) => r.name === 'sidebar.panellist')
  const mains = registered.filter((r) => r.name === 'main')

  assert.equal(sidebars.length, 1, '侧栏项必须只有一个（否则就是没合并干净）')
  assert.equal(mains.length, 1, '主面板必须只有一个')

  assert.equal(sidebars[0].id, 'dafeiyu', '侧栏 id 应为 dafeiyu')
  assert.equal(mains[0].key, 'dafeiyu', 'main 的 key 必须与侧栏 id 一致')
  assert.equal(sidebars[0].label, '大肥鱼', '侧栏显示名应为「大肥鱼」')
  assert.equal(typeof sidebars[0].comp, 'function', '侧栏图标应是一个组件')
  assert.equal(typeof mains[0].comp, 'function', '主面板应是一个组件')
})

test('两个子面板都以 embedded 模式启动，没有各自注册', () => {
  const { client } = loadClient()
  const { ctx, registered } = makeCtx(client.inject)
  client.apply(ctx)

  const ids = registered.map((r) => r.id || r.key)
  assert.ok(!ids.includes('dafeiyu-memory'), '记忆面板不该再自己注册侧栏')
  assert.ok(!ids.includes('dafeiyu-mood'), '心情面板不该再自己注册侧栏')
  assert.deepEqual(ids, ['dafeiyu', 'dafeiyu'], '只应有两个注册，且都是合并后的 id')
})

test('主面板渲染时不会抛错', () => {
  const { client } = loadClient()
  const { ctx, registered } = makeCtx(client.inject)
  client.apply(ctx)

  const Shell = registered.find((r) => r.name === 'main').comp
  const tree = Shell()
  assert.ok(tree, 'Shell 应返回元素')
  assert.equal(tree.props.className, 'bf-shell')
  assert.equal(tree.children.length, 2, 'Shell 应有 tabs 与 body 两块')
})

/**
 * 回归测试：inject 必须覆盖两个子面板用到的全部服务。
 * 少写一个，apply 会在真实环境抛错并导致整个客户端起不来。
 */
test('inject 覆盖两个子面板用到的全部服务', () => {
  const { client } = loadClient()

  // 记忆面板的 apply 会调 ctx.locale.register / ctx.locale.bind；
  // 它的组件渲染时会用 ctx.connection.rpc 与 ctx.uiWorkspace。
  for (const svc of ['slots', 'locale', 'connection', 'uiWorkspace']) {
    assert.ok(
      client.inject.includes(svc),
      `inject 缺少 "${svc}"。缺了它 cordis 不会把该服务挂到 ctx 上，` +
        '子面板 apply 时会拿到 undefined 并抛错，整个客户端 entry 激活失败。',
    )
  }
})

/**
 * 反向验证：如果 inject 真的少了 locale，apply 必须抛错。
 * 这条不是测产品行为，是证明上面那个断言确实能拦住事故。
 */
test('主面板有记忆 / 心情 / 设置三个板块', () => {
  const { client } = loadClient()
  const { ctx, registered } = makeCtx(client.inject)
  client.apply(ctx)

  const Shell = registered.find((r) => r.name === 'main').comp
  const tree = Shell()

  // mock 的 createElement 产出普通对象，直接序列化找三个标签最稳
  const 全树 = JSON.stringify(tree)
  for (const label of ['记忆', '心情', '设置']) {
    assert.ok(全树.includes('"' + label + '"'), '板块缺少：' + label)
  }
})
test('inject 缺少 locale 时 apply 会抛错（证明约束有效）', () => {
  const { client } = loadClient()
  const broken = client.inject.filter((s) => s !== 'locale')
  const { ctx } = makeCtx(broken)

  assert.throws(
    () => client.apply(ctx),
    '少了 locale 时应当抛错，否则说明 mock 没有与 cordis 同构',
  )
})
