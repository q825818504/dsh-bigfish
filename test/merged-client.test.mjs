/**
 * 合并客户端入口的装配测试
 * ============================================================================
 * 目的不是测 UI，而是测**装配**：
 *   1. 合并后的 client.js 只注册一个 sidebar.panellist 和一个 main
 *   2. 两个子面板以 embedded 模式启动，不会各自再注册一遍
 *   3. 侧栏 id 与 main 的 key 一致（DSH 靠这个把入口和面板对上）
 *
 * 用 vm 跑浏览器代码，mock 掉 React / document / slots。
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

/** 构造一个够用的 ctx，记录所有 slot 注册 */
function makeCtx() {
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
    slots,
    get(key) { return key === 'slots' ? slots : undefined },
    effect(fn) { if (typeof fn === 'function') fn() },
    locale: {
      register() {},
      bind() { return (k) => k },
    },
    connection: { fetch: async () => ({}) },
    uiWorkspace: {},
    console,
  }
  return { ctx, registered }
}

test('合并入口只注册一个侧栏项和一个主面板', () => {
  const mod = loadFactory()
  assert.equal(mod.id, 'dsh-bigfish', '模块 id 应为合并后的包名')

  const React = makeReact()
  const client = mod.factory((name) => (name === 'react' ? React : undefined))
  assert.ok(client, 'factory 应返回客户端模块')
  assert.ok(Array.isArray(client.inject), 'inject 应为数组')
  assert.equal(typeof client.apply, 'function', 'apply 应为函数')

  const { ctx, registered } = makeCtx()
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
  const mod = loadFactory()
  const React = makeReact()
  const client = mod.factory((name) => (name === 'react' ? React : undefined))
  const { ctx, registered } = makeCtx()
  client.apply(ctx)

  // 如果 embedded 没生效，会出现 dafeiyu-memory / dafeiyu-mood 这两个 id
  const ids = registered.map((r) => r.id || r.key)
  assert.ok(!ids.includes('dafeiyu-memory'), '记忆面板不该再自己注册侧栏')
  assert.ok(!ids.includes('dafeiyu-mood'), '心情面板不该再自己注册侧栏')
  assert.deepEqual(ids, ['dafeiyu', 'dafeiyu'], '只应有两个注册，且都是合并后的 id')
})

test('主面板渲染时不会抛错', () => {
  const mod = loadFactory()
  const React = makeReact()
  const client = mod.factory((name) => (name === 'react' ? React : undefined))
  const { ctx, registered } = makeCtx()
  client.apply(ctx)

  const Shell = registered.find((r) => r.name === 'main').comp
  const tree = Shell()
  assert.ok(tree, 'Shell 应返回元素')
  assert.equal(tree.props.className, 'bf-shell')

  // 结构：tabs + body
  assert.equal(tree.children.length, 2, 'Shell 应有 tabs 与 body 两块')
})
