import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../lib/memory/store.js';
import { attach } from '../lib/memory/adapter.js';
import { apply } from '../lib/memory/index.js';

function tempStore(t, name = 'memory.sqlite3') {
  const directory = mkdtempSync(join(tmpdir(), 'dafeiyu-contract-'));
  const store = new MemoryStore(join(directory, name));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function add(store, sessionId, text, eventKey = '1') {
  return store.capture({
    session: `${sessionId}@1000`, eventKey, role: 'user',
    content: text, sourceTime: 1000,
  });
}

function firstChunk(store, messageId) {
  return Number(store.db.prepare('SELECT id FROM chunks WHERE message=? ORDER BY id LIMIT 1').get(messageId).id);
}

// 模拟 adapter.js 的注入循环，用于验证多轮行为。这是本次改动最重要的回归点：
// 单轮测试无法暴露"回退 → 重复记录 → 再回退"的死循环。
function injectOnce(store, query, { maxChars = 2400, limit = 5 } = {}) {
  const excludeIds = store.recentShown(1);
  const result = store.recall(query, { maxChars, limit, excludeIds });
  if (result.text && !result.diagnostics?.excludeFallback) store.log('shown', result.text, result.ids);
  return result;
}

// ── C1：search 返回结构不得改变 ───────────────────────────────────────────
test('C1 search still returns an array of hits with the documented shape', t => {
  const store = tempStore(t);
  add(store, 's1', 'The blue postcard sits beside the orchard map.');
  const hits = store.search('postcard orchard');
  assert.ok(Array.isArray(hits), 'search must return an array');
  assert.equal(hits.length, 1);
  for (const key of ['id', 'session', 'reasons', 'state', 'score', 'start', 'end', 'text']) {
    assert.ok(key in hits[0], `hit must expose ${key}`);
  }
  assert.ok(hits[0].reasons.includes('keyword'));
});

// ── C2：excludeIds 生效，且为空时回退 ────────────────────────────────────
test('C2 excludeIds removes hits but falls back when it would empty the result', t => {
  const store = tempStore(t);
  add(store, 's1', 'Alpha bravo charlie delta echo foxtrot golf hotel.', '1');
  add(store, 's1', 'India juliet kilo lima mike november oscar papa.', '2');
  const all = store.search('alpha bravo charlie delta echo foxtrot golf hotel');
  assert.equal(all.length, 1);
  const excluded = store.search('alpha bravo charlie delta echo foxtrot golf hotel', { excludeIds: new Set([all[0].id]) });
  assert.equal(excluded.length, 1, 'exclusion must not empty the result set');
  assert.equal(excluded[0].id, all[0].id, 'it falls back to the unfiltered hit');
});

test('C3 excludeIds actually filters when other hits remain', t => {
  const store = tempStore(t);
  add(store, 's1', 'Garden lantern mosaic river pebble quartz.', '1');
  add(store, 's1', 'Garden lantern mosaic river pebble granite.', '2');
  const hits = store.search('garden lantern mosaic river pebble');
  assert.equal(hits.length, 2);
  const filtered = store.search('garden lantern mosaic river pebble', { excludeIds: [hits[0].id] });
  assert.equal(filtered.length, 1);
  assert.notEqual(filtered[0].id, hits[0].id);
});

test('C4 excludeIds tolerates non-iterable and malformed values', t => {
  const store = tempStore(t);
  add(store, 's1', 'Tolerance probe for the harbour crane and the bell.');
  const baseline = store.search('tolerance probe harbour crane bell');
  for (const value of [5, 'abc', {}, null, undefined, [], new Set()]) {
    const hits = store.search('tolerance probe harbour crane bell', { excludeIds: value });
    assert.equal(hits.length, baseline.length, `excludeIds=${String(value)} must be a no-op, not a throw`);
  }
});

// ── C5：recentShown 读取 shown 记录 ──────────────────────────────────────
test('C5 recentShown returns ids from the newest shown ledger rows only', t => {
  const store = tempStore(t);
  const a = add(store, 's1', 'First remembered item about the harbour crane.', '1');
  const b = add(store, 's1', 'Second remembered item about the harbour bell.', '2');
  const idA = firstChunk(store, a);
  const idB = firstChunk(store, b);
  store.log('shown', 'payload-a', [idA]);
  store.log('shown', 'payload-b', [idB]);
  const shown = store.recentShown(2);
  assert.ok(shown instanceof Set);
  assert.deepEqual([...shown].sort((x, y) => x - y), [idA, idB].sort((x, y) => x - y));
  assert.equal(store.recentShown(1).size, 1, 'limit selects the newest row only');
});

test('C6 recentShown tolerates malformed ledger payloads', t => {
  const store = tempStore(t);
  store.db.prepare("INSERT INTO ledger(bank,at,kind,chars,sources) VALUES (?,?,?,?,?)")
    .run('dafeiyu', Date.now(), 'shown', 3, 'not json');
  const shown = store.recentShown(1);
  assert.ok(shown instanceof Set);
  assert.equal(shown.size, 0);
});

// ── C7：recall 返回值结构 ────────────────────────────────────────────────
test('C7 recall keeps text/ids and adds diagnostics', t => {
  const store = tempStore(t);
  add(store, 's1', 'The lighthouse keeper records every passing ship.');
  const result = store.recall('lighthouse keeper passing ship');
  assert.ok(typeof result.text === 'string');
  assert.ok(Array.isArray(result.ids));
  assert.ok(result.diagnostics, 'diagnostics must be present');
  assert.equal(typeof result.diagnostics.candidates, 'number');
});

// ── C8：预算充足时全部返回 ───────────────────────────────────────────────
test('C8 generous budget keeps every excerpt untruncated', t => {
  const store = tempStore(t);
  add(store, 's1', 'Short note one about the river.', '1');
  add(store, 's1', 'Short note two about the bridge.', '2');
  const result = store.recall('river bridge', { maxChars: 20000 });
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.length, 2);
  for (const item of parsed) {
    assert.ok(!('truncated' in item), 'no excerpt should ever be truncated now');
  }
});

