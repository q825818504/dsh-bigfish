/**
 * 「设置」板块 —— 伙伴范围（记忆与心情共用）
 * ============================================================================
 * 这是 2.0 的核心：记忆和心情必须指向同一个范围，所以绑定只能配一次。
 * 这里改一次，两边同时写：
 *
 *   记忆 → connection rpc  /api/dafeiyu-memory/settings
 *          { action:'set-binding-mode' } + set-workspace-target / set-session-targets
 *   心情 → POST /dsh-bigfish-mood/config
 *          { 模式, slots:[{ 工作区 | sessions }] }
 *
 * 两个标识的对应关系：
 *   记忆存工作区 UUID；心情存目录名。心情的 /workspaces 同时给出 id 和 name，
 *   所以选一个工作区就能同时写两边，不需要额外映射。
 *
 * 由 tools/build-client.mjs 内联进 client.js（DSH 客户端只能有一个入口文件）。
 * 参数 React / h / 依赖 由外壳注入，本文件不 import 任何东西。
 * ============================================================================
 */
function 创建设置面板(React, h, 依赖) {
  const { rpcCall, fetchJson, postJson } = 依赖

  /* ⭐ 2026-10-31：缓存 + 预取。
     以前每次点「设置」都要等 4 个接口回来才出内容，观感很差。
     现在外壳在启动后先预取一次，面板打开时先拿缓存立即渲染，再后台刷新。 */
  let 缓存 = null

  /** RPC 可能返回 { ok, value } 信封，也可能已被解包 —— 两种都吃 */
  function 解包(r) {
    if (r && typeof r === 'object' && r.value !== undefined && (r.ok === true || r.ok === false)) return r.value
    return r
  }

  async function 拉数据() {
    const [ws, ss, scopeRaw, rootRaw] = await Promise.all([
      fetchJson('/dsh-bigfish-mood/workspaces'),
      fetchJson('/dsh-bigfish-mood/sessions'),
      rpcCall('/api', 'dafeiyu-memory/settings', { action: 'read-scope' }),
      // 老版本没有这个 action，失败就当没设置过，不能连累整个面板
      rpcCall('/api', 'dafeiyu-memory/settings', { action: 'read-data-root' }).catch(() => ({})),
    ])
    const scope = 解包(scopeRaw) || {}
    const rootInfo = 解包(rootRaw) || {}
    const 工作区们 = Array.isArray(ws && ws.workspaces) ? ws.workspaces : []
    const 会话们 = Array.isArray(ss && ss.sessions) ? ss.sessions : []
    // 优先显示「已保存」的那份；还没保存过就用当前生效的
    const s = scope.saved || scope.active || {}
    const 模式 = s.mode === 'session' ? 'session' : 'workspace'
    const 工作区Id = s.workspaceId || ''
    const 命中 = 工作区们.find((x) => x.id && x.id === 工作区Id)
    const 会话 = Array.isArray(s.sessionIds) ? s.sessionIds : []
    // 已保存的和正在生效的不一致 → 说明改过但还没重启
    const a = scope.active || {}
    const 待生效 = !!scope.saved && (
      a.mode !== s.mode ||
      (a.workspaceId || '') !== (s.workspaceId || '') ||
      JSON.stringify(a.sessionIds || []) !== JSON.stringify(s.sessionIds || [])
    )
    return {
      工作区们, 会话们, 模式, 工作区Id,
      工作区: 命中 ? 命中.name : '',
      会话,
      范围路径: (scope && scope.scopePath) || '',
      范围标识: 工作区Id ? 'ws-' + 工作区Id : (会话.length ? 'ss-' + [...会话].sort()[0] : ''),
      待生效,
      配置文件: (scope && scope.path) || '',
      数据根: rootInfo.dataRoot || '',
      默认根: rootInfo.defaultRoot || '',
      根配置文件: rootInfo.storePath || '',
      数据根存在: rootInfo.exists !== false,
    }
  }

  /** 后台预取：外壳启动后调一次，用户点设置时通常已有缓存 */
  async function 预取() {
    try { 缓存 = await 拉数据() } catch (e) { /* 预取失败不影响正常打开 */ }
  }

  const CSS = `
    .bf-set { padding: 20px 24px 32px; max-width: 880px; margin: 0 auto; }
    .bf-set h2 { font-size: 15px; margin: 0 0 4px; font-weight: 600; }
    .bf-set .bf-sub { font-size: 12px; opacity: .6; margin: 0 0 16px; line-height: 1.6; }
    .bf-card { border: 1px solid rgba(127,127,127,.2); border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; }
    .bf-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .bf-row:last-child { margin-bottom: 0; }
    .bf-grow { flex: 1 1 auto; min-width: 0; }
    .bf-label { font-size: 12px; opacity: .6; margin-bottom: 6px; display: block; }
    .bf-seg { display: inline-flex; border: 1px solid rgba(127,127,127,.3); border-radius: 8px; overflow: hidden; }
    .bf-seg button {
      appearance: none; border: 0; background: transparent; color: inherit; cursor: pointer;
      font: inherit; font-size: 13px; padding: 7px 14px;
    }
    .bf-seg button + button { border-left: 1px solid rgba(127,127,127,.2); }
    .bf-seg button[aria-pressed="true"] { background: rgba(127,127,127,.16); font-weight: 600; }
    .bf-select, .bf-input {
      font: inherit; font-size: 13px; padding: 7px 10px; border-radius: 8px; width: 100%;
      border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit;
    }
    .bf-btn {
      appearance: none; font: inherit; font-size: 13px; padding: 8px 16px; border-radius: 8px;
      border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit; cursor: pointer;
    }
    .bf-btn[data-primary] { background: rgba(127,127,127,.18); font-weight: 600; }
    .bf-btn:disabled { opacity: .45; cursor: default; }
    .bf-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .bf-chip {
      font-size: 12px; padding: 4px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit;
    }
    .bf-chip[aria-pressed="true"] { background: rgba(127,127,127,.2); font-weight: 600; }
    .bf-note { font-size: 12px; opacity: .6; line-height: 1.6; }
    .bf-check { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
    .bf-check input { margin: 0; cursor: pointer; }
    .bf-warn { font-size: 12px; color: #d9534f; line-height: 1.6; }
    .bf-ok { font-size: 12px; color: #3c9a5f; }
    .bf-path {
      font-family: ui-monospace, Consolas, monospace; font-size: 11px; opacity: .75;
      word-break: break-all; line-height: 1.6;
    }
  `

  function SettingsPanel() {
    // 有缓存就立即出内容，不显示「读取中」
    const [载入中, set载入中] = React.useState(!缓存)
    const [错误, set错误] = React.useState('')
    const [提示, set提示] = React.useState('')
    const [保存中, set保存中] = React.useState(false)

    const [模式, set模式] = React.useState(缓存 ? 缓存.模式 : 'workspace')
    const [工作区, set工作区] = React.useState(缓存 ? 缓存.工作区 : '')      // 目录名（心情用）
    const [工作区Id, set工作区Id] = React.useState(缓存 ? 缓存.工作区Id : '') // UUID（记忆用）
    const [会话, set会话] = React.useState(缓存 ? 缓存.会话 : [])
    const [工作区们, set工作区们] = React.useState(缓存 ? 缓存.工作区们 : [])
    const [会话们, set会话们] = React.useState(缓存 ? 缓存.会话们 : [])
    const [范围路径, set范围路径] = React.useState(缓存 ? 缓存.范围路径 : '')
    const [范围标识, set范围标识] = React.useState(缓存 ? 缓存.范围标识 : '')
    const [待生效, set待生效] = React.useState(缓存 ? 缓存.待生效 : false)
    const [配置文件, set配置文件] = React.useState(缓存 ? 缓存.配置文件 : '')
    // ⭐ 数据根目录：可以自选（存 <DSH_HOME>/bigfish/root.json，不放在 scope.json 里）
    const [数据根, set数据根] = React.useState(缓存 ? 缓存.数据根 : '')
    const [默认根, set默认根] = React.useState(缓存 ? 缓存.默认根 : '')
    const [根配置文件, set根配置文件] = React.useState(缓存 ? 缓存.根配置文件 : '')
    const [数据根存在, set数据根存在] = React.useState(缓存 ? 缓存.数据根存在 : true)
    const [根保存中, set根保存中] = React.useState(false)
    const [根提示, set根提示] = React.useState('')
    const [根错误, set根错误] = React.useState('')
    // ⭐ 方案 B：保存目录时顺便把现有数据复制过去（只复制不删除，目标必须是空目录）
    const [复制数据, set复制数据] = React.useState(true)
    const [预演, set预演] = React.useState(null)

    const 读全部 = React.useCallback(async () => {
      if (!缓存) set载入中(true)
      set错误(''); set提示('')
      try {
        const d = await 拉数据()
        缓存 = d
        set工作区们(d.工作区们)
        set会话们(d.会话们)
        set模式(d.模式)
        set工作区Id(d.工作区Id)
        set工作区(d.工作区)
        set会话(d.会话)
        set范围路径(d.范围路径)
        set范围标识(d.范围标识)
        set待生效(d.待生效)
        set配置文件(d.配置文件)
        set数据根(d.数据根)
        set默认根(d.默认根)
        set根配置文件(d.根配置文件)
        set数据根存在(d.数据根存在)
      } catch (e) {
        set错误('读取配置失败：' + (e && e.message ? e.message : String(e)))
      } finally {
        set载入中(false)
      }
    }, [])

    React.useEffect(() => { 读全部() }, [读全部])

    const 选工作区 = (name) => {
      const 命中 = 工作区们.find((x) => x.name === name)
      set工作区(name)
      set工作区Id(命中 && 命中.id ? 命中.id : '')
      set提示('')
    }

    const 切换模式 = (m) => { set模式(m); set提示('') }

    const 切换会话 = (sid) => {
      set会话((prev) => (prev.includes(sid) ? prev.filter((x) => x !== sid) : [...prev, sid]))
      set提示('')
    }

    const 保存 = async () => {
      set保存中(true); set错误(''); set提示('')
      try {
        if (模式 === 'workspace' && !工作区Id) throw new Error('还没选工作区')
        if (模式 === 'session' && !会话.length) throw new Error('还没选会话')

        /* ⭐ 只写 scope.json —— 唯一的范围真源。
           不调 set-binding-mode：那会触发热切库 + 回灌，保存变慢，而且一旦
           记忆侧失败、心情侧已写，两边就分叉了。写一个文件，失败就是全失败。 */
        const r = await rpcCall('/api', 'dafeiyu-memory/settings', {
          action: 'write-scope',
          mode: 模式,
          workspaceId: 模式 === 'workspace' ? 工作区Id : '',
          sessionIds: 模式 === 'session' ? 会话 : [],
        })
        if (!r || !r.ok) throw new Error((r && r.note) || '写入 scope.json 失败')

        const 成功话 = '已保存到 scope.json。重启 DSH 后，记忆和心情都会按这个范围工作。'
        set提示(成功话)
        await 读全部()
        set提示(成功话)
      } catch (e) {
        set错误('保存失败：' + (e && e.message ? e.message : String(e)))
      } finally {
        set保存中(false)
      }
    }

    /* ⭐ 预演：输入框变了就去问一下「要复制几个文件、会不会撞车」。
       输入停下来 400ms 才发，避免边打字边打请求。 */
    React.useEffect(() => {
      const v = String(数据根 || '').trim()
      if (!复制数据 || !v || !/^[A-Za-z]:[\\/]|^\\\\|^\//.test(v)) { set预演(null); return }
      let 取消 = false
      const 定时 = setTimeout(async () => {
        try {
          const r = await rpcCall('/api', 'dafeiyu-memory/settings', { action: 'inspect-data-root-move', dataRoot: v })
          const info = 解包(r) || {}
          if (!取消) set预演(info.ok === false ? info : { ...info, ok: true })
        } catch (e) {
          if (!取消) set预演({ ok: false, code: 'inspect-failed', reason: e && e.message ? e.message : String(e) })
        }
      }, 400)
      return () => { 取消 = true; clearTimeout(定时) }
    }, [数据根, 复制数据])

    /* ⭐ 数据根目录保存：写 <DSH_HOME>/bigfish/root.json。
       勾了「同时复制」就先复制、后改配置 —— 复制失败则配置不动，用户还在旧目录里工作。
       这是「下一次启动才生效」：当前实例已经打开了旧路径的库，热切库要处理锁与回灌。 */
    const 保存根 = async () => {
      const v = String(数据根 || '').trim()
      // 只挡明显不是绝对路径的输入，盘符/UNC/斜杠开头都放行
      if (v && !/^[A-Za-z]:[\\/]|^\\\\|^\//.test(v)) {
        set根错误('要填绝对路径，例如 D:\\大肥鱼\\数据')
        return
      }
      if (v && 复制数据 && 预演 && 预演.ok === false) {
        set根错误('目录没法复制：' + (预演.reason || '未知原因') + (预演.conflict && 预演.conflict.length ? '（里面已有：' + 预演.conflict.slice(0, 5).join('、') + '）' : ''))
        return
      }
      set根保存中(true); set根错误(''); set根提示('')
      try {
        const r = await rpcCall('/api', 'dafeiyu-memory/settings', {
          action: 'write-data-root', dataRoot: v, copyData: !!(v && 复制数据),
        })
        const info = 解包(r) || {}
        if (info.ok === false) throw new Error(info.note || info.reason || '写入失败')
        const 话 = info.note || '已保存。重启 DSH 后生效。'
        set根提示(话)
        set预演(null)
        await 读全部()
        set根提示(话)
      } catch (e) {
        set根错误('保存失败：' + (e && e.message ? e.message : String(e)))
      } finally {
        set根保存中(false)
      }
    }

    if (载入中) return h('div', { className: 'bf-set' }, h('p', { className: 'bf-note' }, '读取中…'))

    const 会话名 = (s) => (s && (s.title || s.id)) || String(s)
    const 会话列表 = 会话们.map((s) => (typeof s === 'string' ? { id: s } : s))

    return h('div', { className: 'bf-set' },
      h('style', null, CSS),

      h('h2', null, '伙伴范围'),
      h('p', { className: 'bf-sub' },
        '记忆和心情共用这一个范围，存在 scope.json 里。改一次，重启后两边都按它工作 —— ',
        '所以它们不会指向不同的地方。'),

      h('div', { className: 'bf-card' },
        h('div', { className: 'bf-row' },
          h('div', { className: 'bf-grow' },
            h('span', { className: 'bf-label' }, '按什么认这个范围'),
            h('div', { className: 'bf-seg', role: 'group' },
              h('button', { type: 'button', 'aria-pressed': 模式 === 'workspace' ? 'true' : 'false', onClick: () => 切换模式('workspace') }, '按工作区'),
              h('button', { type: 'button', 'aria-pressed': 模式 === 'session' ? 'true' : 'false', onClick: () => 切换模式('session') }, '按会话')))),

        模式 === 'workspace'
          ? h('div', { className: 'bf-row' },
              h('div', { className: 'bf-grow' },
                h('span', { className: 'bf-label' }, '哪个工作区'),
                h('select', {
                  className: 'bf-select',
                  value: 工作区,
                  onChange: (e) => 选工作区(e.target.value),
                },
                  h('option', { value: '' }, '— 选一个 —'),
                  工作区们.map((w) => h('option', { key: w.name, value: w.name },
                    (w.path || w.label || w.name) + (w.id ? '' : '（缺 UUID，记忆侧可能不认）'))))))
          : h('div', null,
              h('span', { className: 'bf-label' }, '哪些会话（可多选）'),
              h('div', { className: 'bf-chips' },
                会话列表.slice(0, 200).map((s) => h('button', {
                  key: s.id,
                  type: 'button',
                  className: 'bf-chip',
                  'aria-pressed': 会话.includes(s.id) ? 'true' : 'false',
                  onClick: () => 切换会话(s.id),
                }, 会话名(s)))),
              h('p', { className: 'bf-note', style: { marginTop: '8px' } },
                会话.length ? ('已选 ' + 会话.length + ' 个会话') : '还没选会话')),

        h('div', { className: 'bf-row', style: { marginTop: '14px' } },
          h('button', { className: 'bf-btn', 'data-primary': '', type: 'button', disabled: 保存中, onClick: 保存 },
            保存中 ? '保存中…' : '保存范围'),
          h('button', { className: 'bf-btn', type: 'button', disabled: 保存中, onClick: 读全部 }, '重新读取')),

        待生效 ? h('p', { className: 'bf-warn' }, '已保存，但还没重启 —— 现在跑着的仍是旧范围。重启 DSH 后才会切过去。') : null,
        提示 ? h('p', { className: 'bf-ok' }, 提示) : null,
        错误 ? h('p', { className: 'bf-warn' }, 错误) : null,
        配置文件 ? h('p', { className: 'bf-path', style: { marginTop: '8px' } }, 配置文件) : null),

      h('div', { className: 'bf-card' },
        h('h2', null, '数据放在哪'),
        h('p', { className: 'bf-sub' },
          '每个范围一个独立目录，记忆库和心情状态都在里面，文件名也带范围特征 —— ',
          '换范围就是换目录，不会和别的混。'),

        h('span', { className: 'bf-label' }, '数据根目录（可以自己选）'),
        h('div', { className: 'bf-row' },
          h('div', { className: 'bf-grow' },
            h('input', {
              className: 'bf-input',
              type: 'text',
              value: 数据根,
              placeholder: 默认根 || 'D:\\大肥鱼\\数据',
              spellCheck: false,
              autoComplete: 'off',
              onChange: (e) => { set数据根(e.target.value); set根提示(''); set根错误('') },
            })),
          h('button', {
            className: 'bf-btn', 'data-primary': '', type: 'button',
            disabled: 根保存中, onClick: 保存根,
          }, 根保存中 ? '保存中…' : '保存目录'),
          h('button', {
            className: 'bf-btn', type: 'button', disabled: 根保存中,
            onClick: () => { set数据根(''); set根提示(''); set根错误('') },
          }, '恢复默认')),

        h('p', { className: 'bf-note' },
          '留空 = 用默认目录（', 默认根 || '未确定', '）。填绝对路径后写到 ',
          根配置文件 || '<DSH_HOME>/bigfish/root.json', '，重启 DSH 生效。'),

        h('label', { className: 'bf-check', style: { marginTop: '10px' } },
          h('input', {
            type: 'checkbox', checked: 复制数据,
            onChange: (e) => { set复制数据(e.target.checked); set根提示(''); set根错误('') },
          }),
          h('span', null, '同时把现有数据复制到新目录')),

        复制数据
          ? h('p', { className: 'bf-note', style: { marginTop: '4px' } },
              '只复制，不删除：旧目录原地保留，确认新目录能用后你可以自己删。目标目录必须是空的，不会覆盖任何已有文件。')
          : h('p', { className: 'bf-note', style: { marginTop: '4px' } },
              '只改路径，数据留在原处。新目录若是空的，重启后会开一个全新的库 —— 旧记忆看不到。'),

        复制数据 && 预演
          ? (预演.ok === false
              ? h('p', { className: 'bf-warn' },
                  '没法复制：', 预演.reason || '未知原因',
                  预演.conflict && 预演.conflict.length
                    ? '（目标里已有：' + 预演.conflict.slice(0, 5).join('、') + (预演.conflict.length > 5 ? ' 等' : '') + '）'
                    : '')
              : h('p', { className: 'bf-note' },
                  '将复制 ', String(预演.files || 0), ' 个文件，共 ',
                  ((Number(预演.bytes) || 0) / 1048576).toFixed(1), ' MB。'))
          : null,

        数据根 && !数据根存在
          ? h('p', { className: 'bf-warn' }, '这个目录现在还不存在 —— 重启后会按它创建；先确认盘符和路径没写错。')
          : null,
        根提示 ? h('p', { className: 'bf-ok' }, 根提示) : null,
        根错误 ? h('p', { className: 'bf-warn' }, 根错误) : null,

        h('p', { className: 'bf-label', style: { marginTop: '16px' } }, '当前范围标识'),
        h('p', { className: 'bf-path' }, 范围标识 || '（未确定）'),
        h('p', { className: 'bf-label', style: { marginTop: '10px' } }, '记忆库路径'),
        h('p', { className: 'bf-path' }, 范围路径 || '（未确定）'),
        h('p', { className: 'bf-note', style: { marginTop: '10px' } },
          '心情状态在同一个范围目录下，文件名是 mood-<短标识>.json。')),

      h('div', { className: 'bf-card' },
        h('h2', null, '关于一一对应'),
        h('p', { className: 'bf-note' },
          '每段记忆按「它发生那一刻的心情」着色，所以记忆和心情必须指向同一个范围。',
          '这也是心情只有一份的原因：多份会让「这段记忆属于哪份心情」说不清。')))
  }

  // 外壳启动后调一次，把数据提前拉好 —— 用户点「设置」时就不用空等
  SettingsPanel.预取 = 预取

  return SettingsPanel
}
