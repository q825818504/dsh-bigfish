/**
 * 给所有 chunk 补齐星座关联（幂等）。
 *
 * 背景：星座是按会话建的，但新消息在星座建好之后才产生，
 * 于是出现「老消息有星座、新消息没有」的断层，星图里一堆球显示为"无星座"。
 *
 * 做法：对每个会话，把该会话下**所有** chunk 补进对应 anchor。
 * 只 INSERT OR IGNORE，不删除、不改动既有数据。
 *
 * 用法：node dev-sync-stars.js <库路径>
 */
import { DatabaseSync } from 'node:sqlite';

const path = process.argv[2];
if (!path) { console.error('用法: node dev-sync-stars.js <库路径>'); process.exit(1); }

const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout=15000;');
const bank = 'dafeiyu';

const sessions = db.prepare(`
  SELECT m.session AS sid, COUNT(*) AS n
  FROM chunks c JOIN messages m ON m.id = c.message
  WHERE m.bank = ? GROUP BY m.session ORDER BY n DESC
`).all(bank);

const insertAnchor = db.prepare('INSERT OR IGNORE INTO anchors(bank,name) VALUES (?,?)');
const getAnchor = db.prepare('SELECT id FROM anchors WHERE bank=? AND name=?');
const insertAlias = db.prepare('INSERT OR IGNORE INTO aliases VALUES (?,?)');
const insertSource = db.prepare('INSERT OR IGNORE INTO anchor_sources VALUES (?,?)');

let added = 0;
for (const s of sessions) {
  const ids = db.prepare(`
    SELECT c.id FROM chunks c JOIN messages m ON m.id = c.message
    WHERE m.bank = ? AND m.session = ?
  `).all(bank, s.sid).map(r => r.id);
  if (!ids.length) continue;

  const short = String(s.sid).replace(/^session-/, '').slice(0, 8);
  const name = `星座 ${short}`;
  insertAnchor.run(bank, name);
  const aid = getAnchor.get(bank, name).id;
  insertAlias.run(aid, name.toLowerCase());
  insertAlias.run(aid, short.toLowerCase());
  for (const cid of ids) {
    const r = insertSource.run(aid, cid);
    if (r.changes) added++;
  }
}
console.log(`补齐星座关联: ${added} 条`);

const covered = db.prepare(`
  SELECT COUNT(DISTINCT c.message) n FROM anchor_sources s
  JOIN chunks c ON c.id = s.chunk JOIN messages m ON m.id = c.message
  WHERE m.bank = ?
`).get(bank).n;
const total = db.prepare('SELECT COUNT(*) n FROM messages WHERE bank=?').get(bank).n;
console.log(`覆盖: ${covered}/${total} 条消息有星座`);
console.log('anchors:', db.prepare('SELECT COUNT(*) n FROM anchors').get().n,
  ' anchor_sources:', db.prepare('SELECT COUNT(*) n FROM anchor_sources').get().n);
db.close();