// ── C9：输出永不超预算且 JSON 恒合法 ────────────────────────────────────
test('C9 output is always within budget and parseable across the full range', t => {
  const store = tempStore(t);
  for (let i = 0; i < 6; i++) {
    add(store, 's1', `Record ${i}: ` + 'padding sentence about nothing in particular. '.repeat(6), String(i));
  }
  for (let mc = 200; mc <= 2000; mc += 100) {
    const result = store.recall('record padding sentence nothing particular', { maxChars: mc, limit: 6 });
    assert.ok(result.text.length <= mc, `maxChars=${mc} produced ${result.text.length} chars`);
    if (result.text) assert.doesNotThrow(() => JSON.parse(result.text), `maxChars=${mc} produced invalid JSON`);
    assert.equal(result.diagnostics.final, result.ids.length, `maxChars=${mc} final/ids mismatch`);
  }
});

// ── C10：预算耗尽与真实无命中必须可区分 ─────────────────────────────────
test('C10 budget exhaustion is distinguishable from a genuine miss', t => {
  const store = tempStore(t);
  add(store, 's1', 'x'.repeat(640) + ' UNIQUEMARK ' + 'y'.repeat(1200));
  const squeezed = store.recall('UNIQUEMARK', { maxChars: 200, limit: 5 });
  assert.ok(squeezed.diagnostics.candidates > 0, 'the hit was found');
  assert.equal(squeezed.text, '');
  assert.equal(squeezed.diagnostics.budgetExhausted, true);
  const missing = store.recall('ZZZNOSUCHTERMZZZ', { maxChars: 200, limit: 5 });
  assert.equal(missing.diagnostics.candidates, 0);
  assert.notEqual(missing.diagnostics.budgetExhausted, true);
});

// ── C11：diagnostics.candidates 必须是排除前的命中数 ────────────────────
test('C11 candidates counts hits before exclusion, not after', t => {
  const store = tempStore(t);
  add(store, 's1', 'Granite pebble mosaic lantern harbour quartz.', '1');
  add(store, 's1', 'Granite pebble mosaic lantern harbour basalt.', '2');
  add(store, 's1', 'Granite pebble mosaic lantern harbour flint.', '3');
  const all = store.search('granite pebble mosaic lantern harbour');
  assert.equal(all.length, 3);
  const result = store.recall('granite pebble mosaic lantern harbour', { excludeIds: [all[0].id, all[1].id] });
  assert.equal(result.diagnostics.candidates, 3, 'candidates must report the pre-exclusion hit count');
  assert.equal(result.diagnostics.excluded, 2);
});

// ── C12：诊断计数自洽 ────────────────────────────────────────────────────
test('C12 diagnostics counters stay consistent', t => {
  const store = tempStore(t);
  add(store, 's1', 'Quartz harbour lantern mosaic pebble granite.');
  const result = store.recall('quartz harbour lantern mosaic pebble granite');
  const d = result.diagnostics;
  assert.ok(d.candidates >= d.final, 'candidates must be >= final');
  assert.equal(d.final, result.ids.length, 'final must match ids length');
  assert.equal(typeof d.excludeFallback, 'boolean');
});

// ── C13：检索范围过滤不受影响 ────────────────────────────────────────────
test('C13 scope filtering still isolates sessions', t => {
  const store = tempStore(t);
  const repeated = 'This exact sentence appears in two different sessions here.';
  add(store, 's1', repeated, '1');
  add(store, 's2', repeated, '1');
  const scoped = store.search('exact sentence appears different sessions', { sessionIds: ['s2'] });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].session, 's2@1000', 'scope must not be bypassed');
  assert.deepEqual(store.search('exact sentence appears different sessions', { sessionIds: [] }), []);
});

// ── C14：多轮注入循环不得震荡（B1 防回归）──────────────────────────────
test('C14 repeated injection cycles never oscillate back to the same excerpts', t => {
  const store = tempStore(t);
  // 8 条候选，limit=5：这是审查实测中最容易触发"回退震荡"的区间
  for (let i = 0; i < 8; i++) {
    add(store, 's1', `Harbour log entry ${i} about the crane and the bell.`, String(i));
  }
  const rounds = [];
  for (let round = 0; round < 8; round++) {
    const result = injectOnce(store, 'harbour log entry crane bell');
    rounds.push({ ids: result.ids.join(','), fallback: Boolean(result.diagnostics.excludeFallback) });
  }
  // 相邻两轮不得注入完全相同的内容
  for (let i = 1; i < rounds.length; i++) {
    assert.notEqual(rounds[i].ids, rounds[i - 1].ids,
      `round ${i} repeated round ${i - 1} verbatim: ${rounds[i].ids}`);
  }
  // 回退不应成为常态
  const fallbacks = rounds.filter(r => r.fallback).length;
  assert.ok(fallbacks <= 2, `exclusion fell back ${fallbacks}/8 rounds — exclusion is effectively dead`);
});

// ── C15：候选数刚好等于 limit 时的边界 ───────────────────────────────────
test('C15 exactly-limit candidates do not deadlock the exclusion', t => {
  const store = tempStore(t);
  for (let i = 0; i < 5; i++) {
    add(store, 's1', `Small set record ${i} mentioning the pier lantern.`, String(i));
  }
  const first = injectOnce(store, 'small set record pier lantern');
  assert.equal(first.ids.length, 5);
  const second = injectOnce(store, 'small set record pier lantern');
  // 全部候选都被排除 → 必须回退，否则会变成"没有记忆"
  assert.equal(second.ids.length, 5, 'a full overlap must fall back rather than return nothing');
  assert.equal(second.diagnostics.excludeFallback, true);
  // 回退轮不写 shown，所以第三轮仍然会回退而不是陷入新的循环
  const third = injectOnce(store, 'small set record pier lantern');
  assert.equal(third.ids.length, 5);
});

// ── C16：维护任务保持幂等 ────────────────────────────────────────────────
test('C16 maintenance stays idempotent', t => {
  const store = tempStore(t);
  add(store, 's1', 'Idempotent maintenance probe about the wooden pier.');
  const first = store.sleep(100);
  const second = store.sleep(100);
  assert.equal(second.processed, 0, 'second pass has nothing new');
  assert.ok(first.processed >= 1);
});

