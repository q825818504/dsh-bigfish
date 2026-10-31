#!/usr/bin/env node
/**
 * 开发期回灌脚本：把 DSH session 日志里的真实对话写进大肥鱼记忆库。
 *
 * 为什么单独写一个脚本而不改插件：
 *   - 插件本身的 adapter.sync() 已经在运行时做回灌，但只在插件启动时跑，
 *     而且受 strictScope 限制（只回灌当前绑定范围）。
 *   - 这个脚本用于开发期一次性把历史会话灌满，方便验收星图效果。
 *   - 不修改 lib/ 下任何文件，只调用 MemoryStore 的公开方法 capture()。
 *
 * 用法：
 *   node dev-backfill.js <目标库路径> [--limit N] [--dry]
 */
import { MemoryStore } from './lib/store.js';
import { zstdDecompressSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** zstd 多帧解压：DSH 按帧追加写入，单次解压只得到第一帧。 */
function decodeAllFrames(buf) {
  const out = [];
  let offset = 0;
  while (offset < buf.length) {
    const rest = buf.subarray(offset);
    try {
      out.push(zstdDecompressSync(rest));
    } catch {
      break;
    }
    let next = -1;
    for (let i = 4; i < rest.length - 3; i++) {
      if (rest[i] === ZSTD_MAGIC[0] && rest[i + 1] === ZSTD_MAGIC[1]
        && rest[i + 2] === ZSTD_MAGIC[2] && rest[i + 3] === ZSTD_MAGIC[3]) { next = i; break; }
    }
    if (next < 0) break;
    offset += next;
  }
  return Buffer.concat(out);
}

/** 递归找出所有 session.v4.jsonl.zstd */
function findSessionFiles(root) {
  const found = [];
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'session.v4.jsonl.zstd') found.push(p);
    }
  };
  walk(root);
  return found;
}

/** 从消息事件里取纯文本。
 *  DSH v4 事件结构：{ type, seq, time, data: { content: [{type:'text',text}], role } }
 */
function textOf(event) {
  const c = event?.data?.content ?? event?.message?.content ?? event?.content ?? event?.text;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .map(part => (typeof part === 'string' ? part : part?.type === 'text' ? part.text ?? '' : ''))
    .filter(Boolean)
    .join('\n');
}

const target = process.argv[2];
if (!target) {
  console.error('用法: node dev-backfill.js <目标库路径> [--limit N] [--dry]');
  process.exit(1);
}
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
const dry = process.argv.includes('--dry');

const sessionsRoot = join(process.env.DSH_HOME || 'C:/Users/Alime/.dsh', 'sessions');
const files = findSessionFiles(sessionsRoot);
console.log(`发现 ${files.length} 个会话文件`);

const store = dry ? null : new MemoryStore(target, 'dafeiyu');
let captured = 0;
let skipped = 0;
const perSession = [];

for (const file of files) {
  let buf;
  try { buf = readFileSync(file); } catch { continue; }
  if (!buf.length) continue;
  const text = decodeAllFrames(buf).toString('utf8');
  const lines = text.split('\n').filter(Boolean);

  let sessionId = '';
  const records = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'session' && o.id) { sessionId = o.id; continue; }
    if (o.type === 'user/message') records.push({ role: 'user', event: o });
    else if (o.type === 'assistant/message') records.push({ role: 'assistant', event: o });
  }
  if (!sessionId || !records.length) continue;

  let added = 0;
  for (const { role, event } of records) {
    if (captured >= limit) break;
    const body = textOf(event).trim();
    if (!body) { skipped++; continue; }
    // eventKey 用 session 内序号，保证重跑幂等（UNIQUE(bank,session,event_key)）
    const seq = event.seq ?? event.eventSeq ?? event.index;
    const eventKey = seq === undefined || seq === null
      ? `backfill:${role}:${records.indexOf(event)}`
      : String(seq);
    const sourceTime = Number(event.at ?? event.time ?? event.createdAt) || null;
    if (!dry) {
      try {
        store.capture({
          session: sessionId,
          eventKey,
          role,
          content: [{ type: 'text', text: body }],
          sourceTime,
        });
        added++;
        captured++;
      } catch {
        skipped++;
      }
    } else {
      added++; captured++;
    }
  }
  if (added) perSession.push({ session: sessionId, added });
}

console.log(`\n回灌完成${dry ? '（dry-run，未写库）' : ''}`);
console.log(`写入 ${captured} 条，跳过 ${skipped} 条`);
console.log(`涉及 ${perSession.length} 个会话`);
for (const s of perSession.slice(0, 30)) console.log(`  ${s.session}  +${s.added}`);
if (store) {
  const stats = store.stats();
  console.log('\n当前库统计:', JSON.stringify(stats.messages !== undefined ? stats : stats, null, 1).slice(0, 600));
  store.close();
}
