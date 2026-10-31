/**
 * 直接向运行中的库写入星座与热度数据。
 *
 * 为什么不用替换文件：
 *   DSH 进程持有该库的句柄，Windows 不允许删除/替换正在被打开的文件；
 *   而且旧的 -wal 会把新数据盖掉。SQLite 本身支持并发写（WAL 模式），
 *   所以正确做法是连上去用 SQL 更新，而不是换文件。
 *
 * 只做 UPDATE / INSERT，不动 schema，不碰 messages.text 与检索逻辑。
 *
 * 用法：node dev-apply-stars.js <库路径>
 */
import { DatabaseSync } from 'node:sqlite';

const path = process.argv[2];
if (!path) { console.error('用法: node dev-apply-stars.js <库路径>'); process.exit(1); }

const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout=15000;');

const bank = 'dafeiyu';
const cnt = t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

console.log('=== 写入前 ===');
console.log('messages:', cnt('messages'), ' chunks:', cnt('chunks'),
  ' anchors:', cnt('anchors'), ' anchor_sources:', cnt('anchor_sources'));

// ── 1. 按会话建星座，关联该会话全部 chunk ────────────────────────
const sessions = db.prepare(`
  SELECT m.session AS sid, COUNT(*) AS n
  FROM chunks c JOIN messages m ON m.id = c.message
  WHERE m.bank = ? GROUP BY m.session ORDER BY n DESC
`).all(bank);

let anchored = 0, linked = 0;
const insertAnchor = db.prepare('INSERT OR IGNORE INTO anchors(bank,name) VALUES (?,?)');
const getAnchor = db.prepare('SELECT id FROM anchors WHERE bank=? AND name=?');
const insertAlias = db.prepare('INSERT OR IGNORE INTO aliases VALUES (?,?)');
const insertSource = db.prepare('INSERT OR IGNORE INTO anchor_sources VALUES (?,?)');

for (const s of sessions) {
  const ids = db.prepare(`
    SELECT c.id FROM chunks c JOIN messages m ON m.id = c.message
    WHERE m.bank = ? AND m.session = ? ORDER BY c.id
  `).all(bank, s.sid).map(r => r.id);
  if (!ids.length) continue;

  const short = String(s.sid).replace(/^session-/, '').slice(0, 8);
  const name = `星座 ${short}`;
  insertAnchor.run(bank, name);
  const aid = getAnchor.get(bank, name).id;
  insertAlias.run(aid, name.toLowerCase());
  insertAlias.run(aid, short.toLowerCase());
  for (const cid of ids) insertSource.run(aid, cid);
  anchored++;
  linked += ids.length;
}
console.log(`\n星座: ${anchored} 个，关联 chunk: ${linked} 个`);

// ── 2. 热度：长度分位 + 新旧 + 角色，形成长尾 ────────────────────
const all = db.prepare(`
  SELECT c.id, length(c.text) AS len, m.role,
         COALESCE(m.source_time, m.recorded_at) AS t
  FROM chunks c JOIN messages m ON m.id = c.message
  WHERE m.bank = ? ORDER BY t ASC
`).all(bank);

const lens = all.map(r => r.len).sort((a, b) => a - b);
const tMin = Math.min(...all.map(r => r.t));
const tMax = Math.max(...all.map(r => r.t), tMin + 1);
const p95 = lens[Math.floor(lens.length * 0.95)] || 1;

const upd = db.prepare('UPDATE chunks SET importance = ? WHERE id = ?');
let adjusted = 0;
for (const r of all) {
  const lenScore = Math.min(1, r.len / p95);
  const recency = (r.t - tMin) / (tMax - tMin);
  const roleBoost = r.role === 'user' ? 0.06 : 0;
  const raw = Math.min(1, lenScore * 0.5 + recency * 0.5 + roleBoost);
  const imp = 0.10 + Math.pow(raw, 2.2) * 0.88;
  upd.run(Number(imp.toFixed(4)), r.id);
  adjusted++;
}
console.log(`热度调整: ${adjusted} 条`);

// ── 3. 灵魂核心：最长的 3 条标 durable/.98 ───────────────────────
const top = db.prepare(`
  SELECT c.id, length(c.text) AS len FROM chunks c JOIN messages m ON m.id = c.message
  WHERE m.bank = ? ORDER BY length(c.text) DESC LIMIT 3
`).all(bank);
const setDurable = db.prepare("UPDATE chunks SET category='durable', importance=0.98 WHERE id=?");
for (const r of top) setDurable.run(r.id);
console.log(`灵魂核心: ${top.length} 条`);

// ── 4. 验证 ───────────────────────────────────────────────────
console.log('\n=== 写入后 ===');
console.log('messages:', cnt('messages'), ' chunks:', cnt('chunks'),
  ' anchors:', cnt('anchors'), ' anchor_sources:', cnt('anchor_sources'));

const h = db.prepare('SELECT MIN(importance) a, MAX(importance) b FROM chunks').get();
console.log('heat range:', h.a.toFixed(2), '~', h.b.toFixed(2));
const big = db.prepare('SELECT COUNT(*) n FROM chunks WHERE importance > 0.5').get().n;
console.log(`热度 >0.5: ${big}/${cnt('chunks')}`);
const dur = db.prepare("SELECT COUNT(*) n FROM chunks WHERE category='durable'").get().n;
console.log('durable:', dur);
console.log('integrity:', db.prepare('PRAGMA integrity_check').get().integrity_check);

db.close();