// ── C17：browse 分页与过滤 ────────────────────────────────────────────────
test('C17 browse paginates without overlap and filters by role', t => {
  const store = tempStore(t);
  for (let i = 0; i < 12; i++) {
    store.capture({ session: 's1@1000', eventKey: String(i), role: i % 3 ? 'assistant' : 'user',
      content: `Browsable memory number ${i} about the harbour crane.`, sourceTime: 1000 + i });
  }
  const first = store.browse({ limit: 5, preview: 40 });
  assert.equal(first.total, 12);
  assert.equal(first.items.length, 5);
  assert.equal(first.nextOffset, 5);
  const second = store.browse({ offset: 5, limit: 5, preview: 40 });
  assert.equal(second.items.length, 5);
  assert.equal(first.items.filter(a => second.items.some(b => b.id === a.id)).length, 0, 'pages must not overlap');
  const users = store.browse({ role: 'user', limit: 20 });
  assert.equal(users.total, 4);
  assert.ok(users.items.every(item => item.role === 'user'));
});

// ── C18：browse 只返回预览，不返回全文 ────────────────────────────────────
test('C18 browse returns truncated previews, not full text', t => {
  const store = tempStore(t);
  const long = 'A'.repeat(500);
  store.capture({ session: 's1@1000', eventKey: '1', role: 'user', content: long, sourceTime: 1000 });
  const page = store.browse({ limit: 5, preview: 80 });
  const item = page.items[0];
  assert.equal(item.truncated, true);
  assert.equal(item.preview.length, 81, 'preview keeps 80 chars plus the ellipsis');
  assert.equal(item.chars, 500, 'the real length is still reported');
});

// ── C19：空白消息不进细胞视图 ────────────────────────────────────────────
test('C19 browse skips empty and whitespace-only messages', t => {
  const store = tempStore(t);
  store.capture({ session: 's1@1000', eventKey: '1', role: 'user', content: '   ', sourceTime: 1000 });
  store.capture({ session: 's1@1000', eventKey: '2', role: 'user', content: 'Real content here.', sourceTime: 1001 });
  const page = store.browse({ limit: 20 });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].preview, 'Real content here.');
});

// ── C20：readMessage 收 message id，与 browse 配对 ───────────────────────
test('C20 readMessage resolves the message id that browse returns', t => {
  const store = tempStore(t);
  const body = 'Message body for the detail dialog, long enough to page.';
  store.capture({ session: 's1@1000', eventKey: '1', role: 'user', content: body, sourceTime: 1000 });
  // 再放一条长消息，制造 chunk 数多于消息数的局面
  store.capture({ session: 's1@1000', eventKey: '2', role: 'assistant', content: 'Z'.repeat(1500), sourceTime: 1001 });
  const page = store.browse({ limit: 5 });
  const first = page.items.find(item => item.preview.startsWith('Message body'));
  assert.ok(first, 'the short message must appear in browse');
  const detail = store.readMessage(first.id, { length: 6000 });
  assert.equal(detail.text, body, 'readMessage must return exactly the message that browse listed');
  assert.equal(detail.totalChars, body.length);
  // chunk id 与 message id 是两套编号：chunk 数已超过消息数
  const chunkCount = store.db.prepare('SELECT COUNT(*) n FROM chunks').get().n;
  const messageCount = store.db.prepare('SELECT COUNT(*) n FROM messages').get().n;
  assert.ok(chunkCount > messageCount, 'this fixture must have more chunks than messages');
  // 因此 read()（收 chunk id）不能用于面板详情——它按 chunk 定位，可能落在别的消息上
  const byChunk = store.read(first.id, { length: 6000 });
  assert.equal(typeof byChunk.text, 'string', 'read() still works, but on chunk-id semantics');
  assert.equal(store.readMessage(first.id).text, detail.text, 'readMessage is stable across calls');
});

// ── C21：面板作用域绝不退化成"查全库" ────────────────────────────────────
test('C21 panel scope never degrades into an unscoped query', t => {
  const store = tempStore(t);
  store.capture({ session: 'session-A@1000', eventKey: '1', role: 'user', content: 'Alpha memory about the harbour crane.', sourceTime: 1000 });
  store.capture({ session: 'session-B@1000', eventKey: '1', role: 'user', content: 'Bravo memory about the pier lantern.', sourceTime: 1001 });
  // 不传 sessionIds 是"全库"，这是 store 的既有语义，必须保留（recall 依赖它）
  assert.equal(store.browse({ limit: 10 }).total, 2);
  // 传空数组必须得到 0，而不是退化成全库
  assert.equal(store.browse({ limit: 10, sessionIds: [] }).total, 0);
  // 传不存在的会话也必须得到 0
  assert.equal(store.browse({ limit: 10, sessionIds: ['session-NOPE'] }).total, 0);
  // 传 A 只得到 A
  const scoped = store.browse({ limit: 10, sessionIds: ['session-A'] });
  assert.equal(scoped.total, 1);
  assert.ok(scoped.items[0].preview.startsWith('Alpha'));
});

// ── C22：detail 必须受同一作用域约束 ─────────────────────────────────────
test('C22 readMessage refuses to cross the session scope', t => {
  const store = tempStore(t);
  store.capture({ session: 'session-A@1000', eventKey: '1', role: 'user', content: 'Alpha secret from workspace one.', sourceTime: 1000 });
  store.capture({ session: 'session-B@1000', eventKey: '1', role: 'user', content: 'Bravo secret from workspace two.', sourceTime: 1001 });
  const a = store.browse({ limit: 10, sessionIds: ['session-A'] }).items[0];
  const b = store.browse({ limit: 10, sessionIds: ['session-B'] }).items[0];
  assert.ok(store.readMessage(a.id, { sessionIds: ['session-A'] }).text.includes('Alpha'));
  assert.ok(store.readMessage(b.id, { sessionIds: ['session-B'] }).text.includes('Bravo'));
  // 用 B 的作用域去读 A 的消息必须失败，不能靠 id 猜
  assert.throws(() => store.readMessage(a.id, { sessionIds: ['session-B'] }), /Memory not found in this scope/);
  // 空作用域同样拒绝
  assert.throws(() => store.readMessage(a.id, { sessionIds: [] }), /Memory not found in this scope/);
});

