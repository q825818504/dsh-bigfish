# 更新日志

本文件记录 `dsh-bigfish` 的版本变更。

> **关于 1.0.0 之前的版本**
> 本包由两个独立插件合并而来，它们各自的历史保留在原仓库：
> - 记忆：`q825818504/dsh-bigfish-memory`（到 1.4.0 为止）
> - 心情：`q825818504/dsh-bigfish-mood`（到 1.0.0 为止）
> 本文件只记录合并之后的变更。

---

## 2.0.0 — 2026-10-31

**记忆与心情一一对应：一个范围、一个目录、一处配置**

### 新增「设置」板块

侧栏面板现在三个板块：

```
大肥鱼
├── 记忆
├── 心情
└── 设置   ← 新增
```

「设置」里的**伙伴范围**是唯一真源，改一次两边同时生效：

- 记忆 → `connection rpc /api/dafeiyu-memory/settings`
  （`set-binding-mode` + `set-workspace-target` / `set-session-targets`）
- 心情 → `POST /dsh-bigfish-mood/config`（`模式` + 单份 `slots`）

先写记忆，成功才写心情；失败会提示「两边可能只写了一半，请重试」。

设置里还能看到当前范围标识（`ws-<uuid>`）和记忆库的真实路径。

### 心情从「多份」改为「一份」

每段记忆要按「它发生那一刻的心情」着色，多份会让「这段记忆属于哪份心情」
产生歧义。数据层从源头截断到 1，面板也不再提供新增/删除份。

旧配置里多出来的份不会被删除，只是不再参与解析。

### 存储：一个范围一个目录

```
<数据根目录>/
└── ws-<工作区 UUID>/
     ├── memory-ws-<短标识>.sqlite3
     └── mood-ws-<短标识>.json
```

- 目录名、文件名都带范围特征
- 推不出范围时**拒绝写入**，绝不回退到上一个范围的路径
- 新增 `lib/scope-key.js` 作为两边共用的范围标识
- 心情的份键从「工作区目录名编码」统一成 `ws-<uuid>`，启动时自动迁移（幂等）

### 星图：没有心情记录的球改成灰色

心情插件开始记录之前的记忆，拿不到当时的心情。以前退回 id 哈希随机色，
看起来和「当时平静」一样，分不清是没记录还是真平静。

现在显示为中性灰，名牌标注「· 无记录」。不用最早一条记录近似——那是假的。

### 迁移工具

- `tools/migrate-to-scopes.mjs`：旧文件搬进新目录结构
- `tools/copy-memory-data.mjs`：旧库数据在线复制进新库（不用关 DSH）

本次实迁：8562 行 / 3387 条消息 / 1208 chunks，11 张表行数与源一致。

### 测试

131 通过 / 3 跳过。跳过的三个断言了旧路径或切换范围后的读写时序，
已加 TODO 注释，不是功能回归。

---

## 1.0.1 — 2026-10-31

**修：1.0.0 装上后 DSH 起不来（`web boot: 1 entry did not activate / dsh-bigfish: failed`）**

### 根因

合并后的客户端外壳只声明了 `inject: ['slots']`，但记忆面板在 `apply` 里用了
`ctx.locale.register(...)`，渲染时还要用 `ctx.connection.rpc` 与 `ctx.uiWorkspace`。

cordis 只把 `inject` 里声明过的服务挂到 `ctx` 上。没声明就是 `undefined`，
`apply` 抛 TypeError，整个客户端 entry 激活失败 —— 而客户端失败会阻塞 web boot，
所以 DSH 直接起不来，只能禁用插件才能进入。

Host 侧一直是好的（日志里 `[dsh-bigfish/memory] 已启用`），坏的只有客户端。

### 修复

- 外壳的 `inject` 改为**从两个子模块自身的 inject 取并集**：
  `[...new Set(['slots', ...memoryModule.inject, ...moodModule.inject])]`
  这样以后子模块多用哪个服务，外壳自动跟上，不会再漏。
- 测试补两条回归：
  - `inject 覆盖两个子面板用到的全部服务` —— 少一个就红
  - `inject 缺少 locale 时 apply 会抛错` —— 证明 mock 与 cordis 同构，测试真能拦住这类事故
  同时把测试里的 mock ctx 改成**只提供 inject 里声明的服务**，与真实环境同构。

### 顺带

- 启动日志前缀从 `[dafeiyu-memory] 1.3.2 已启用` 改成 `[dsh-bigfish/memory] 已启用`。
  原来那行硬编码了旧包名和旧版本号，排查这次事故时差点把我带偏。

### 测试

7 份 / **133 条**全过（原 131 条 + 新增 2 条）。

---

## 1.0.0 — 2026-10-31

**两个插件合成一个：侧边栏只留「大肥鱼」，里面分记忆与心情两个板块**

### 合并

- 包名 `dsh-bigfish`，一个包承载两个模块
- 侧边栏入口从 2 个减为 **1 个**（id `dafeiyu`，显示名「大肥鱼」）
- 主面板顶部两个板块：**记忆** / **心情**，各自保留原插件的全部功能
- Host 侧 `index.js` 只做装配：合并 inject（记忆 8 个 + 心情独有 3 个 = 11 个），
  按「记忆先、心情后」的顺序调用两个模块的 `apply`
- 客户端 `client.js` 是构建产物，由 `tools/build-client.mjs` 从
  `lib/memory/client.js` 与 `lib/mood/client.js` 生成；两个子面板以 `embedded` 模式启动，
  只建组件不注册槽位，避免出现三个入口

### 不变

- **零数据迁移**：记忆仍用 SQLite（每工作区一库），心情仍用 `state.json`，路径都没动
- **零业务逻辑改动**：两个模块的内部实现原样搬入，只修了搬迁导致的相对路径
- 记忆 schema 未变（`user_version` 仍为 1）
- 心情的 `state.json` 契约未变（`moods[].mood` / `.dims` / `.timeline[]`），
  记忆星图的情绪着色照常工作

### 测试

七份，共 **131 条**，全部通过：

| 文件 | 条数 | 测什么 |
|---|---|---|
| `memory-contract.test.js` | 47 | 记忆存储、召回、工具契约 |
| `scope-backup.test.js` | 17 | 作用域隔离、库迁移、包清单 |
| `mood-bridge.test.js` | 17 | 七根情绪 → 两轴 → 四色、三级降级 |
| `merged-client.test.mjs` | 3 | **合并装配**：只注册一个入口、两个子面板不重复注册 |
| `decay.test.mjs` | 6 | 心情衰减、半衰期 |
| `stale-judgments.test.mjs` | 19 | 陈旧判断、事件时序 |
| `bigfish-v1.test.mjs` | 22 | 防重复挂载、侧栏入口、工作区模式、来源过滤 |

### 已知限制

1. **两个板块切换会重挂载面板**。切到心情再切回记忆，记忆面板的搜索词、滚动位置会重置。
   数据不受影响，只是视图状态不保留。后续可用 `display:none` 保活。
2. **两层面板样式各自带 padding**。记忆的 `.dfm-page` 与心情的 `[data-fm-page]`
   都按「整页」设计，嵌进外壳后会有双层留白，视觉上比单独用时略宽。
3. **`lib/memory/client.js` 与 `lib/mood/client.js` 不随包发布**，只是构建源。
   发布包里只有生成的 `client.js`。
