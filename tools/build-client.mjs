/**
 * 生成合并后的客户端入口 client.js
 * ============================================================================
 * DSH 的客户端插件只能有一个 `window.__ModuleLoader__.load(...)` 入口，且
 * `factory(require)` 的 require 只能拿到宿主白名单里的模块（react 等），
 * 不能 import 同包的其他文件。
 *
 * 所以合并只能落在**一个文件**里。为了不把两个 200KB 级的源文件手工粘在一起
 * （改一次要找半天），这里用脚本从源文件生成产物：
 *
 *     lib/memory/client.js  ┐
 *                           ├──> client.js（本脚本产物，不要手改）
 *     lib/mood/client.js    ┘
 *
 * 两个源文件都已改成「可嵌入」形态：`apply(ctx, { embedded: true })` 时
 * 只创建 Panel、不注册侧栏与主面板，并通过 `getPanel()` 把组件交出来。
 *
 * 用法：node tools/build-client.mjs
 * ============================================================================
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 取 `factory(...) {` 之后、`  },` 之前的函数体（首尾各去掉一行包装） */
function extractFactoryBody(relPath) {
  const src = readFileSync(join(root, relPath), 'utf8')
  const lines = src.split('\n').map((l) => l.replace(/\r$/, ''))

  // 只在 `window.__ModuleLoader__.load({` 之后找 factory，
  // 避免命中文件头注释里举例的那句 `factory: (require) => ...`
  const loadLine = lines.findIndex((l) => l.includes('window.__ModuleLoader__.load'))
  if (loadLine < 0) throw new Error(`${relPath}: 找不到 __ModuleLoader__.load`)
  const factoryLine = lines.findIndex((l, i) => i > loadLine && /^\s*factory\s*[:(]/.test(l))
  if (factoryLine < 0) throw new Error(`${relPath}: 找不到 factory`)

  // 末尾结构固定（文件以换行结尾，所以末尾多一个空串）：
  //   倒数 1 行：空串
  //   倒数 2 行：}) / });
  //   倒数 3 行：},              ← factory 结束
  //   倒数 4 行：};  /  }        ← return 收尾
  // 函数体要包含到「return 收尾行」，所以截止到倒数第三行（不含）。
  const endLine = lines.length - 3
  if (endLine <= factoryLine) throw new Error(`${relPath}: factory 体为空`)

  return lines.slice(factoryLine + 1, endLine).join('\n')
}

const memoryBody = extractFactoryBody('lib/memory/client.js')
const moodBody = extractFactoryBody('lib/mood/client.js')
const settingsSrc = readFileSync(join(root, 'lib/shell/settings.js'), 'utf8')

const out = `/**
 * dsh-bigfish —— 合并后的客户端入口（构建产物，请勿手改）
 * ============================================================================
 * 由 tools/build-client.mjs 从以下两个源文件生成：
 *   · lib/memory/client.js  （记忆面板）
 *   · lib/mood/client.js    （心情面板）
 *
 * 结构：
 *   一个 sidebar.panellist 入口（id = dafeiyu，显示「大肥鱼」）
 *   一个 main 面板，内部按板块切换：记忆 / 心情
 *
 * 两个子面板各自在 IIFE 里隔离，互不污染变量；样式前缀分别是 dfm- 与 fm-，
 * 不会互相覆盖。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bigfish',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /* ======================================================================
     * 记忆板块
     * ==================================================================== */
    const memoryModule = (function () {
${memoryBody}
    })()

    /* ======================================================================
     * 心情板块
     * ==================================================================== */
    const moodModule = (function () {
${moodBody}
    })()

    /* ======================================================================
     * 外壳：一个侧栏入口 + 板块切换
     * ==================================================================== */
    const PANEL_ID = 'dafeiyu'
    const NAV_LABEL = '大肥鱼'

    let MemoryPanel = null
    let MoodPanel = null
    let SettingsPanel = null

    /* ── 设置面板：源文件 lib/shell/settings.js，构建时内联 ──
       它定义一个 创建设置面板(React, h, 依赖) 工厂，依赖在 apply 里注入
       （需要 ctx.connection 才能调记忆的 rpc）。 */
${settingsSrc}

    const TABS = [
      { key: 'memory', label: '记忆' },
      { key: 'mood', label: '心情' },
      { key: 'settings', label: '设置' },
    ]

    const SHELL_CSS = \`
      .bf-shell { display: flex; flex-direction: column; height: 100%; min-height: 0; }
      .bf-tabs {
        display: flex; gap: 4px; padding: 12px 20px 0; flex: 0 0 auto;
        border-bottom: 1px solid rgba(127,127,127,.18);
      }
      .bf-tab {
        appearance: none; border: 0; background: transparent; cursor: pointer;
        font: inherit; font-size: 14px; line-height: 1;
        padding: 9px 14px 10px; border-radius: 8px 8px 0 0;
        color: inherit; opacity: .58;
        border-bottom: 2px solid transparent; margin-bottom: -1px;
        transition: opacity .12s ease, background-color .12s ease;
      }
      .bf-tab:hover { opacity: .85; background: rgba(127,127,127,.08); }
      .bf-tab:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; opacity: .9; }
      .bf-tab-active { opacity: 1; border-bottom-color: currentColor; font-weight: 600; }
      .bf-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
      .bf-empty { padding: 48px 24px; text-align: center; opacity: .55; font-size: 14px; }
      @media (prefers-reduced-motion: reduce) { .bf-tab { transition: none; } }
    \`

    function Shell() {
      const [tab, setTab] = React.useState('memory')
      const Active = tab === 'memory' ? MemoryPanel : tab === 'mood' ? MoodPanel : SettingsPanel
      return h('div', { className: 'bf-shell' },
        h('div', { className: 'bf-tabs', role: 'tablist', 'aria-label': '大肥鱼板块' },
          TABS.map((t) => h('button', {
            key: t.key,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === t.key ? 'true' : 'false',
            className: 'bf-tab' + (tab === t.key ? ' bf-tab-active' : ''),
            onClick: () => setTab(t.key),
          }, t.label))),
        h('div', { className: 'bf-body', role: 'tabpanel' },
          Active ? h(Active) : h('div', { className: 'bf-empty' }, '加载中…')))
    }

    function SidebarIcon() {
      return h('svg', {
        viewBox: '0 0 64 64', width: 20, height: 20, fill: 'none',
        stroke: 'currentColor', strokeWidth: 3.2,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
        // 鱼身
        h('path', { d: 'M40 32c0 8-7 14-16 14S8 40 8 32s7-14 16-14 16 6 16 14Z' }),
        // 尾巴
        h('path', { d: 'M40 32 52 22v20L40 32Z' }),
        // 眼睛
        h('circle', { cx: 20, cy: 28, r: 2.2, fill: 'currentColor', stroke: 'none' }))
    }

    return {
      /* inject 必须覆盖两个子面板用到的全部服务。
         这里**从子模块自身的 inject 取并集**，而不是手写 —— 否则子模块哪天多用
         一个服务（比如 locale），外壳不知道，运行时 ctx.locale 就是 undefined，
         cordis 直接判定这个 entry 激活失败，整个客户端起不来。
         这就是 2026-10-31 第一次安装时 "web boot: 1 entry did not activate" 的原因。 */
      inject: [...new Set(['slots', ...memoryModule.inject, ...moodModule.inject])],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bigfish')
        style.textContent = SHELL_CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bigfish: 外壳样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        // 两个子面板以嵌入模式启动：挂样式、建 Panel，但不注册侧栏
        memoryModule.apply(ctx, { embedded: true })
        moodModule.apply(ctx, { embedded: true })
        MemoryPanel = memoryModule.getPanel()
        MoodPanel = moodModule.getPanel()

        // 设置面板：记忆走 connection rpc，心情走 HTTP（两套都是现成的）
        SettingsPanel = 创建设置面板(React, h, {
          rpcCall: (channel, endpoint, payload) => ctx.connection.rpc.call(channel, endpoint, payload),
          fetchJson: (url) => fetch(url, { headers: { accept: 'application/json' } }).then((r) => r.json()),
          postJson: (url, body) => fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          }).then((r) => r.json()),
        })

        // 启动 1.5 秒后后台预取设置数据 —— 用户点「设置」时通常已有缓存，
        // 不会先看到一片「读取中」。
        try {
          setTimeout(() => { try { SettingsPanel.预取() } catch (e) { /* 预取失败不影响打开 */ } }, 1500)
        } catch (e) { /* 环境没有 setTimeout 就算了 */ }

        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: NAV_LABEL,
        }, SidebarIcon))

        slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
        }, Shell))
      },
    }
  },
})
`

writeFileSync(join(root, 'client.js'), out, 'utf8')
console.log(`已生成 client.js（${(out.length / 1024).toFixed(1)} KB）`)