// ── C23：storageStats 必须支持作用域 ────────────────────────────────────
test('C23 storageStats honours the session scope', t => {
  const store = tempStore(t);
  store.capture({ session: 'session-A@1000', eventKey: '1', role: 'user', content: 'Alpha text for scope A, moderately long body.', sourceTime: 1000 });
  store.capture({ session: 'session-B@1000', eventKey: '1', role: 'user', content: 'Bravo text for scope B, also fairly long body.', sourceTime: 1001 });
  store.sleep(100);

  const all = store.storageStats();
  assert.equal(all.scoped, false);
  assert.equal(all.bankTotals, null, 'unscoped calls keep the original shape');
  assert.equal(all.messages, 2);

  const a = store.storageStats({ sessionIds: ['session-A'] });
  assert.equal(a.scoped, true);
  assert.equal(a.messages, 1);
  assert.equal(a.chunks, 1);
  assert.ok(a.originalTextBytes > 0 && a.originalTextBytes < all.originalTextBytes);
  assert.equal(a.bankTotals.messages, 2, 'the bank total is still available for comparison');
  assert.equal(a.bankTotals.chunks, all.chunks);
  // 物理文件大小不随范围变化——它就是一个文件
  assert.equal(a.databaseFiles.totalBytes, all.databaseFiles.totalBytes);

  const none = store.storageStats({ sessionIds: [] });
  assert.equal(none.messages, 0);
  assert.equal(none.chunks, 0);
  assert.equal(none.originalTextBytes, 0);
  assert.equal(none.lastCapture, null);
  assert.equal(none.tiers.episodic.chunks, 0);
  assert.equal(none.recency.active.chunks, 0);
});

// ── C24：作用域统计与浏览结果必须一致 ───────────────────────────────────
test('C24 scoped stats agree with the browsable set', t => {
  const store = tempStore(t);
  for (let i = 0; i < 5; i++) {
    store.capture({ session: 'session-A@1000', eventKey: String(i), role: 'user', content: `Alpha entry ${i} with enough text to index.`, sourceTime: 1000 + i });
  }
  for (let i = 0; i < 3; i++) {
    store.capture({ session: 'session-B@1000', eventKey: String(i), role: 'user', content: `Bravo entry ${i} with enough text to index.`, sourceTime: 2000 + i });
  }
  const stats = store.storageStats({ sessionIds: ['session-A'] });
  const page = store.browse({ limit: 100, sessionIds: ['session-A'] });
  assert.equal(stats.messages, page.total, 'the headline number must match what the cells show');
  assert.equal(stats.messages, 5);
});

// ── 强制范围模式 ──────────────────────────────────────────────────────────
import { options, panelQuerySessions, panelScopeIds, scopeDatabasePath, splitBankIntoScopes } from '../lib/memory/index.js';


test('S1 scopeDatabasePath names one file per workspace, stably', () => {
  const base = { database: 'D:\\mem\\memory.sqlite3', scopeDirectory: '', bank: 'dafeiyu' };
  const ws = scopeDatabasePath({ ...base, bindingMode: 'workspace', bindingWorkspaceId: '83ba9d80-ec53-4a24-9245-7ce877a74e70' });
  assert.equal(ws, 'D:\\mem\\workspace-83ba9d80.sqlite3');
  // 同一个工作区永远解析到同一个文件
  assert.equal(scopeDatabasePath({ ...base, bindingMode: 'workspace', bindingWorkspaceId: '83ba9d80-ec53-4a24-9245-7ce877a74e70' }), ws);
  // 不同工作区必须落到不同文件
  const other = scopeDatabasePath({ ...base, bindingMode: 'workspace', bindingWorkspaceId: '6dde4a7d-7696-497a-b691-a41ed02d9f2a' });
  assert.notEqual(other, ws);
});

test('S2 scopeDatabasePath returns null when the scope is unresolved', () => {
  const base = { database: 'D:\\mem\\memory.sqlite3', scopeDirectory: '' };
  // 工作区模式但没有选工作区 → 无法确定库名，必须返回 null 让调用方拒绝写入
  assert.equal(scopeDatabasePath({ ...base, bindingMode: 'workspace', bindingWorkspaceId: '' }), null);
  // 会话模式但没有选会话 → 同样 null
  assert.equal(scopeDatabasePath({ ...base, bindingMode: 'session', bindingSessionIds: [] }), null);
  assert.equal(scopeDatabasePath({ ...base, bindingMode: 'session', bindingSessionIds: undefined }), null);
});

test('S3 scopeDirectory overrides the database directory', () => {
  const path = scopeDatabasePath({
    database: 'D:\\mem\\memory.sqlite3',
    scopeDirectory: 'E:\\scoped',
    bindingMode: 'workspace',
    bindingWorkspaceId: '83ba9d80-ec53-4a24-9245-7ce877a74e70',
  });
  assert.equal(path, 'E:\\scoped\\workspace-83ba9d80.sqlite3');
});

test('S4 multi-session binding maps to one stable file regardless of order', () => {
  const base = { database: 'D:\\mem\\memory.sqlite3', scopeDirectory: '', bindingMode: 'session' };
  const a = scopeDatabasePath({ ...base, bindingSessionIds: ['session-aaaaaaaa-1', 'session-bbbbbbbb-2'] });
  const b = scopeDatabasePath({ ...base, bindingSessionIds: ['session-bbbbbbbb-2', 'session-aaaaaaaa-1'] });
  assert.equal(a, b, 'the same set must always resolve to the same file');
  assert.ok(a.endsWith('.sqlite3'));
});

