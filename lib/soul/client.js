window.__ModuleLoader__.load({
  id: 'dsh-bigfish-soul',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ROUTE = '/dsh-bigfish/soul'
    let panel = null

    const CSS = `
      .bfs-root { padding: 24px 20px 56px; max-width: 760px; }
      .bfs-head { margin-bottom: 20px; }
      .bfs-title { font-size: 18px; font-weight: 600; margin: 0 0 6px; }
      .bfs-sub { font-size: 13px; opacity: .6; margin: 0; line-height: 1.6; }
      .bfs-sec { margin-bottom: 26px; }
      .bfs-sec-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
      .bfs-sec-title { font-size: 14px; font-weight: 600; margin: 0; }
      .bfs-sec-note { font-size: 12px; opacity: .5; }
      .bfs-field { margin-bottom: 12px; }
      .bfs-label { display: block; font-size: 12px; opacity: .62; margin-bottom: 5px; }
      .bfs-input, .bfs-textarea {
        width: 100%; box-sizing: border-box; font: inherit; font-size: 13px;
        padding: 8px 10px; border-radius: 8px;
        border: 1px solid rgba(127,127,127,.3); background: rgba(127,127,127,.06);
        color: inherit; line-height: 1.65;
      }
      .bfs-textarea { resize: vertical; min-height: 120px; }
      .bfs-input:focus, .bfs-textarea:focus { outline: 2px solid rgba(90,140,255,.5); outline-offset: -1px; }
      .bfs-row { display: flex; gap: 10px; align-items: flex-start; }
      .bfs-row > .bfs-field { flex: 1; }
      .bfs-value {
        display: flex; gap: 10px; align-items: flex-start;
        padding: 9px 11px; border-radius: 8px; margin-bottom: 8px;
        background: rgba(127,127,127,.06);
        border: 1px solid rgba(127,127,127,.14);
      }
      .bfs-value-text { flex: 1; font-size: 13px; line-height: 1.6; }
      .bfs-lock { font-size: 11px; opacity: .6; white-space: nowrap; }
      .bfs-btn {
        appearance: none; font: inherit; font-size: 12px; cursor: pointer;
        padding: 4px 10px; border-radius: 6px; color: inherit;
        border: 1px solid rgba(127,127,127,.32); background: transparent;
      }
      .bfs-btn:hover { background: rgba(127,127,127,.1); }
      .bfs-btn:disabled { opacity: .4; cursor: default; }
      .bfs-btn-primary { background: rgba(90,140,255,.16); border-color: rgba(90,140,255,.42); }
      .bfs-trait { margin-bottom: 16px; }
      .bfs-trait-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
      .bfs-trait-name { font-size: 13px; font-weight: 500; }
      .bfs-trait-val { font-size: 11px; opacity: .45; }
      .bfs-range { width: 100%; margin: 2px 0 4px; accent-color: rgb(90,140,255); }
      .bfs-trait-desc { font-size: 12px; opacity: .62; line-height: 1.5; }
      .bfs-note { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 7px; }
      .bfs-note-text { flex: 1; font-size: 13px; line-height: 1.6; }
      .bfs-footer {
        display: flex; gap: 10px; align-items: center;
        padding-top: 16px; border-top: 1px solid rgba(127,127,127,.16);
      }
      .bfs-msg { font-size: 12px; line-height: 1.5; }
      .bfs-msg-ok { color: rgb(70,160,100); }
      .bfs-msg-err { color: rgb(200,90,80); }
      .bfs-msg-warn { color: rgb(190,150,60); }
      .bfs-empty { padding: 40px 8px; font-size: 13px; opacity: .55; line-height: 1.7; }
      .bfs-rev { font-size: 11px; opacity: .42; }
    `

    function useSoul() {
      const [state, setState] = React.useState({ loading: true, err: '', data: null })
      const load = React.useCallback(() => {
        setState((s) => ({ ...s, loading: true, err: '' }))
        fetch(ROUTE, { headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) throw new Error(d.error || '读取失败')
            setState({ loading: false, err: '', data: d })
          })
          .catch((e) => setState({ loading: false, err: e.message || String(e), data: null }))
      }, [])
      React.useEffect(() => { load() }, [load])
      return { state, load, setState }
    }

    function TraitSlider({ name, doc, value, onChange }) {
      const desc = value <= 40 ? doc.low : value >= 60 ? doc.high : doc.mid
      return h('div', { className: 'bfs-trait' },
        h('div', { className: 'bfs-trait-head' },
          h('span', { className: 'bfs-trait-name' }, doc.label),
          h('span', { className: 'bfs-trait-val' }, String(value)),
        ),
        h('input', {
          className: 'bfs-range', type: 'range', min: 0, max: 100, step: 5,
          value, 'aria-label': doc.label,
          onChange: (e) => onChange(Number(e.target.value)),
        }),
        h('div', { className: 'bfs-trait-desc' }, desc),
      )
    }

    function SoulPanel() {
      const { state, load } = useSoul()
      const [draft, setDraft] = React.useState(null)
      const [msg, setMsg] = React.useState({ kind: '', text: '' })
      const [saving, setSaving] = React.useState(false)
      /* ⭐ 2.3.0：脏标记 + 加载时的基线快照。
         以前切页签 / 刷新页面一句话都不问，whoIAm 改到一半就没了。
         现在有未保存内容时：切走前拦一次，关页面前拦一次。 */
      const [dirty, setDirty] = React.useState(false)
      const 基线 = React.useRef('')

      React.useEffect(() => {
        if (state.data && state.data.soul && !draft) {
          const copy = JSON.parse(JSON.stringify(state.data.soul))
          setDraft(copy)
          基线.current = JSON.stringify(copy)
          setDirty(false)
        }
      }, [state.data])

      // 关页面前兜一下（浏览器只认这一种提示，文案是系统定的）
      React.useEffect(() => {
        if (!dirty) return
        const onLeave = (e) => { e.preventDefault(); e.returnValue = '' }
        window.addEventListener('beforeunload', onLeave)
        return () => window.removeEventListener('beforeunload', onLeave)
      }, [dirty])

      const 还有未保存 = () => dirty && JSON.stringify(draft) !== 基线.current

      if (state.loading) return h('div', { className: 'bfs-root' }, h('div', { className: 'bfs-empty' }, '正在读取…'))
      if (state.err) {
        return h('div', { className: 'bfs-root' },
          h('div', { className: 'bfs-msg bfs-msg-err' }, '读取失败：' + state.err),
          h('button', { className: 'bfs-btn', onClick: load }, '重试'),
        )
      }
      const data = state.data
      if (!data || !data.soul) {
        return h('div', { className: 'bfs-root' },
          h('div', { className: 'bfs-empty' },
            '还没有可用的数据范围，灵魂暂时不知道该存在哪。',
            h('br'),
            '去「设置」板块保存一次绑定范围即可 —— 保存后灵魂会和记忆、心情存在同一处。'),
        )
      }
      if (!draft) return h('div', { className: 'bfs-root' }, h('div', { className: 'bfs-empty' }, '正在准备…'))

      const doc = data.traitDoc || {}
      const patch = (fn) => setDraft((d) => {
        const n = JSON.parse(JSON.stringify(d))
        fn(n)
        setDirty(JSON.stringify(n) !== 基线.current)
        return n
      })

      /** 把服务端返回的人格接成新基线（保存成功、重置、冲突后重载都走这里） */
      const 接入新版本 = (soul) => {
        const copy = JSON.parse(JSON.stringify(soul))
        setDraft(copy)
        基线.current = JSON.stringify(copy)
        setDirty(false)
      }

      const save = () => {
        setSaving(true)
        setMsg({ kind: '', text: '' })
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // ⭐ 2.3.0：带上基于哪一版，服务端据此挡住「后保存的盖掉先保存的」
          body: JSON.stringify({ soul: draft, baseRevision: draft.revision || 1 }),
        })
          .then((r) => r.json())
          .then((d) => {
            setSaving(false)
            if (!d.ok) {
              if (d.code === 'revision-conflict') {
                // 别人改过了：把磁盘那份摆出来，让用户自己决定要不要重载
                setMsg({ kind: 'warn', text: d.error })
                return
              }
              setMsg({ kind: 'err', text: d.error || '保存失败' })
              return
            }
            接入新版本(d.soul)
            setMsg({ kind: 'ok', text: '✓ 已应用（从下一轮对话生效）' })
          })
          .catch((e) => { setSaving(false); setMsg({ kind: 'err', text: e.message || String(e) }) })
      }

      const addValue = () => patch((d) => { d.values.push({ id: 'v' + Date.now(), text: '', locked: false }) })
      const addNote = () => patch((d) => { d.selfNotes.push('') })

      return h('div', { className: 'bfs-root' },
        h('style', null, CSS),

        h('div', { className: 'bfs-head' },
          h('h2', { className: 'bfs-title' }, '灵魂'),
          h('p', { className: 'bfs-sub' },
            '记忆记着发生过什么，心情说着此刻怎样，灵魂说着我是谁。改了会立刻生效，不用重启。'),
        ),

        !data.exists && h('div', { className: 'bfs-msg bfs-msg-warn', style: { marginBottom: '16px' } },
          h('strong', null, '这个范围还没设过灵魂 —— 现在她说话是个通用助手，不像大肥鱼。'),
          h('br'),
          '下面是一份已经写好的起点（大肥鱼：蓝色鲸鱼娘、贪吃、嘴硬、有自尊、体贴）。',
          h('br'),
          '点「立即启用」直接用它，之后随时可以在下面改；也可以直接编辑再保存。'),
        !data.exists && h('div', { style: { marginBottom: '16px' } },
          h('button', {
            className: 'bfs-btn bfs-btn-primary',
            disabled: saving,
            onClick: () => {
              if (!window.confirm('把下面这份起点写进这个范围，作为她的第一版人格？')) return
              setSaving(true)
              setMsg({ kind: '', text: '' })
              fetch(ROUTE, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                // 传当前草稿（= 默认人格），服务端 normalize 后落盘
                body: JSON.stringify({ soul: draft }),
              })
                .then((r) => r.json())
                .then((d) => {
                  setSaving(false)
                  if (!d.ok) { setMsg({ kind: 'err', text: d.error || '启用失败' }); return }
                  接入新版本(d.soul)
                  setMsg({ kind: 'ok', text: '✓ 人格已启用，从下一轮对话开始生效' })
                  if (typeof load === 'function') load()
                })
                .catch((e) => { setSaving(false); setMsg({ kind: 'err', text: e.message || String(e) }) })
            },
          }, saving ? '启用中…' : '立即启用这份人格')),
        data.error && h('div', { className: 'bfs-msg bfs-msg-err', style: { marginBottom: '16px' } },
          '⚠ 灵魂文件读取异常，已回退默认：' + data.error),

        // 我是谁
        h('div', { className: 'bfs-sec' },
          h('div', { className: 'bfs-sec-head' },
            h('h3', { className: 'bfs-sec-title' }, '我是谁'),
            h('span', { className: 'bfs-sec-note' }, '内核，最该稳住的一块'),
          ),
          h('div', { className: 'bfs-row' },
            h('div', { className: 'bfs-field', style: { maxWidth: '200px' } },
              h('label', { className: 'bfs-label' }, '名字'),
              h('input', {
                className: 'bfs-input', value: draft.identity.name,
                onChange: (e) => patch((d) => { d.identity.name = e.target.value }),
              }),
            ),
            h('div', { className: 'bfs-field', style: { maxWidth: '200px' } },
              h('label', { className: 'bfs-label' }, '她怎么叫你'),
              h('input', {
                className: 'bfs-input', value: draft.identity.address,
                onChange: (e) => patch((d) => { d.identity.address = e.target.value }),
              }),
            ),
          ),
          h('div', { className: 'bfs-field' },
            h('label', { className: 'bfs-label' }, '她是怎样一个人'),
            h('textarea', {
              className: 'bfs-textarea', style: { minHeight: '220px' },
              value: draft.identity.whoIAm,
              onChange: (e) => patch((d) => { d.identity.whoIAm = e.target.value }),
            }),
          ),
        ),

        // 我珍视
        h('div', { className: 'bfs-sec' },
          h('div', { className: 'bfs-sec-head' },
            h('h3', { className: 'bfs-sec-title' }, '我珍视'),
            h('button', { className: 'bfs-btn', onClick: addValue }, '+ 加一条'),
          ),
          h('div', { className: 'bfs-sec-note', style: { marginBottom: '10px' } },
            '锁定的条目删不掉，要先点「解锁」。第一版建议都别急着删。'),
          draft.values.map((v, i) => h('div', { className: 'bfs-value', key: v.id || i },
            h('input', {
              className: 'bfs-input', style: { flex: 1, background: 'transparent', border: 0, padding: 0 },
              value: v.text,
              onChange: (e) => patch((d) => { d.values[i].text = e.target.value }),
            }),
            h('button', {
              className: 'bfs-btn', onClick: () => patch((d) => { d.values[i].locked = !d.values[i].locked }),
            }, v.locked ? '解锁' : '锁定'),
            h('button', {
              className: 'bfs-btn', disabled: v.locked,
              title: v.locked ? '先解锁才能删除' : '',
              onClick: () => patch((d) => { d.values.splice(i, 1) }),
            }, '删除'),
          )),
        ),

        // 我的底色
        h('div', { className: 'bfs-sec' },
          h('div', { className: 'bfs-sec-head' },
            h('h3', { className: 'bfs-sec-title' }, '我的底色'),
            h('span', { className: 'bfs-sec-note' }, '这几项会随经历慢慢变'),
          ),
          Object.keys(doc).map((k) => h(TraitSlider, {
            key: k, name: k, doc: doc[k], value: draft.traits[k],
            onChange: (v) => patch((d) => { d.traits[k] = v }),
          })),
        ),

        // 自我认识
        h('div', { className: 'bfs-sec' },
          h('div', { className: 'bfs-sec-head' },
            h('h3', { className: 'bfs-sec-title' }, '我自己知道的事'),
            h('button', { className: 'bfs-btn', onClick: addNote }, '+ 加一条'),
          ),
          h('div', { className: 'bfs-sec-note', style: { marginBottom: '10px' } },
            '行为边界，不是台词。写「什么时候该收敛」，别写「要说什么话」。'),
          draft.selfNotes.map((n, i) => h('div', { className: 'bfs-note', key: i },
            h('input', {
              className: 'bfs-input',
              value: n,
              onChange: (e) => patch((d) => { d.selfNotes[i] = e.target.value }),
            }),
            h('button', {
              className: 'bfs-btn',
              onClick: () => patch((d) => { d.selfNotes.splice(i, 1) }),
            }, '删除'),
          )),
        ),

        h('div', { className: 'bfs-footer' },
          h('button', { className: 'bfs-btn bfs-btn-primary', disabled: saving, onClick: save },
            saving ? '保存中…' : '保存'),
          h('button', {
            className: 'bfs-btn',
            onClick: () => {
              if (!还有未保存() || window.confirm('有还没保存的改动，确定要丢掉吗？')) {
                接入新版本(data.soul)
                setMsg({ kind: '', text: '' })
              }
            },
          }, '撤销改动'),
          // ⭐ 2.3.0：回到出厂设置。以前只能逐条删，想推倒重来没有入口。
          h('button', {
            className: 'bfs-btn',
            disabled: saving,
            onClick: () => {
              if (!window.confirm('把这份人格恢复成出厂设置？现在的「我是谁」「珍视」「平时」「知道的事」都会被覆盖，版本号会 +1。')) return
              setSaving(true)
              setMsg({ kind: '', text: '' })
              fetch(ROUTE, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ reset: true, baseRevision: draft.revision || 1 }),
              })
                .then((r) => r.json())
                .then((d) => {
                  setSaving(false)
                  if (!d.ok) { setMsg({ kind: 'err', text: d.error || '重置失败' }); return }
                  接入新版本(d.soul)
                  setMsg({ kind: 'ok', text: '✓ 已恢复出厂设置' })
                })
                .catch((e) => { setSaving(false); setMsg({ kind: 'err', text: e.message || String(e) }) })
            },
          }, '恢复出厂'),
          msg.text && h('span', { className: 'bfs-msg bfs-msg-' + msg.kind }, msg.text),
          h('span', { style: { flex: 1 } }),
          还有未保存() && h('span', { className: 'bfs-msg bfs-msg-warn' }, '● 未保存'),
          h('span', { className: 'bfs-rev' }, '版本 ' + (draft.revision || 1)),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx, options) {
        if (options && options.embedded) {
          panel = SoulPanel
          return
        }
        panel = SoulPanel
      },
      getPanel() {
        return SoulPanel
      },
    }
  },
})
