#!/usr/bin/env node
/**
 * 开发期：让预览库的星图有真实层次。
 *
 * 目标：
 *   1. 每条消息都归属一个星座（按 session 全量关联，不只前 40 个）
 *   2. 热度拉开差异，让 star map 有明确的前后关系
 *   3. 标出灵魂核心（durable + 高 importance）
 *
 * 只用公开方法与既有表，不改 schema。
 * 用法：node dev-seed-stars.js <库路径>
 */
import { MemoryStore } from './lib/store.js';

const path = process.argv[2];
if (!path) { console.error('用法: node dev-seed-stars.js <库路径>'); process.exit(1); }

const store = new MemoryStore(path, 'dafeiyu');
const db = store.db;

// ── 1. 按会话建星座，关联该会话**全部** chunk ────────────────────
const sessions = db.prepare(`
  SELECT m.session AS sid, COUNT(*) AS n
  FROM chunks c JOIN messages m ON m.id = c.message
  WHERE m.bank = ? GROUP BY m.session ORDER BY n DESC
`).all('dafeiyu');

let anchored = 0, linked = 0;
for (const s of sessions) {
  const ids = db.prepare(`
    SELECT c.id FROM chunks c JOIN messages m ON m.id = c.message
    WHERE m.bank = ? AND m.session = ? ORDER BY c.id
  `).all('dafeiyu', s.sid).map(r => r.id);
  if (!ids.length) continue;
  const short = String(s.sid).replace(/^session-/, '').slice(0, 8);
  try {
    store.anchor(`星座 ${short}`, ids, [short]);
    anchored++;
    linked += ids.length;
  } catch (e) {
    console.warn(`  anchor 失败 ${short}: ${e.message}`);
  }
}
console.log(`星座: ${anchored} 个，关联 chunk: ${linked} 个`);

// ── 2. 拉开热度：长度分位 + 新旧 + 角色，形成自然长尾 ──────────────
// 目标：少数"大星" + 多数"小星"，而不是全挤在中位数看不出层次
const all = db.prepare(`
  SELECT c.id, length(c.text) AS len, m.role,
         COALESCE(m.source_time, m.recorded_at) AS t
  FROM chunks c JOIN messages m ON m.id = c.message
  WHERE m.bank = ? ORDER BY t ASC
`).all('dafeiyu');

const lens = all.map(r => r.len).sort((a, b) => a - b);
const tMin = Math.min(...all.map(r => r.t));
const tMax = Math.max(...all.map(r => r.t), tMin + 1);
// 用 p95 做长度上限，避免个别超长文本把整个分布压扁
const p95 = lens[Math.floor(lens.length * 0.95)] || 1;

let adjusted = 0;
for (const r of all) {
  const lenScore = Math.min(1, r.len / p95);          // 0..1
  const recency = (r.t - tMin) / (tMax - tMin);       // 0..1，越新越大
  const roleBoost = r.role === 'user' ? 0.06 : 0;     // 用户话语信息量通常更高
  const raw = Math.min(1, lenScore * 0.5 + recency * 0.5 + roleBoost);
  // 幂函数压低中段 → 长尾分布
  const shaped = Math.pow(raw, 2.2);
  const imp = 0.10 + shaped * 0.88;                   // 0.10 ~ 0.98
  try {
    db.prepare('UPDATE chunks SET importance = ? WHERE id = ?').run(Number(imp.toFixed(4)), r.id);
    adjusted++;
  } catch {}
}
console.log(`热度调整: ${adjusted} 条`);

// ── 3. 灵魂核心：最长的 3 条标 durable/.98 ───────────────────────
const top = db.prepare(`
  SELECT c.id, length(c.text) AS len FROM chunks c JOIN messages m ON m.id = c.message
  WHERE m.bank = ? ORDER BY length(c.text) DESC LIMIT 3
`).all('dafeiyu');
for (const r of top) {
  db.prepare("UPDATE chunks SET category='durable', importance=0.98 WHERE id=?").run(r.id);
}
console.log(`灵魂核心: ${top.length} 条 (${top.map(r => r.len + '字').join(', ')})`);

// ── 4. 验证 ───────────────────────────────────────────────────
const b = store.browse({ limit: 8, preview: 24 });
console.log('\n抽样（id / 热度 / 分类 / 星座）:');
for (const it of b.items) {
  console.log(`  ${String(it.id).padStart(4)}  heat=${it.heat.toFixed(2)}  ${it.category}  ${it.star ? it.star.name : '无星座'}`);
}
const hs = db.prepare('SELECT importance FROM chunks').all().map(r => r.importance).sort((x, y) => x - y);
const q = p => hs[Math.floor(hs.length * p)].toFixed(2);
console.log(`\nheat 分布: min=${hs[0].toFixed(2)} p25=${q(.25)} median=${q(.5)} p75=${q(.75)} max=${hs.at(-1).toFixed(2)}`);
const cnt = t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
console.log(`\nanchors=${cnt('anchors')} anchor_sources=${cnt('anchor_sources')} messages=${cnt('messages')} chunks=${cnt('chunks')}`);
store.close();