test('S5 splitBankIntoScopes copies each workspace into its own file', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-split-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, 'memory.sqlite3');
  const source = new MemoryStore(sourcePath, 'dafeiyu');
  source.capture({ session: 'session-A@1000', eventKey: '1', role: 'user', content: 'Alpha belongs to workspace one.', sourceTime: 1000 });
  source.capture({ session: 'session-B@1000', eventKey: '1', role: 'user', content: 'Bravo belongs to workspace two.', sourceTime: 1001 });
  source.close();

  const registry = {
    list: () => [
      { id: 'aaaaaaaa-1111', title: 'One', sessionIds: ['session-A'] },
      { id: 'bbbbbbbb-2222', title: 'Two', sessionIds: ['session-B'] },
      { id: 'cccccccc-3333', title: 'Empty', sessionIds: ['session-Z'] },
    ],
  };
  const result = splitBankIntoScopes({ workspaceRegistry: registry }, sourcePath, 'dafeiyu', dir);
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 3);
  const one = result.results.find(r => r.title === 'One');
  const two = result.results.find(r => r.title === 'Two');
  const empty = result.results.find(r => r.title === 'Empty');
  assert.equal(one.copied, 1);
  assert.equal(two.copied, 1);
  assert.equal(empty.copied, 0, 'a workspace with no messages still gets an (empty) file');
  assert.ok(existsSync(one.path) && existsSync(two.path));

  // 每个库只含自己的工作区内容
  const s1 = new MemoryStore(one.path, 'dafeiyu');
  assert.equal(s1.browse({ limit: 10 }).total, 1);
  assert.ok(s1.browse({ limit: 10 }).items[0].preview.startsWith('Alpha'));
  s1.close();
  const s2 = new MemoryStore(two.path, 'dafeiyu');
  assert.ok(s2.browse({ limit: 10 }).items[0].preview.startsWith('Bravo'));
  s2.close();

  // 源库必须完好无损——迁移是复制，不是搬移
  const src = new MemoryStore(sourcePath, 'dafeiyu');
  assert.equal(src.browse({ limit: 10 }).total, 2);
  src.close();
});

test('S6 splitBankIntoScopes is idempotent', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-split2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, 'memory.sqlite3');
  const source = new MemoryStore(sourcePath, 'dafeiyu');
  source.capture({ session: 'session-A@1000', eventKey: '1', role: 'user', content: 'Alpha only once.', sourceTime: 1000 });
  source.close();
  const registry = { list: () => [{ id: 'aaaaaaaa-1111', title: 'One', sessionIds: ['session-A'] }] };
  const first = splitBankIntoScopes({ workspaceRegistry: registry }, sourcePath, 'dafeiyu', dir);
  assert.equal(first.results[0].copied, 1);
  const second = splitBankIntoScopes({ workspaceRegistry: registry }, sourcePath, 'dafeiyu', dir);
  assert.equal(second.results[0].copied, 0, 're-running must not duplicate rows');
  assert.equal(second.results[0].skipped, 1);
  const target = new MemoryStore(first.results[0].path, 'dafeiyu');
  assert.equal(target.browse({ limit: 10 }).total, 1);
  target.close();
});

test('S7 a workspace without an id is skipped instead of colliding', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-split3-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, 'memory.sqlite3');
  const source = new MemoryStore(sourcePath, 'dafeiyu');
  source.capture({ session: 'session-A@1000', eventKey: '1', role: 'user', content: 'Alpha content here.', sourceTime: 1000 });
  source.close();
  // 缺 id 的工作区绝不能回退成 workspace-undefined.sqlite3 而互相覆盖
  const registry = { list: () => [{ title: 'NoId', sessionIds: ['session-A'] }] };
  const result = splitBankIntoScopes({ workspaceRegistry: registry }, sourcePath, 'dafeiyu', dir);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].error, '工作区缺少 id，已跳过');
  assert.ok(!existsSync(join(dir, 'workspace-.sqlite3')));
});

test('S8 strictScope defaults off so existing installs keep recording everything', () => {
  assert.equal(options({}).strictScope, false);
  assert.equal(options({}).scopeDirectory, '');
  assert.equal(options({ strictScope: true }).strictScope, true);
});

// ── S9：工作区新增会话后，范围必须立即跟上 ──────────────────────────────
// 轻量 fixture：只实现 attach() 需要的 ctx 接口，用于验证范围门禁。
function scopeFixture(initialConfig, sessions, workspaces) {
  const handlers = new Map();
  const disposers = [];
  const ctx = {
    sessions: { list: () => sessions, get: id => sessions.find(s => s.id === id) },
    sessionQuery: {
      listSessions: async () => sessions.map(s => ({ header: s.header, live: true, persisted: true })),
      readSession: async id => ({ events: sessions.find(s => s.id === id)?.events ?? [] }),
      readTitleSnapshots: async ids => ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { title: { title: id } } })),
    },
    workspaceRegistry: { list: () => workspaces, get: id => workspaces.find(w => w.id === id) ?? null },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); },
    effect(effect) { const d = effect(); if (typeof d === 'function') disposers.push(d); return d; },
  };
  const store = new MemoryStore(initialConfig.database);
  const controller = attach(ctx, store, { includeSubagents: false, autoRecall: false, ...initialConfig }, () => {});
  return {
    store,
    emitEvent(session, event) { const h = handlers.get('session/event'); if (h) h(session, event); },
    async close() { controller.close(); for (const d of disposers.reverse()) await d(); },
  };
}

function scopeSession(id, events = []) {
  return { id, header: { id, createdAt: 1000, origin: 'user', cwd: `C:/work/${id}` }, inheritedEventCount: 0, events };
}

function scopeEvent(sessionId, text, seq = 1) {
  return {
    seq, type: 'user/message', surfaceOp: 'append', time: 1000 + seq,
    data: { source: { kind: 'user' }, id: `msg-${sessionId}-${seq}`, role: 'user', content: text, interrupted: false },
  };
}

test('S9 a workspace that gains a session becomes writable without restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dafeiyu-grow-'));
  const sessions = [];
  const workspaces = [{ id: 'ws-1', title: 'WS', sessionIds: [] }];
  const fixture = scopeFixture(
    { database: join(directory, 'memory.sqlite3'), strictScope: true, bindingMode: 'workspace', bindingWorkspaceId: 'ws-1' },
    sessions, workspaces,
  );
  t.after(async () => { await fixture.close(); rmSync(directory, { recursive: true, force: true }); });

  assert.equal(fixture.store.browse({ limit: 10 }).total, 0, 'an empty workspace records nothing');

  // 用户在该工作区新建会话：registry 与 sessions 同步增长
  const fresh = scopeSession('session-new');
  sessions.push(fresh);
  workspaces[0].sessionIds.push('session-new');
  const event = scopeEvent('session-new', 'A brand new conversation in this workspace.');
  fresh.events.push(event);

  fixture.emitEvent(fresh, event);

  const page = fixture.store.browse({ limit: 10 });
  assert.equal(page.total, 1, 'the new session must be recorded as soon as the workspace lists it');
  assert.ok(page.items[0].preview.startsWith('A brand new'));
});

