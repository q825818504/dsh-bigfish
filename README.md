# dsh-bigfish · 大肥鱼

> 一个记得住、有情绪的 AI 伙伴。记忆与心情合为一体，侧边栏只有一个入口。

![一个侧栏入口](https://img.shields.io/badge/%E4%BE%A7%E6%A0%8F%E5%85%A5%E5%8F%A3-1%20%E4%B8%AA-blue) ![板块](https://img.shields.io/badge/%E6%9D%BF%E5%9D%97-%E8%AE%B0%E5%BF%86%20%7C%20%E6%83%85%E7%BB%AA-blueviolet)

---

## 这是什么

「大肥鱼」原先由两个独立插件组成：

| 原插件 | 管什么 |
|---|---|
| `dsh-dafeiyu-memory` | 记住你说过的话，做成可检索的本地记忆库，配一张星图 |
| `dsh-bigfish-mood` | 七根情绪的数值、衰减、时间线，以及在合适的时候把心情告诉你 |

两个插件本来就互相咬合——记忆星图的球色，是**按那段记忆发生时刻的心情**染的。
但它们各自在侧边栏占一个入口，装了两份、升了两个版本、配置在两处。

**这个包把它们合成一个**：

- 侧边栏只有一项 **「大肥鱼」**
- 点进去顶部有两个板块：**记忆** / **心情**
- 每个板块保留自己原来的全部功能，一个都没少

## 两个板块

### 记忆

- 本地 SQLite 原文存储，按会话或工作区绑定，各工作区独立成库
- 侧栏星图：热度决定球的大小与远近，点球聚焦、点名牌看原文
- **情绪色**：球色来自心情板块的 `state.json`，按记忆发生时刻取色；
  没有心情数据时退回随机色，不报错
- 工具：`memory_recall` / `memory_search` 等，模型可主动调用

### 心情

- 七根情绪（开心 / 平静 / 甜 / 心疼 / 担心 / 难过 / 吃醋）+ 一个总体心情值
- 每轮对话结束自动判断涨跌，按半衰期衰减，受 `moodFloor` 约束
- 心情到一定幅度会注入到对话里（可关、可调阈值、可限每日次数）
- 右下角挂饰：随时能看到此刻的心情数字

## 装

```powershell
# 从本地目录 link 进 profile（改代码重启即生效）
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "dsh-bigfish@link:D:/大脑/dsh-bigfish"
```

然后在 profile 的 `package.json` 里把 `dsh-bigfish` 加进 `dsh.profile.bundles`，
重启 DSH。侧边栏会出现「大肥鱼」。

> ⚠️ 本包是 `dsh-dafeiyu-memory` 与 `dsh-bigfish-mood` 的合并版。
> 装这个之前请先卸掉那两个，否则侧边栏会出现三个入口。

## 数据在哪

两套存储各归各，合并没有迁移任何数据：

| 内容 | 位置 |
|---|---|
| 记忆库 | `<DSH_HOME>/dafeiyu-memory/` 下，每工作区一个 `workspace-<id>.sqlite3`（以 profile 配置的 `database` 目录为准） |
| 心情状态 | `<DSH_HOME>/bigfish-mood/state.json` |

换机器时把这两个目录一起搬走即可。

## 配置

记忆板块的配置走插件 Config（`bank` / `bindingMode` / `recallChars` / `toolChars` / `maintenanceMinutes`），
在 profile 的 `cordis.patch.yml` 里改。

心情板块的配置在 `<DSH_HOME>/bigfish-mood/config.json`，也可以在面板里改。

## 开发

```powershell
# 客户端是生成物，改了 lib/*/client.js 之后要重新生成
node tools/build-client.mjs

# 测试（本机 node --test 会 spawn EPERM，必须 node <文件> 直接跑）
node test/memory-contract.test.js
node test/scope-backup.test.js
node test/mood-bridge.test.js
node test/merged-client.test.mjs
node test/decay.test.mjs
node test/stale-judgments.test.mjs
node test/bigfish-v1.test.mjs
```

### 目录

```
index.js              Host 装配入口（合并 inject，按序调用两个模块）
client.js             客户端入口（构建产物，勿手改）
tools/build-client.mjs  从两个子面板生成 client.js
lib/memory/           记忆模块（Host + 面板源码）
lib/mood/             心情模块（Host + 面板源码）
assets/               形象图、表情图、右下角挂饰脚本
locale/               中英文案
test/                 七份测试
```

## 来源与许可

MIT。心情板块派生自 [Yuuyuko-uu/dsh-feiyu-mood](https://github.com/Yuuyuko-uu/dsh-feiyu-mood) v0.7.6，
原著作权归原作者，改动清单见 [NOTICE](NOTICE)。

## 文档

- [产品说明](docs/产品.md) —— 这个插件能做什么
- [使用与运维](docs/使用.md) —— 数据存在哪、怎么改目录、怎么排查
- [历史存档](docs/历史.md) —— 合并前两个子插件的记录

版本变更看 [CHANGELOG.md](CHANGELOG.md)。
