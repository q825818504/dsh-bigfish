import { DatabaseSync, backup } from 'node:sqlite';
import { copyFileSync, mkdirSync, existsSync, rmSync, statSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const DAY = 86400000;
const HALF = { fleeting: 7, episodic: 30, durable: 180 };
const STOP = new Set(['的','了','吗','呢','我','你','他','它','是','在','和','有','就','啊','the','a','is','and']);
export function terms(text) {
  const result = [];
  for (const run of text.toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9_]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(run)) {
      const chars = [...run];
      for (let i = 0; i < chars.length; i++) {
        if (!STOP.has(chars[i])) result.push(chars[i]);
        if (i + 1 < chars.length) result.push(chars[i] + chars[i+1]);
      }
    } else if (!STOP.has(run)) result.push(run);
  }
  return [...new Set(result)];
}
export function textOf(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
}
function integer(n, min, max) {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Expected integer ${min}..${max}`);
  return n;
}
function digest(s) { return createHash('sha256').update(s).digest('hex'); }
function sessionScopeFilter(sessionIds, alias = 'm') {
  if (sessionIds === undefined || sessionIds === null) return { sql: '', params: [] };
  if (!Array.isArray(sessionIds) || sessionIds.some(id => typeof id !== 'string' || !id)) {
    throw new Error('Invalid memory session scope');
  }
  const ids = [...new Set(sessionIds)];
  if (!ids.length) return { sql: ' AND 0', params: [] };
  return {
    sql: ` AND EXISTS (SELECT 1 FROM json_each(?) AS scope WHERE substr(${alias}.session,1,length(scope.value)+1)=scope.value || '@')`,
    params: [JSON.stringify(ids)],
  };
}

export class MemoryStore {
  constructor(path, bank = 'dafeiyu') {
    if (!bank || typeof bank !== 'string') throw new Error('bank is required');
    this.bank = bank;
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); throw new Error('Unsupported database version (use import-v02 for Python prototypes)'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, bank TEXT NOT NULL, session TEXT NOT NULL, event_key TEXT NOT NULL,
        role TEXT NOT NULL, text TEXT NOT NULL, content_json TEXT NOT NULL, source_message_id TEXT,
        recorded_at INTEGER NOT NULL, source_time INTEGER, interrupted INTEGER NOT NULL DEFAULT 0,
        UNIQUE(bank,session,event_key));
      CREATE INDEX IF NOT EXISTS messages_bank_session ON messages(bank,session,id);
      CREATE INDEX IF NOT EXISTS messages_bank_time ON messages(bank,source_time);
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY, message INTEGER NOT NULL REFERENCES messages(id), start INTEGER NOT NULL,
        end INTEGER NOT NULL, text TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'episodic',
        importance REAL NOT NULL DEFAULT 0.5, activated INTEGER NOT NULL, boosts INTEGER NOT NULL DEFAULT 0,
        last_boost INTEGER, UNIQUE(message,start));
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(terms, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS anchors (
        id INTEGER PRIMARY KEY, bank TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(bank,name));
      CREATE TABLE IF NOT EXISTS aliases (anchor INTEGER REFERENCES anchors(id), alias TEXT NOT NULL, PRIMARY KEY(anchor,alias));
      CREATE TABLE IF NOT EXISTS anchor_sources (anchor INTEGER REFERENCES anchors(id), chunk INTEGER REFERENCES chunks(id), PRIMARY KEY(anchor,chunk));
      CREATE TABLE IF NOT EXISTS activations (bank TEXT NOT NULL, chunk INTEGER REFERENCES chunks(id), event_key TEXT NOT NULL,
        at INTEGER NOT NULL, PRIMARY KEY(bank,chunk,event_key));
      CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY, bank TEXT NOT NULL, at INTEGER NOT NULL,
        kind TEXT NOT NULL, chars INTEGER NOT NULL, sources TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS housekeeping (bank TEXT PRIMARY KEY, last_chunk INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS groups (chunk INTEGER PRIMARY KEY REFERENCES chunks(id), bank TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replays (chunk INTEGER PRIMARY KEY REFERENCES chunks(id), at INTEGER NOT NULL);
      PRAGMA user_version=1;
    `);
  }
  static inspectDatabase(path, bank = 'dafeiyu') {
    if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) throw new Error('Cannot inspect a database while WAL/SHM sidecars exist');
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'dafeiyu-memory-inspect-'));
    const temporaryPath = join(temporaryDirectory, 'candidate.sqlite3');
    try {
      copyFileSync(path, temporaryPath);
      const db = new DatabaseSync(temporaryPath, { readOnly: true });
      try {
        const integrity = db.prepare('PRAGMA integrity_check').all().map(row => String(row.integrity_check ?? Object.values(row)[0] ?? 'unknown'));
        const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
        const required = ['messages','chunks','search_index','anchors','aliases','anchor_sources','activations','ledger','housekeeping','groups','replays'];
        const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name));
        const userTables = tableNames.filter(name => !name.startsWith('sqlite_') && !name.startsWith('search_index_'));
        const missingTables = required.filter(name => !userTables.includes(name));
        const extraTables = userTables.filter(name => !required.includes(name));
        const foreignBanks = [];
        for (const table of ['messages','anchors','activations','ledger','housekeeping','groups']) {
          const row = db.prepare(`SELECT bank FROM ${table} WHERE bank<>? LIMIT 1`).get(bank);
          if (row) foreignBanks.push(String(row.bank));
        }
        const details = [];
        if (integrity.length !== 1 || integrity[0] !== 'ok') details.push(`integrity_check: ${integrity.join('; ') || 'no result'}`);
        if (userVersion !== 1) details.push(`unsupported schema version ${userVersion}`);
        if (missingTables.length) details.push(`missing tables: ${missingTables.join(', ')}`);
        if (extraTables.length) details.push(`unexpected tables: ${extraTables.join(', ')}`);
        if (foreignBanks.length) details.push(`other banks are present: ${[...new Set(foreignBanks)].join(', ')}`);
        return { ok: details.length === 0, details: details.length ? details : ['ok'], userVersion, foreignBanks: [...new Set(foreignBanks)] };
      } finally {
        db.close();
      }
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
  close() { this.db.close(); }
  integrityCheck() {
    const rows=this.db.prepare('PRAGMA integrity_check').all();
    const details=rows.map(row=>String(row.integrity_check??Object.values(row)[0]??'unknown'));
    return {ok:details.length===1&&details[0]==='ok',details};
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  // Called only by the trusted DSH adapter/importer, never exposed as a model tool.
  capture({ session, eventKey, sourceMessageId = null, role, content, sourceTime = null, interrupted = false }) {
    if (!session || !eventKey || !['user','assistant'].includes(role)) throw new Error('Invalid capture');
    const text = textOf(content);
    if (!text && (!Array.isArray(content) || !content.length)) return null;
    if (sourceTime !== null && (!Number.isSafeInteger(sourceTime) || sourceTime < 0)) throw new Error('Invalid host event time');
    return this.transaction(() => {
      const now = Date.now();
      const saved = this.db.prepare(`INSERT OR IGNORE INTO messages(bank,session,event_key,role,text,content_json,source_message_id,recorded_at,source_time,interrupted)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(this.bank, session, eventKey, role, text, JSON.stringify(content), sourceMessageId, now, sourceTime, Number(interrupted));
      if (!saved.changes) return null;
      const mid = Number(saved.lastInsertRowid);
      // Lossless full original on disk, small overlapping excerpts in the search index.
      for (let start = 0; start < text.length; start += 640) {
        const end = Math.min(text.length, start + 800);
        const part = text.slice(start, end);
        const row = this.db.prepare('INSERT INTO chunks(message,start,end,text,activated) VALUES (?,?,?,?,?)').run(mid,start,end,part,now);
        this.db.prepare('INSERT INTO search_index(rowid,terms) VALUES (?,?)').run(Number(row.lastInsertRowid),terms(part).join(' '));
        if (end === text.length) break;
      }
      return mid;
    });
  }
  chunk(id, { sessionIds } = {}) {
    integer(id,1,Number.MAX_SAFE_INTEGER);
    const scope = sessionScopeFilter(sessionIds);
    const row = this.db.prepare(`SELECT c.*,m.bank,m.session,m.event_key,m.role,m.source_time,m.recorded_at,m.interrupted
      FROM chunks c JOIN messages m ON m.id=c.message WHERE c.id=? AND m.bank=?${scope.sql}`).get(id,this.bank,...scope.params);
    if (!row) throw new Error(sessionIds === undefined ? 'Memory not found in this bank' : 'Memory not found in this scope');
    return row;
  }
  state(row, now=Date.now()) {
    const half = HALF[row.category] * (0.5 + row.importance * 1.5) * (1 + Math.min(row.boosts,8)*0.25);
    const strength = 2 ** (-Math.max(0,now-row.activated)/DAY/half);
    return { halfLifeDays: half, strength, layer: strength >= .5 ? 'active' : strength >= .1 ? 'warm' : 'cold' };
  }
  configure(id, {category='episodic',importance=.5}={}) {
    this.chunk(id);
    if (!Object.hasOwn(HALF,category) || !Number.isFinite(importance) || importance<0 || importance>1) throw new Error('Invalid importance/category');
    this.db.prepare('UPDATE chunks SET category=?,importance=? WHERE id=?').run(category,importance,id);
  }
  reinforce(id,eventKey) {
    if (!eventKey) throw new Error('Host event key required');
    return this.transaction(() => {
      const row=this.chunk(id), now=Date.now();
      const saved=this.db.prepare('INSERT OR IGNORE INTO activations VALUES (?,?,?,?)').run(this.bank,id,eventKey,now);
      if (!saved.changes) return false;
      const boost=row.last_boost===null || now-row.last_boost>=DAY;
      this.db.prepare('UPDATE chunks SET activated=?,boosts=MIN(8,boosts+?),last_boost=? WHERE id=?').run(now,Number(boost),boost?now:row.last_boost,id);
      return true;
    });
  }
  anchor(name,ids,aliases=[]) {
    if (!name?.trim() || !ids.length) throw new Error('Anchor name and source IDs required');
    for(const id of ids) this.chunk(id);
    const names=[...new Set([name,...aliases].map(s=>s.trim().toLowerCase()))];
    if(names.some(s=>s.length<2 || s.length>120)) throw new Error('Alias length must be 2..120');
    return this.transaction(()=>{
      this.db.prepare('INSERT OR IGNORE INTO anchors(bank,name) VALUES (?,?)').run(this.bank,name);
      const id=this.db.prepare('SELECT id FROM anchors WHERE bank=? AND name=?').get(this.bank,name).id;
      for(const alias of names) this.db.prepare('INSERT OR IGNORE INTO aliases VALUES (?,?)').run(id,alias);
      for(const source of ids) this.db.prepare('INSERT OR IGNORE INTO anchor_sources VALUES (?,?)').run(id,source);
      return id;
    });
  }
  search(query,{limit=5,archive=false,excludeSession=null,excludeSourceId=null,since=null,before=null,sessionIds,excludeIds}={}) {
    integer(limit,1,20);
    const scope = sessionScopeFilter(sessionIds);
    const wanted=terms(String(query)).filter(t=>t.length>1).slice(0,64);
    const fallback=terms(String(query)).slice(0,64);
    const selected=wanted.length?wanted:fallback;
    const scores=new Map(), reasons=new Map();
    if(selected.length){
      const match=selected.map(t=>'"'+t.replaceAll('"','""')+'"').join(' OR ');
      const rows=this.db.prepare(`SELECT c.id,bm25(search_index) rank FROM search_index JOIN chunks c ON c.id=search_index.rowid
        JOIN messages m ON m.id=c.message WHERE search_index MATCH ? AND m.bank=?${scope.sql}
        AND (? IS NULL OR m.session<>?) AND (? IS NULL OR m.source_message_id<>?)
        AND (? IS NULL OR COALESCE(m.source_time,m.recorded_at)>=?)
        AND (? IS NULL OR COALESCE(m.source_time,m.recorded_at)<?) ORDER BY rank LIMIT 120`)
        .all(match,this.bank,...scope.params,excludeSession,excludeSession,excludeSourceId,excludeSourceId,since,since,before,before);
      rows.forEach((r,i)=>{scores.set(r.id,1/(60+i));reasons.set(r.id,['keyword']);});
    }
    const anchors=new Set();
    for(const a of this.db.prepare('SELECT a.id,x.alias FROM anchors a JOIN aliases x ON x.anchor=a.id WHERE a.bank=?').all(this.bank)){
      if(String(query).toLowerCase().includes(a.alias)) anchors.add(a.id);
    }
    for(const id of [...scores.keys()].slice(0,3)){
      for(const a of this.db.prepare('SELECT anchor FROM anchor_sources WHERE chunk=?').all(id)) anchors.add(a.anchor);
    }
    for(const aid of [...anchors].slice(0,10)){
      for(const r of this.db.prepare(`SELECT c.id FROM anchor_sources a JOIN chunks c ON c.id=a.chunk
        JOIN messages m ON m.id=c.message WHERE a.anchor=? AND m.bank=?${scope.sql} AND (? IS NULL OR m.session<>?)
        AND (? IS NULL OR m.source_message_id<>?)
        AND (? IS NULL OR COALESCE(m.source_time,m.recorded_at)>=?)
        AND (? IS NULL OR COALESCE(m.source_time,m.recorded_at)<?) ORDER BY c.id DESC LIMIT 20`)
        .all(aid,this.bank,...scope.params,excludeSession,excludeSession,excludeSourceId,excludeSourceId,since,since,before,before)){
        scores.set(r.id,(scores.get(r.id)??0)+.01);
        reasons.set(r.id,[...(reasons.get(r.id)??[]),'anchor']);
      }
    }
    const hits=[...scores].map(([id,score])=>{
      const row=this.chunk(id,{sessionIds}), state=this.state(row);
      return {...row,state,score:score*(archive?1:.8+.2*state.strength),reasons:reasons.get(id)};
    }).sort((a,b)=>b.score-a.score||b.id-a.id);
    // candidates 必须在排除/去重之前取，否则诊断会把"被排除的"算成"从未命中"，
    // 排查"为什么没召回"时会误导。
    const candidates=hits.length;
    // 注入去重：跳过调用方指定已展示过的片段。若排除后一条不剩，则放弃排除——
    // 让模型以为"没有记忆"比重复注入代价更大。排除只影响本次结果，不写库。
    const excludedIds=excludeIds instanceof Set?excludeIds:Array.isArray(excludeIds)?new Set(excludeIds):null;
    let excluded=0,excludeFallback=false;
    if(excludedIds&&excludedIds.size){
      const kept=hits.filter(hit=>!excludedIds.has(hit.id));
      excluded=hits.length-kept.length;
      if(kept.length){
        hits.length=0;hits.push(...kept);
      }else{
        excluded=0;excludeFallback=true; // 地板保护：全部被排除时回退为不排除
      }
    }
    const seen=new Map(),out=[];
    for(const hit of hits){
      const ranges=seen.get(hit.message)??[];
      if(ranges.some(r=>hit.start<r.end && hit.end>r.start))continue;
      ranges.push(hit);seen.set(hit.message,ranges);out.push(hit);
      if(out.length===limit)break;
    }
    // recall 需要这些计数做诊断；search 对外仍返回纯数组，调用方不受影响。
    // 注意：这是实例字段，靠同步单线程保证"search 后立刻读"的一致性。
    // 任何异步或递归调用 search 的改造都必须同时重做这里的统计传递方式。
    this._lastSearchStats={candidates,excluded,excludeFallback,final:out.length};
    return out;
  }
  // 最近若干轮已注入给模型的片段 id。ledger 里 sources 是 JSON 数组；
  // 单行损坏不应影响整体，解析失败直接跳过。
  recentShown(limit=1) {
    integer(limit,1,100);
    const shown=new Set();
    for(const row of this.db.prepare("SELECT sources FROM ledger WHERE bank=? AND kind='shown' ORDER BY id DESC LIMIT ?")
      .all(this.bank,limit)){
      let parsed;
      try{parsed=JSON.parse(row.sources);}catch{continue;}
      if(!Array.isArray(parsed))continue;
      for(const id of parsed)if(Number.isSafeInteger(id))shown.add(id);
    }
    return shown;
  }
  recall(query,{maxChars=2400,...options}={}) {
    integer(maxChars,200,20000);
    const hits=this.search(query,options);
    const stats=this._lastSearchStats??{candidates:hits.length,deduped:0,excluded:0,excludeFallback:false,final:hits.length};
    const excerptOf=hit=>({id:hit.id,role:hit.role,time:hit.source_time??hit.recorded_at,
      source:{session:hit.session,event:hit.event_key},text:hit.text,interrupted:Boolean(hit.interrupted)});
    // 按分数顺序逐条塞，直到超预算为止。这是唯一路径——不再有分级/截断分支：
    // 微信/QQ 形态的短对话（实测单条 13-20 字）距 2400 字预算余量约 1757 字，
    // 触发阈值需要单条正文 320 字以上，实际不可达，留分支只会变成死代码。
    const snippets=[];
    for(const hit of hits){
      const excerpt=excerptOf(hit);
      if(JSON.stringify([...snippets,excerpt]).length>maxChars)break;
      snippets.push(excerpt);
    }
    const text=snippets.length?JSON.stringify(snippets):'';
    return {text,ids:snippets.map(item=>item.id),
      // budgetExhausted 区分"有候选但预算放不下"与"确实没检索到"，
      // 否则调用方会把预算不足误判成没有记忆。
      diagnostics:{...stats,final:snippets.length,mode:'full',
        budgetExhausted:snippets.length===0&&hits.length>0}};
  }
  /**
   * 按**消息 id** 读全文。browse() 返回的是 message.id，而 read() 收的是 chunk.id，
   * 两者不能混用——面板详情必须走这里，否则会 "Memory not found"。
   * 分页语义与 read() 一致：offset 是消息内字符偏移，nextOffset 可直接续读。
   */
  readMessage(id,{offset=null,length=6000,sessionIds}={}) {
    integer(id,1,Number.MAX_SAFE_INTEGER);
    integer(length,1,6000);
    const scope=sessionScopeFilter(sessionIds);
    const row=this.db.prepare(`SELECT * FROM messages m WHERE m.id=? AND m.bank=?${scope.sql}`)
      .get(id,this.bank,...scope.params);
    if(!row)throw new Error(sessionIds===undefined?'Memory not found in this bank':'Memory not found in this scope');
    const text=String(row.text);
    const start=offset===null?0:integer(offset,0,text.length);
    return {id,role:row.role,time:Number(row.source_time??row.recorded_at),
      source:{session:row.session,event:row.event_key},
      text:text.slice(start,start+length),offset:start,
      nextOffset:start+length<text.length?start+length:null,totalChars:text.length,
      interrupted:Boolean(row.interrupted)};
  }
  read(id,{offset=null,length=3000,sessionIds}={}) {
    integer(length,1,6000);
    const chunk=this.chunk(id,{sessionIds});
    const row=this.db.prepare('SELECT * FROM messages WHERE id=? AND bank=?').get(chunk.message,this.bank);
    const start=offset===null?Math.max(0,chunk.start-200):integer(offset,0,row.text.length);
    return {id,role:row.role,time:row.source_time??row.recorded_at,source:{session:row.session,event:row.event_key},
      text:row.text.slice(start,start+length),
      offset:start,nextOffset:start+length<row.text.length?start+length:null,totalChars:row.text.length,
      interrupted:Boolean(row.interrupted)};
  }
  log(kind,text,ids=[]) {
    this.db.prepare('INSERT INTO ledger(bank,at,kind,chars,sources) VALUES (?,?,?,?,?)').run(this.bank,Date.now(),kind,text.length,JSON.stringify(ids));
  }
  sleep(limit=100) {
    integer(limit,1,1000);
    return this.transaction(()=>{
      const last=this.db.prepare('SELECT last_chunk FROM housekeeping WHERE bank=?').get(this.bank)?.last_chunk??0;
      const rows=this.db.prepare(`SELECT c.id,c.text,m.role FROM chunks c JOIN messages m ON m.id=c.message
        WHERE m.bank=? AND c.id>? ORDER BY c.id LIMIT ?`).all(this.bank,last,limit);
      for(const row of rows){
        this.db.prepare('INSERT OR REPLACE INTO groups VALUES (?,?,?)').run(row.id,this.bank,digest(row.role+'\0'+row.text));
        this.db.prepare('DELETE FROM search_index WHERE rowid=?').run(row.id);
        this.db.prepare('INSERT INTO search_index(rowid,terms) VALUES (?,?)').run(row.id,terms(row.text).join(' '));
      }
      this.db.prepare('INSERT OR REPLACE INTO housekeeping VALUES (?,?)').run(this.bank,rows.at(-1)?.id??last);
      return {processed:rows.length,lastChunk:rows.at(-1)?.id??last};
    });
  }
  replay(limit=10) {
    integer(limit,1,100);
    return this.transaction(()=>{
      const rows=this.db.prepare(`SELECT c.id FROM chunks c JOIN messages m ON m.id=c.message
        LEFT JOIN replays r ON r.chunk=c.id WHERE m.bank=? ORDER BY COALESCE(r.at,0),c.id LIMIT ?`).all(this.bank,limit);
      const result=rows.map(r=>this.read(r.id,{length:800}));
      for(const row of rows)this.db.prepare('INSERT OR REPLACE INTO replays VALUES (?,?)').run(row.id,Date.now());
      return result;
    });
  }
  stats() {
    return {bank:this.bank,messages:this.db.prepare('SELECT COUNT(*) n FROM messages WHERE bank=?').get(this.bank).n,
      chunks:this.db.prepare('SELECT COUNT(*) n FROM chunks c JOIN messages m ON m.id=c.message WHERE m.bank=?').get(this.bank).n,
      lastCapture:this.db.prepare('SELECT MAX(recorded_at) t FROM messages WHERE bank=?').get(this.bank).t,
      injectedChars:this.db.prepare("SELECT COALESCE(SUM(chars),0) n FROM ledger WHERE bank=? AND kind='injected'").get(this.bank).n};
  }
  /**
   * 记忆浏览器用的分页列表。只读，不改任何状态。
   *
   * 刻意只返回**预览**（默认 120 字）而不是全文：面板用于"看见记忆长什么样"，
   * 需要完整正文时走 read()。这样单次响应体保持在几十 KB 量级，
   * 也避免把整库对话一次性送到渲染进程。
   *
   * 检索范围与 recall 共用 sessionScopeFilter，保证"面板里看到的"与
   * "模型能召回到的"是同一批数据。
   */
  /**
   * 列出本库里出现过的会话（含已从工作区移除的"孤儿"）。
   *
   * 用途：面板要能告诉用户"这个库里有 N 条记忆来自已被删除的会话"，
   * 并提供清理入口。判定标准由调用方给（传入当前仍有效的会话 id 列表），
   * store 只负责统计与返回，不做业务判断。
   *
   * @param {string[]} liveSessionIds 当前仍有效的会话 id（不含 @createdAt 后缀）
   */
  sessionInventory({ liveSessionIds = [] } = {}) {
    const live = new Set((Array.isArray(liveSessionIds) ? liveSessionIds : []).filter(id => typeof id === 'string' && id));
    const rows = this.db.prepare(`SELECT m.session, COUNT(*) n, MIN(m.recorded_at) first, MAX(m.recorded_at) last
      FROM messages m WHERE m.bank=? GROUP BY m.session ORDER BY last DESC`).all(this.bank);
    const items = rows.map(row => {
      // 库里存的是 sessionId@createdAt，取前缀与工作区登记的 id 比对
      const sessionId = String(row.session).split('@')[0];
      return {
        session: String(row.session),
        sessionId,
        messages: Number(row.n),
        firstAt: Number(row.first),
        lastAt: Number(row.last),
        orphan: !live.has(sessionId),
      };
    });
    return {
      items,
      orphanSessions: items.filter(item => item.orphan).length,
      orphanMessages: items.filter(item => item.orphan).reduce((sum, item) => sum + item.messages, 0),
    };
  }
  /**
   * 删除指定会话（按 sessionId 前缀匹配）的全部记忆。
   *
   * 这是**破坏性操作**，调用方必须先确认。设计取舍：
   * - 按 sessionId 前缀删除，覆盖同一会话的多个 @createdAt 变体
   * - 同一事务内清理 chunks / search_index / activations / anchor_sources，
   *   避免留下悬空外键导致后续 sleep() 或 anchor 查询报错
   * - ledger 与 groups 保留：前者是审计日志，后者由 sleep() 重建
   * - 只删本 bank，不跨 bank
   *
   * @returns {{messages:number, chunks:number}} 实际删除条数
   */
  deleteSessions(sessionIds) {
    const ids = (Array.isArray(sessionIds) ? sessionIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return { messages: 0, chunks: 0 };
    const scope = sessionScopeFilter(ids);
    return this.transaction(() => {
      const targets = this.db.prepare(`SELECT m.id FROM messages m WHERE m.bank=?${scope.sql}`)
        .all(this.bank, ...scope.params).map(row => Number(row.id));
      if (!targets.length) return { messages: 0, chunks: 0 };
      const list = targets.map(() => '?').join(',');
      const chunkRows = this.db.prepare(`SELECT id FROM chunks WHERE message IN (${list})`).all(...targets);
      const chunkIds = chunkRows.map(row => Number(row.id));
      if (chunkIds.length) {
        const chunks = chunkIds.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM search_index WHERE rowid IN (${chunks})`).run(...chunkIds);
        this.db.prepare(`DELETE FROM activations WHERE chunk IN (${chunks})`).run(...chunkIds);
        this.db.prepare(`DELETE FROM anchor_sources WHERE chunk IN (${chunks})`).run(...chunkIds);
        this.db.prepare(`DELETE FROM groups WHERE chunk IN (${chunks})`).run(...chunkIds);
        this.db.prepare(`DELETE FROM replays WHERE chunk IN (${chunks})`).run(...chunkIds);
        this.db.prepare(`DELETE FROM chunks WHERE id IN (${chunks})`).run(...chunkIds);
      }
      this.db.prepare(`DELETE FROM messages WHERE id IN (${list})`).run(...targets);
      return { messages: targets.length, chunks: chunkIds.length };
    });
  }
  browse({offset=0,limit=30,preview=120,query=null,role=null,sessionIds,since=null,before=null}={}) {
    integer(limit,1,100);
    integer(preview,0,2000);
    if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid browse offset');
    const scope=sessionScopeFilter(sessionIds);
    const where=[`m.bank=?${scope.sql} AND length(trim(m.text))>0`];
    const params=[this.bank,...scope.params];
    if(role){where.push('m.role=?');params.push(role);}
    if(since!==null){where.push('COALESCE(m.source_time,m.recorded_at)>=?');params.push(since);}
    if(before!==null){where.push('COALESCE(m.source_time,m.recorded_at)<?');params.push(before);}
    if(query){
      const selected=terms(String(query)).filter(t=>t.length>1).slice(0,32);
      if(selected.length){
        const match=selected.map(t=>'"'+t.replaceAll('"','""')+'"').join(' OR ');
        where.push('m.id IN (SELECT c.message FROM search_index JOIN chunks c ON c.id=search_index.rowid WHERE search_index MATCH ?)');
        params.push(match);
      }
    }
    const clause=where.join(' AND ');
    const total=Number(this.db.prepare(`SELECT COUNT(*) n FROM messages m WHERE ${clause}`).get(...params).n);
    /* 额外返回星图需要的只读字段（category/importance/热度/星座），
       全部来自既有表，不写库、不改 schema、不影响任何检索逻辑。
       取该消息下最高 importance 的 chunk 作为这条消息的代表值。 */
    const rows=this.db.prepare(`SELECT m.id,m.role,m.text,m.session,m.event_key,m.recorded_at,m.source_time,m.interrupted,
        (SELECT COUNT(*) FROM chunks c WHERE c.message=m.id) chunk_count,
        (SELECT c.category FROM chunks c WHERE c.message=m.id ORDER BY c.importance DESC,c.id LIMIT 1) top_category,
        (SELECT c.importance FROM chunks c WHERE c.message=m.id ORDER BY c.importance DESC,c.id LIMIT 1) top_importance,
        (SELECT c.activated FROM chunks c WHERE c.message=m.id ORDER BY c.importance DESC,c.id LIMIT 1) top_activated,
        (SELECT c.boosts FROM chunks c WHERE c.message=m.id ORDER BY c.importance DESC,c.id LIMIT 1) top_boosts,
        (SELECT a.name FROM anchor_sources s JOIN anchors a ON a.id=s.anchor
           JOIN chunks c ON c.id=s.chunk WHERE c.message=m.id AND a.bank=m.bank LIMIT 1) star_name,
        (SELECT a.id FROM anchor_sources s JOIN anchors a ON a.id=s.anchor
           JOIN chunks c ON c.id=s.chunk WHERE c.message=m.id AND a.bank=m.bank LIMIT 1) star_id
      FROM messages m WHERE ${clause}
      ORDER BY COALESCE(m.source_time,m.recorded_at) DESC,m.id DESC LIMIT ? OFFSET ?`)
      .all(...params,limit,offset);
    const now=Date.now();
    const items=rows.map(row=>{
      const text=String(row.text);
      const cut=preview>0&&text.length>preview;
      /* 热度（arousal）：importance 是人工/规则给定的重要度（0..1，有真实差异），
         strength 是半衰期衰减后的活跃度（刚写入时恒为 1，区分度低）。
         星图用 heat = importance 作为主维度，strength 附带返回供未来使用。
         数据缺失（消息没有 chunk）时退回 0.5，保证渲染不炸。 */
      let strength=1;
      if(row.top_importance!==null&&row.top_activated!==null){
        try{
          strength=this.state({category:row.top_category??'episodic',
            importance:Number(row.top_importance),activated:Number(row.top_activated),
            boosts:Number(row.top_boosts??0)},now).strength;
        }catch{strength=1;}
      }
      const importance=row.top_importance===null?0.5:Number(row.top_importance);
      return {id:Number(row.id),role:row.role,
        preview:cut?`${text.slice(0,preview)}…`:text,
        truncated:cut,
        chars:text.length,chunks:Number(row.chunk_count),
        category:row.top_category??null,
        importance,
        heat:Number(importance.toFixed(4)),
        strength:Number(strength.toFixed(4)),
        star:row.star_name?{id:Number(row.star_id),name:String(row.star_name)}:null,
        session:row.session,event:row.event_key,
        time:Number(row.source_time??row.recorded_at),
        interrupted:Boolean(row.interrupted)};
    });
    return {items,total,offset,nextOffset:offset+items.length<total?offset+items.length:null};
  }
  /**
   * 存储统计。scope 语义与 browse 完全一致：
   *   sessionIds === undefined → 全库（CLI 等旧调用方保持原行为）
   *   sessionIds === []        → 全部为 0（绑定范围解析不出来时的 fail-closed）
   *   sessionIds === ['a']     → 只统计这些会话
   *
   * 唯一**不随范围变化**的是 databaseFiles：主库/WAL/SHM 是物理文件，
   * 一个文件里混着所有会话，无法按会话切分。所以这里同时返回
   * scopeBytes（本范围的正文体积）与 fileBytes（整个文件），
   * 让界面能诚实地表达"这部分属于你，文件本身是共用的"。
   */
  storageStats({ sessionIds } = {}) {
    const measuredAt = Date.now();
    const scope = sessionScopeFilter(sessionIds);
    const scoped = sessionIds !== undefined && sessionIds !== null;
    const messages = Number(this.db.prepare(`SELECT COUNT(*) n FROM messages m WHERE m.bank=?${scope.sql}`)
      .get(this.bank, ...scope.params).n);
    const lastCapture = this.db.prepare(`SELECT MAX(m.recorded_at) t FROM messages m WHERE m.bank=?${scope.sql}`)
      .get(this.bank, ...scope.params).t ?? null;
    const originalTextBytes = Number(this.db.prepare(`SELECT COALESCE(SUM(length(CAST(m.text AS BLOB))),0) AS bytes
      FROM messages m WHERE m.bank=?${scope.sql}`).get(this.bank, ...scope.params).bytes);
    const tiers = {
      fleeting: { chunks: 0, textBytes: 0 },
      episodic: { chunks: 0, textBytes: 0 },
      durable: { chunks: 0, textBytes: 0 },
      other: { chunks: 0, textBytes: 0 },
    };
    const recency = {
      active: { chunks: 0, textBytes: 0 },
      warm: { chunks: 0, textBytes: 0 },
      cold: { chunks: 0, textBytes: 0 },
    };
    const rows = this.db.prepare(`SELECT c.category,c.importance,c.activated,c.boosts,
      length(CAST(c.text AS BLOB)) AS textBytes
      FROM chunks c JOIN messages m ON m.id=c.message WHERE m.bank=?${scope.sql}`)
      .iterate(this.bank, ...scope.params);
    let chunks = 0;
    for (const row of rows) {
      chunks += 1;
      const bytes = Number(row.textBytes) || 0;
      const category = Object.hasOwn(tiers, row.category) && row.category !== 'other' ? row.category : 'other';
      tiers[category].chunks += 1;
      tiers[category].textBytes += bytes;
      const layer = this.state(row, measuredAt).layer;
      recency[layer].chunks += 1;
      recency[layer].textBytes += bytes;
    }

    const databaseFiles = { mainBytes: 0, walBytes: 0, shmBytes: 0 };
    if (this.path !== ':memory:') {
      const files = {
        mainBytes: this.path,
        walBytes: `${this.path}-wal`,
        shmBytes: `${this.path}-shm`,
      };
      for (const [key, path] of Object.entries(files)) {
        try {
          databaseFiles[key] = statSync(path).size;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
    databaseFiles.totalBytes = databaseFiles.mainBytes + databaseFiles.walBytes + databaseFiles.shmBytes;
    // bankTotals 只在按范围统计时提供，用于界面展示"本范围 / 全库"的对照。
    const bankTotals = scoped
      ? {
        messages: Number(this.db.prepare('SELECT COUNT(*) n FROM messages WHERE bank=?').get(this.bank).n),
        chunks: Number(this.db.prepare('SELECT COUNT(*) n FROM chunks c JOIN messages m ON m.id=c.message WHERE m.bank=?').get(this.bank).n),
        originalTextBytes: Number(this.db.prepare('SELECT COALESCE(SUM(length(CAST(text AS BLOB))),0) AS bytes FROM messages WHERE bank=?').get(this.bank).bytes),
      }
      : null;
    return { messages, chunks, lastCapture, originalTextBytes, tiers, recency, databaseFiles, measuredAt,
      scoped, bankTotals };
  }
  async backup(path) {
    mkdirSync(dirname(path), { recursive: true });
    if(existsSync(path))throw new Error('Backup destination already exists');
    await backup(this.db,path);
  }
  /**
   * 把本库里属于指定会话的消息，原样复制到目标库。
   *
   * 用于"旧单库 → 按范围拆分"的一次性迁移。设计取舍：
   * - **只复制消息与片段，不复制 ledger/groups/replays**：那些是运行时状态，
   *   目标库会自行重建（sleep() 会重新算 digest），带过去反而容易不一致。
   * - **按 (session,event_key) 去重**：目标库已有则跳过，所以重复执行是幂等的。
   * - **不删除源库任何东西**：迁移是"复制"，旧库保留作备份，由用户自己决定何时清理。
   *
   * @returns {copied, skipped} 实际写入与因已存在而跳过的条数
   */
  copySessionsTo(target, sessionIds) {
    if (!(target instanceof MemoryStore)) throw new Error('copySessionsTo requires a MemoryStore target');
    if (!Array.isArray(sessionIds) || !sessionIds.length) return { copied: 0, skipped: 0 };
    const scope = sessionScopeFilter(sessionIds);
    const rows = this.db.prepare(`SELECT m.* FROM messages m WHERE m.bank=?${scope.sql} ORDER BY m.id`)
      .all(this.bank, ...scope.params);
    let copied = 0, skipped = 0;
    target.transaction(() => {
      for (const row of rows) {
        const exists = target.db.prepare('SELECT 1 FROM messages WHERE bank=? AND session=? AND event_key=? LIMIT 1')
          .get(target.bank, row.session, row.event_key);
        if (exists) { skipped += 1; continue; }
        const saved = target.db.prepare(`INSERT OR IGNORE INTO messages(bank,session,event_key,role,text,content_json,
            source_message_id,recorded_at,source_time,interrupted) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(target.bank, row.session, row.event_key, row.role, row.text, row.content_json,
            row.source_message_id, row.recorded_at, row.source_time, row.interrupted);
        if (!saved.changes) { skipped += 1; continue; }
        const mid = Number(saved.lastInsertRowid);
        const text = String(row.text);
        // 与 capture() 完全相同的切片与索引逻辑，保证迁移后检索行为一致
        for (let start = 0; start < text.length; start += 640) {
          const end = Math.min(text.length, start + 800);
          const part = text.slice(start, end);
          const chunk = target.db.prepare('INSERT INTO chunks(message,start,end,text,activated) VALUES (?,?,?,?,?)')
            .run(mid, start, end, part, row.recorded_at ?? Date.now());
          target.db.prepare('INSERT INTO search_index(rowid,terms) VALUES (?,?)')
            .run(Number(chunk.lastInsertRowid), terms(part).join(' '));
          if (end === text.length) break;
        }
        copied += 1;
      }
    });
    return { copied, skipped };
  }
}