test('S10 sessions outside the scope are never written in strict mode', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dafeiyu-deny-'));
  const inside = scopeSession('session-in');
  const outside = scopeSession('session-out');
  const fixture = scopeFixture(
    { database: join(directory, 'memory.sqlite3'), strictScope: true, bindingMode: 'workspace', bindingWorkspaceId: 'ws-1' },
    [inside, outside], [{ id: 'ws-1', title: 'WS', sessionIds: ['session-in'] }],
  );
  t.after(async () => { await fixture.close(); rmSync(directory, { recursive: true, force: true }); });

  fixture.emitEvent(inside, scopeEvent('session-in', 'Inside the scope, this should be stored.'));
  fixture.emitEvent(outside, scopeEvent('session-out', 'Outside the scope, this must be dropped.'));
  const page = fixture.store.browse({ limit: 10 });
  assert.equal(page.total, 1);
  assert.ok(page.items[0].preview.startsWith('Inside the scope'));
});

test('S11 strict mode off keeps recording every session', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dafeiyu-off-'));
  const a = scopeSession('session-a');
  const b = scopeSession('session-b');
  const fixture = scopeFixture(
    { database: join(directory, 'memory.sqlite3'), strictScope: false, bindingMode: 'workspace', bindingWorkspaceId: 'ws-1' },
    [a, b], [{ id: 'ws-1', title: 'WS', sessionIds: ['session-a'] }],
  );
  t.after(async () => { await fixture.close(); rmSync(directory, { recursive: true, force: true }); });

  fixture.emitEvent(a, scopeEvent('session-a', 'Session A content is recorded.'));
  fixture.emitEvent(b, scopeEvent('session-b', 'Session B is outside the binding but recorded too.'));
  assert.equal(fixture.store.browse({ limit: 10 }).total, 2, 'without strict mode the old behaviour must hold');
});

// ── 孤儿记忆与删除 ────────────────────────────────────────────────────────
test('D1 sessionInventory flags sessions no longer in the live set', t => {
  const store = tempStore(t);
  store.capture({ session: 'session-live@1000', eventKey: '1', role: 'user', content: 'Live session content here.', sourceTime: 1000 });
  store.capture({ session: 'session-gone@1000', eventKey: '1', role: 'user', content: 'Orphan session content here.', sourceTime: 1001 });
  store.capture({ session: 'session-gone@2000', eventKey: '1', role: 'user', content: 'Orphan again with another timestamp.', sourceTime: 1002 });
  const inv = store.sessionInventory({ liveSessionIds: ['session-live'] });
  assert.equal(inv.items.length, 3);
  assert.equal(inv.orphanSessions, 2, 'both @createdAt variants of the dead session are orphans');
  assert.equal(inv.orphanMessages, 2);
  const live = inv.items.find(item => item.sessionId === 'session-live');
  assert.equal(live.orphan, false);
});

test('D2 deleteSessions removes every variant of a session and keeps the rest', t => {
  const store = tempStore(t);
  store.capture({ session: 'session-gone@1000', eventKey: '1', role: 'user', content: 'Orphan one content.', sourceTime: 1000 });
  store.capture({ session: 'session-gone@2000', eventKey: '1', role: 'user', content: 'Orphan two content.', sourceTime: 2001 });
  store.capture({ session: 'session-live@1000', eventKey: '1', role: 'user', content: 'Live content must survive.', sourceTime: 1002 });
  store.sleep(100);
  const before = store.stats();
  assert.equal(before.messages, 3);

  const result = store.deleteSessions(['session-gone']);
  assert.equal(result.messages, 2, 'both @createdAt variants must go');
  assert.equal(result.chunks, 2);
  const after = store.stats();
  assert.equal(after.messages, 1);
  assert.equal(after.chunks, 1);
  const remaining = store.browse({ limit: 10 });
  assert.equal(remaining.total, 1);
  assert.ok(remaining.items[0].preview.startsWith('Live content'));
});

test('D3 deleteSessions leaves no dangling index rows', t => {
  const store = tempStore(t);
  store.capture({ session: 'session-gone@1000', eventKey: '1', role: 'user', content: 'Doomed content with several words to index.', sourceTime: 1000 });
  store.sleep(100);
  const chunkId = Number(store.db.prepare('SELECT id FROM chunks LIMIT 1').get().id);
  store.reinforce(chunkId, 'probe');
  store.deleteSessions(['session-gone']);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM chunks').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM search_index').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM activations').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM groups').get().n, 0);
  // 维护任务在删除后仍然可运行，不会因为悬空行报错
  assert.doesNotThrow(() => store.sleep(100));
  assert.doesNotThrow(() => store.replay(5));
});

test('D4 deleteSessions with an empty list is a no-op', t => {
  const store = tempStore(t);
  store.capture({ session: 'session-a@1000', eventKey: '1', role: 'user', content: 'Untouched content.', sourceTime: 1000 });
  assert.deepEqual(store.deleteSessions([]), { messages: 0, chunks: 0 });
  assert.deepEqual(store.deleteSessions(null), { messages: 0, chunks: 0 });
  assert.equal(store.stats().messages, 1);
});

