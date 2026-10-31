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
    .bf-warn { font-size: 12px; color: #d9534f; line-height: 1.6; }
    .bf-ok { font-size: 12px; color: #3c9a5f; }
    .bf-path {
      font-family: ui-monospace, Consolas, monospace; font-size: 11px; opacity: .75;
      word-break: break-all; line-height: 1.6;
    }
  `

  function SettingsPanel() {
    const [载入中, set载入中] = React.useState(true)
    const [错误, set错误] = React.useState('')
    const [提示, set提示] = React.useState('')
    const [保存中, set保存中] = React.useState(false)

    const [模式, set模式] = React.useState('workspace')
    const [工作区, set工作区] = React.useState('')        // 目录名（心情用）
    const [工作区Id, set工作区Id] = React.useState('')    // UUID（记忆用）
    const [会话, set会话] = React.useState([])
    const [工作区们, set工作区们] = React.useState([])
    const [会话们, set会话们] = React.useState([])
    const [范围路径, set范围路径] = React.useState('')
    const [范围标识, set范围标识] = React.useState('')

    const 读全部 = React.useCallback(async () => {
      set载入中(true); set错误(''); set提示('')
      try {
        const [ws, ss, mem, mood] = await Promise.all([
          fetchJson('/dsh-bigfish-mood/workspaces'),
          fetchJson('/dsh-bigfish-mood/sessions'),
          rpcCall('/api', 'dafeiyu-memory/settings', { action: 'read' }),
          fetchJson('/dsh-bigfish-mood/config'),
        ])
        set工作区们(Array.isArray(ws && ws.workspaces) ? ws.workspaces : [])
        set会话们(Array.isArray(ss && ss.sessions) ? ss.sessions : [])

        // 以记忆的绑定为准（它存 UUID，更权威），再回填心情那一侧的目录名
        const m = (mem && mem.bindingMode) || (mood && mood.config && mood.config.模式) || 'workspace'
        set模式(m)
        const wsId = (mem && mem.bindingWorkspaceId) || ''
        set工作区Id(wsId)
        const 命中 = (Array.isArray(ws && ws.workspaces) ? ws.workspaces : []).find((x) => x.id && x.id === wsId)
        set工作区(命中 ? 命中.name : '')

        const ids = (mem && Array.isArray(mem.bindingSessionIds)) ? mem.bindingSessionIds : []
        set会话(ids)

        set范围路径((mem && mem.scopePath) || '')
        set范围标识(wsId ? 'ws-' + wsId : (ids.length ? 'ss-' + [...ids].sort()[0] : ''))
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
        // ── 1. 先写记忆 ──────────────────────────────────────────────
        await rpcCall('/api', 'dafeiyu-memory/settings', { action: 'set-binding-mode', bindingMode: 模式 })
        if (模式 === 'workspace') {
          if (!工作区Id) throw new Error('还没选工作区')
          await rpcCall('/api', 'dafeiyu-memory/settings', { action: 'set-workspace-target', workspaceId: 工作区Id })
        } else {
          if (!会话.length) throw new Error('还没选会话')
          await rpcCall('/api', 'dafeiyu-memory/settings', { action: 'set-session-targets', sessionIds: 会话 })
        }

        // ── 2. 再写心情（记忆成功才写，避免两边不一致）────────────
        await postJson('/dsh-bigfish-mood/config', {
          模式,
          slots: [{
            id: '',                       // 留空：由心情侧按范围自动生成 ws-<uuid>
            label: '',
            selfName: '',
            ownerName: '',
            工作区: 模式 === 'workspace' ? 工作区 : '',
            sessions: 模式 === 'session' ? 会话 : [],
          }],
        })

        set提示('已保存。记忆和心情都指向这个范围了。')
        await 读全部()
        set提示('已保存。记忆和心情都指向这个范围了。')
      } catch (e) {
        set错误('保存失败：' + (e && e.message ? e.message : String(e)) + '（两边可能只写了一半，请重试）')
      } finally {
        set保存中(false)
      }
    }

    if (载入中) return h('div', { className: 'bf-set' }, h('p', { className: 'bf-note' }, '读取中…'))

    const 会话名 = (s) => (s && (s.title || s.id)) || String(s)
    const 会话列表 = 会话们.map((s) => (typeof s === 'string' ? { id: s } : s))

    return h('div', { className: 'bf-set' },
      h('style', null, CSS),

      h('h2', null, '伙伴范围'),
      h('p', { className: 'bf-sub' },
        '记忆和心情共用这一个范围。改一次，两边同时生效 —— ',
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
            保存中 ? '保存中…' : '保存并让两边同时生效'),
          h('button', { className: 'bf-btn', type: 'button', disabled: 保存中, onClick: 读全部 }, '重新读取')),

        提示 ? h('p', { className: 'bf-ok' }, 提示) : null,
        错误 ? h('p', { className: 'bf-warn' }, 错误) : null),

      h('div', { className: 'bf-card' },
        h('h2', null, '数据放在哪'),
        h('p', { className: 'bf-sub' },
          '每个范围一个独立目录，记忆库和心情状态都在里面，文件名也带范围特征 —— ',
          '换范围就是换目录，不会和别的混。'),
        h('p', { className: 'bf-label' }, '当前范围标识'),
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

  return SettingsPanel
}