test('D5 panelScopeIds falls back to list() when get() returns null', async t => {
  // registry.get 在会话被删后可能返回 null，此时必须回退到 list() 按 id 查找，
  // 否则会把"有记忆的工作区"误判成空范围（面板 0 / 全库 4）。
  const directory = mkdtempSync(join(tmpdir(), 'dafeiyu-fallback-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspaces = [{ id: 'ws-1', title: 'WS', sessionIds: ['session-a'] }];
  const store = new MemoryStore(join(directory, 'memory.sqlite3'));
  store.capture({ session: 'session-a@1000', eventKey: '1', role: 'user', content: 'Scoped content here.', sourceTime: 1000 });
  const ctx = {
    workspaceRegistry: {
      get: () => null,                    // 模拟 DSH 内存态已摘除
      list: () => workspaces,             // 磁盘态仍在
    },
  };
  const resolved = panelScopeIds(ctx, { bindingMode: 'workspace', bindingWorkspaceId: 'ws-1' });
  assert.deepEqual(resolved, ['session-a'], 'the fallback must still find the workspace');
  const scoped = store.browse({ limit: 10, sessionIds: resolved });
  assert.equal(scoped.total, 1, 'scoped view must not collapse to zero');
  store.close();
});

// ── D6：孤儿记忆必须在面板里可见（范围 ∪ 库内会话）────────────────────────
test('D6 orphan memories stay visible even after the workspace drops the session', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dafeiyu-orphan-visible-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'workspace-1.sqlite3');
  const seed = new MemoryStore(dbPath);
  // 一个已经死掉的会话留下的记忆
  seed.capture({ session: 'session-dead@1000', eventKey: '1', role: 'user', content: 'Memory left behind by a deleted session.', sourceTime: 1000 });
  seed.close();

  // DSH 重启后，工作区已把死会话剔除，sessionIds 变成空
  const workspaces = [{ id: 'ws-1', title: 'WS', sessionIds: [] }];
  const store = new MemoryStore(dbPath);
  const ctx = { workspaceRegistry: { get: id => workspaces.find(w => w.id === id) ?? null, list: () => workspaces } };
  const value = { bindingMode: 'workspace', bindingWorkspaceId: 'ws-1' };

  // 只用 panelScopeIds 会得到空数组 —— 这正是用户看到"本范围 0 / 全库 4"的原因
  assert.deepEqual(panelScopeIds(ctx, value), []);

  // panelQuerySessions 必须把库内已有会话并进来，否则孤儿既看不见也删不掉
  const sessions = panelQuerySessions(ctx, value, store);
  assert.ok(sessions.includes('session-dead'), 'the stored session must be included');

  const page = store.browse({ limit: 10, sessionIds: sessions });
  assert.equal(page.total, 1, 'the orphan memory must remain visible');
  const stats = store.storageStats({ sessionIds: sessions });
  assert.equal(stats.messages, 1);

  // 同时它必须被标记为孤儿，供面板提供删除入口
  const inv = store.sessionInventory({ liveSessionIds: [] });
  assert.equal(inv.orphanMessages, 1);
  store.close();
});

// ── D7：删除后数据真的消失，且不影响同库其他会话 ─────────────────────────
test('D7 deleting an orphan leaves the rest of the library intact', t => {
  const store = tempStore(t);
  store.capture({ session: 'session-dead@1000', eventKey: '1', role: 'user', content: 'Orphan memory to remove.', sourceTime: 1000 });
  store.capture({ session: 'session-live@1000', eventKey: '1', role: 'user', content: 'Live memory to keep.', sourceTime: 1001 });
  store.sleep(100);
  assert.equal(store.stats().messages, 2);

  const result = store.deleteSessions(['session-dead']);
  assert.equal(result.messages, 1);
  assert.equal(store.stats().messages, 1);

  const inv = store.sessionInventory({ liveSessionIds: ['session-live'] });
  assert.equal(inv.orphanMessages, 0, 'no orphans remain after cleanup');
  assert.equal(inv.items.length, 1);
  assert.equal(inv.items[0].sessionId, 'session-live');
  assert.doesNotThrow(() => store.sleep(100));
});

// ── D8：未归属任何工作区的会话必须收进 unassigned 库 ──────────────────────
test('D8 split collects unassigned sessions into an unassigned library', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-unassigned-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, 'memory.sqlite3');
  const source = new MemoryStore(sourcePath, 'dafeiyu');
  source.capture({ session: 'session-A@1', eventKey: '1', role: 'user', content: 'Assigned to a workspace.', sourceTime: 1000 });
  source.capture({ session: 'session-ORPHAN@1', eventKey: '1', role: 'user', content: 'Belongs to no workspace at all.', sourceTime: 1001 });
  source.close();

  const registry = { list: () => [{ id: 'ws-aaaa', title: 'One', sessionIds: ['session-A'] }] };
  const result = splitBankIntoScopes({ workspaceRegistry: registry }, sourcePath, 'dafeiyu', dir);
  assert.equal(result.ok, true);
  const unassigned = result.results.find(item => item.unassigned);
  assert.ok(unassigned, 'an unassigned bucket must be produced');
  assert.equal(unassigned.copied, 1);
  const target = new MemoryStore(unassigned.path, 'dafeiyu');
  const page = target.browse({ limit: 10 });
  assert.equal(page.total, 1);
  assert.ok(page.items[0].preview.startsWith('Belongs to no workspace'));
  target.close();
  // 源库仍然完整
  const after = new MemoryStore(sourcePath, 'dafeiyu');
  assert.equal(after.browse({ limit: 10 }).total, 2);
  after.close();
});

// ── D9：session 模式严格按绑定，不并入库内其他会话 ────────────────────────
test('D9 session mode never widens the scope to other stored sessions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-session-strict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryStore(join(dir, 'm.sqlite3'));
  store.capture({ session: 'session-other@1', eventKey: '1', role: 'user', content: 'Not selected by the user.', sourceTime: 1000 });
  const value = { bindingMode: 'session', bindingSessionIds: ['session-picked'] };
  const sessions = panelQuerySessions({}, value, store);
  assert.deepEqual(sessions, ['session-picked'], 'session mode must not add stored sessions');
  // workspace 模式才需要并集
  const wsValue = { bindingMode: 'workspace', bindingWorkspaceId: 'ws-1' };
  const wsSessions = panelQuerySessions({}, wsValue, store);
  assert.ok(wsSessions.includes('session-other'), 'workspace mode must surface stored orphans');
  store.close();
});

// ── D10：registry 抛异常时面板不得崩溃 ────────────────────────────────────
test('D10 a throwing workspace registry degrades to an empty scope', () => {
  const ctx = { workspaceRegistry: { get: () => { throw new Error('boom'); }, list: () => { throw new Error('boom'); } } };
  const value = { bindingMode: 'workspace', bindingWorkspaceId: 'ws-1' };
  assert.doesNotThrow(() => panelScopeIds(ctx, value), 'a broken registry must not take the panel down');
  assert.deepEqual(panelScopeIds(ctx, value), []);
});

// ── S12：切换绑定范围必须立即换库，不必等重载 ────────────────────────────
// 完整插件 fixture：走真正的 apply()，用于验证热切换与配置往返。
// 通过 browse/settings 两个 RPC 观察状态，不直接暴露内部 store 实例。
function pluginFixture(initialConfig, sessions, workspaces) {
  const routes = new Map();
  const disposers = [];
  const config = { ...initialConfig };
  const logs = new Map(sessions.map(s => [s.id, s.events ?? []]));
  const handlers = new Map();
  let revision = 1;
  const editor = {
    async edit(entry, change) {
      const next = change({ ...config }, { ...config });
      for (const key of Object.keys(config)) if (!Object.hasOwn(next, key)) delete config[key];
      Object.assign(config, next);
      revision++;
    },
  };
  const settings = {
    describe: () => [{ ns: 'include:dafeiyu-memory', revision, applies: 'live', value: { ...config } }],
    async update(ns, patch, expected) {
      if (expected !== undefined && expected !== revision) throw new Error('stale settings revision');
      Object.assign(config, patch); revision++;
    },
    async mutate(ns, operations, expected) {
      if (expected !== undefined && expected !== revision) throw new Error('stale settings revision');
      for (const op of operations) if (op.op === 'unset') delete config[op.path[0]];
      revision++;
    },
  };
  const ctx = {
    connection: { fetch: { register(def) { routes.set(def.path, def); return () => routes.delete(def.path); } } },
    fiber: { entry: { options: { id: 'dafeiyu-memory', name: 'dsh-dafeiyu-memory' } } },
    settings,
    get: key => (key === 'configEditor' ? editor : undefined),
    sessions: { list: () => sessions, get: id => sessions.find(s => s.id === id) },
    sessionQuery: {
      listSessions: async () => sessions.map(s => ({ header: s.header, live: true, persisted: true })),
      readSession: async id => ({ events: logs.get(id) ?? [] }),
      readTitleSnapshots: async ids => ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { title: { title: id } } })),
    },
    workspaceRegistry: { list: () => workspaces, get: id => workspaces.find(w => w.id === id) ?? null },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); },
    effect(effect) { const d = effect(); if (typeof d === 'function') disposers.push(d); return d; },
  };
  apply(ctx, config);
  const post = async (path, payload) => {
    const route = routes.get(path);
    if (!route) throw new Error(`route missing: ${path}`);
    const response = await route.fetch(new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: path.replace('/api/',''), payload }),
    }));
    return response.json();
  };
  return {
    config,
    emitEvent(session, event) { const h = handlers.get('session/event'); if (h) h(session, event); },
    invokeSettings: payload => post('/api/dafeiyu-memory/settings', payload),
    async browse(payload) {
      const envelope = await post('/api/dafeiyu-memory/browse', payload);
      const result = envelope?.result;
      if (!result || result.ok !== true) throw new Error('browse failed: ' + JSON.stringify(result?.error ?? result));
      return result.value;
    },
    async close() { for (const d of disposers.reverse()) await d(); },
  };
}

// ── S12：切换绑定范围必须立即换库，不必等重载 ────────────────────────────
test('S12 switching workspace target swaps the live database in one save', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-hotswap-'));
  const sessions = [scopeSession('session-a'), scopeSession('session-b')];
  const workspaces = [
    { id: 'ws-1', title: 'One', sessionIds: ['session-a'] },
    { id: 'ws-2', title: 'Two', sessionIds: ['session-b'] },
  ];
  const fixture = pluginFixture(
    { database: join(dir, 'base.sqlite3'), scopeDirectory: dir, strictScope: true, bindingMode: 'workspace', bindingWorkspaceId: 'ws-1' },
    sessions, workspaces,
  );
  t.after(async () => { await fixture.close(); rmSync(dir, { recursive: true, force: true }); });

  // 启动时的自动回灌是异步的，先等它稳定，避免与后续写入交错
  await new Promise(resolve => setTimeout(resolve, 50));
  fixture.emitEvent(sessions[0], scopeEvent('session-a', 'Content belonging to workspace one.'));

  // 启动时就已经在 ws-1 的范围库里
  const before = await fixture.browse({ action: 'page', limit: 10 });
  assert.equal(before.total, 1, 'workspace one content must be readable before switching');

  // 只保存一次就必须完成切换
  const response = await fixture.invokeSettings({ action: 'set-workspace-target', workspaceId: 'ws-2' });
  assert.equal(response.result.ok, true, response.result.error?.message);
  const switched = response.result.value.scopeSwitch;
  assert.ok(switched, 'the response must report the scope switch');
  assert.equal(switched.switched, true, 'the live store must be swapped in this same call');
  assert.ok(response.result.value.databasePath.includes('workspace-'), 'must report the new library');

  // 新库独立：看不到 ws-1 的内容
  const afterSwitch = await fixture.browse({ action: 'page', limit: 10 });
  assert.equal(afterSwitch.total, 0, 'the new scope library starts empty');

  // 切回 ws-1，旧内容仍在
  const back = await fixture.invokeSettings({ action: 'set-workspace-target', workspaceId: 'ws-1' });
  assert.equal(back.result.ok, true, back.result.error?.message);
  const restored = await fixture.browse({ action: 'page', limit: 10 });
  assert.equal(restored.total, 1, 'switching back must restore the earlier library');
  assert.ok(restored.items[0].preview.startsWith('Content belonging to workspace one'));
});

// ── S13：inspect-scope 报告已有记忆，供切换前提示 ────────────────────────
test('S13 inspect-scope reports an existing library for a target workspace', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-inspect-'));
  const sessions = [scopeSession('session-a')];
  const workspaces = [{ id: 'ws-1', title: 'One', sessionIds: ['session-a'] }];
  const fixture = pluginFixture(
    { database: join(dir, 'base.sqlite3'), scopeDirectory: dir, strictScope: true, bindingMode: 'workspace', bindingWorkspaceId: 'ws-1' },
    sessions, workspaces,
  );
  t.after(async () => { await fixture.close(); rmSync(dir, { recursive: true, force: true }); });

  fixture.emitEvent(sessions[0], scopeEvent('session-a', 'Something worth keeping in this scope.'));
  const response = await fixture.invokeSettings({ action: 'inspect-scope', bindingMode: 'workspace', workspaceId: 'ws-1' });
  assert.equal(response.result.ok, true, response.result.error?.message);
  assert.equal(response.result.value.exists, true);
  assert.equal(response.result.value.messages, 1);
  assert.ok(response.result.value.path.includes('workspace-'));
});