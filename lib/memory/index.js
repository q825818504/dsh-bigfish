import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { MemoryStore } from './store.js';
import { attach } from './adapter.js';
import { readMoodState, moodToEmotion } from './mood-bridge.js';
import { scopeKey, scopeFilePath } from '../scope-key.js';
import { readScope, writeScope, applyScopeToValue, scopeStorePath, readDataRoot, writeDataRoot, dataRootStorePath, resolveDataRoot, seedDataRootFromProfile, defaultDataRoot } from '../scope-store.js';
import { inspectMove as inspectDataRootMove, copyDataRoot } from '../data-root-migrate.js';

export const name='dafeiyu-memory';
const CHANNEL='/api';
const ENDPOINT='dafeiyu-memory/status';
const SETTINGS_ENDPOINT='dafeiyu-memory/settings';
const BROWSE_ENDPOINT='dafeiyu-memory/browse';
const MOOD_ENDPOINT='dafeiyu-memory/mood';
const SETTINGS_ENTRY_ID='include:dafeiyu-memory';
const PATCH_ID='dafeiyu-memory';
const SESSION_PAGE_SIZE=100;
export const inject=['sessions','sessionQuery','agents','systemPrompt','tools','connection','workspaceRegistry','settings'];
// Host `settings.update/mutate` only accepts fields beneath a declared volatile node
// (packages/config settings write() rejects every other path). The binding/migration
// fields below are therefore volatile so the panel can persist them without remounting
// the plugin; each one is read through `.get()` and defaults stay ordinary data.
export const Config=z.object({
  database:z.string().default('').volatile(),bank:z.string().default('dafeiyu'),
  bindingMode:z.string().default('session').volatile(),
  bindingSessionIds:z.array(z.string()).volatile(),bindingWorkspaceId:z.string().default('').volatile(),
  pendingMigrationFrom:z.string().volatile(),pendingMigrationTarget:z.string().volatile(),
  pendingMigrationId:z.string().volatile(),pendingMigrationSourceIdentity:z.string().volatile(),
  preset:z.string().default(''),autoRecall:z.boolean().default(true),
  recallChars:z.number().default(2400),toolChars:z.number().default(6000),
  maintenanceMinutes:z.number().default(30),includeSubagents:z.boolean().default(false),
  // 强制范围：开启后只记录当前绑定范围的会话，并按范围切分库文件。
  strictScope:z.boolean().default(false).volatile(),
  // 强制模式的库文件存放目录（空 = 沿用 database 所在目录）。
  scopeDirectory:z.string().default('').volatile(),
});
// Volatile fields resolve to a stable reference; ordinary fields stay plain values.
function readConfig(raw,key){
  const field=raw?.[key];
  return field&&typeof field.get==='function'?field.get():field;
}
function plainConfig(raw){
  if(!raw||typeof raw!=='object')return{};
  const out={};
  for(const [key,value] of Object.entries(raw))out[key]=value&&typeof value.get==='function'?value.get():value;
  return out;
}
function expandHome(path){
  if(path==='~')return homedir();
  if(path.startsWith('~/')||path.startsWith('~\\'))return join(homedir(),path.slice(2));
  return path;
}
export function options(config={}){
  const value={bank:'dafeiyu',bindingMode:'session',bindingWorkspaceId:'',preset:'',autoRecall:true,
    recallChars:2400,toolChars:6000,maintenanceMinutes:30,includeSubagents:false,
    strictScope:false,scopeDirectory:''};
  // `config` may be the resolved runtime Config (volatile references) or plain options (tests, CLI).
  for(const [key,setting] of Object.entries(plainConfig(config)))if(setting!==undefined)value[key]=setting;
  if(!['session','workspace'].includes(value.bindingMode))throw new Error('dafeiyu-memory: invalid bindingMode');
  if(value.bindingSessionIds!==undefined){
    if(!Array.isArray(value.bindingSessionIds)||value.bindingSessionIds.some(id=>typeof id!=='string'||!id))throw new Error('dafeiyu-memory: invalid bindingSessionIds');
    value.bindingSessionIds=[...new Set(value.bindingSessionIds)];
  }
  if(typeof value.bindingWorkspaceId!=='string')throw new Error('dafeiyu-memory: invalid bindingWorkspaceId');
  for(const key of ['pendingMigrationFrom','pendingMigrationTarget']){
    if(typeof value[key]==='string'&&isAbsolute(value[key]))value[key]=resolve(value[key]);
  }
  for(const [key,min,max] of [['recallChars',800,12000],['toolChars',800,20000],['maintenanceMinutes',0,1440]]){
    if(!Number.isSafeInteger(value[key])||value[key]<min||value[key]>max)throw new Error(`dafeiyu-memory: invalid ${key}`);
  }
  const dshHome=expandHome(process.env.DSH_HOME?.trim()||join(homedir(),'.dsh'));
  const configuredDatabase=typeof value.database==='string'?value.database.trim():'';
  value.database=resolve(expandHome(configuredDatabase||join(dshHome,'dafeiyu-memory','memory.sqlite3')));
  if(typeof value.scopeDirectory!=='string')throw new Error('dafeiyu-memory: invalid scopeDirectory');
  return value;
}
/**
 * 强制模式下每个范围用一个独立库文件，实现物理隔离。
 *
 * 命名必须稳定且可预测——切换范围时靠它找回上次的库：
 *   workspace-<工作区 id 前 8 位>.sqlite3
 *   session-<会话 id 去前缀后前 8 位>.sqlite3（多选共用一个）
 *
 * 目录取 scopeDirectory，未设置则用当前 database 所在目录。
 * 这样"用户选的保存位置"就是所有范围库的父目录。
 */
export function scopeDatabasePath(value){
  const baseDir=value.scopeDirectory&&isAbsolute(value.scopeDirectory)
    ?resolve(value.scopeDirectory)
    :dirname(value.database);
  // ⭐ 2026-10-31：每个范围一个独立目录，库文件名也带范围特征：
  //    <baseDir>/<ws-xxx | ss-xxx>/memory-<短标识>.sqlite3
  //    这样换了范围绝不可能读到别的范围的库。推不出范围就返回 null（调用方拒绝写入），
  //    不会回退到「上一份」的路径。
  const key=scopeKey({
    mode:value.bindingMode,
    workspaceId:value.bindingWorkspaceId,
    sessionIds:value.bindingSessionIds,
  });
  if(!key)return null;
  return scopeFilePath(baseDir,key,'memory');
}
function onceAsync(dispose){
  let pending;
  return()=>pending??=(async()=>{await dispose();})();
}
function registerRpcRoute(ctx,endpoint,handler,errorCode){
  const dispose=ctx.connection.fetch.register({
    path:`${CHANNEL}/${endpoint}`,
    methods:['POST'],
    requestBody:'buffered',
    async fetch(request){
      if(request.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase()!=='application/json'){
        return new Response('content type must be application/json',{status:415});
      }
      let rawMessage;
      try{rawMessage=await request.json();}
      catch{return new Response('body is not JSON',{status:400});}
      const parsed=clientRequestSchema.safeParse(rawMessage);
      if(!parsed.success){
        const rpcId=rawMessage?.rpcId;
        if(typeof rpcId!=='string'||!rpcId)return new Response('invalid RPC request envelope',{status:400});
        return Response.json({type:'server-response',rpcId,result:{ok:false,error:{
          code:'gateway/bad-request',message:'Invalid client-request message',details:{issues:parsed.error.issues},
        }}});
      }
      const message=parsed.data;
      const respond=result=>Response.json({type:'server-response',rpcId:message.rpcId,result});
      if(message.method!==endpoint){
        return respond({ok:false,error:{code:'gateway/bad-request',message:`method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,details:{issues:[]}}});
      }
      if(request.signal.aborted)return respond({ok:false,error:{code:'cancelled',message:'Request cancelled',details:{}}});
      try{return respond({ok:true,value:await handler(message.payload)});}
      catch(error){
        console.error(`[dafeiyu-memory] ${endpoint} failed`,error);
        return respond({ok:false,error:{code:errorCode,message:String(error?.message??'Memory request failed'),details:{}}});
      }
    },
  });
  return onceAsync(dispose);
}
function settingsEntry(ctx){
  const entry=ctx.settings.describe().find(item=>String(item.ns)===SETTINGS_ENTRY_ID);
  // Settings.describe() can omit a nested Include row even while the Host plugin is active.
  // The runtime contract allows an unversioned merge; keep the revision guard whenever one is published.
  return entry??{ns:SETTINGS_ENTRY_ID,revision:undefined};
}
// The owning Loader entry is the only reliably addressable target for a profile write:
// `settings.write()` looks entries up by `entry.options.id` (here `dafeiyu-memory`), while
// `settings.describe()` publishes the namespaced `include:dafeiyu-memory`, so the settings
// path cannot find this row. `configEditor.edit(entry, change)` takes the entry object itself.
function profileEntry(ctx){
  const direct=ctx.fiber?.entry;
  if(direct)return direct;
  const editor=ctx.get?.('configEditor');
  if(!editor||typeof editor.entries!=='function')return null;
  const rows=editor.entries();
  // Prefer the exact patch id, then fall back to the single entry whose id ends with it.
  return rows.find(row=>row.options?.id===PATCH_ID)
    ??rows.find(row=>String(row.options?.id??'').endsWith(`:${PATCH_ID}`))
    ??null;
}
async function writeConfig(ctx,patch,removeKeys=[]){
  const entry=profileEntry(ctx);
  const editor=ctx.get?.('configEditor');
  if(entry&&editor&&typeof editor.edit==='function'){
    await editor.edit(entry,current=>{
      const next={...current,...patch};
      for(const key of removeKeys)delete next[key];
      return next;
    });
    return true;
  }
  const settings=settingsEntry(ctx);
  if(removeKeys.length&&typeof ctx.settings.mutate==='function'){
    const operations=removeKeys.map(key=>({op:'unset',path:[key]}));
    if(settings.revision===undefined)await ctx.settings.mutate(settings.ns,operations);
    else await ctx.settings.mutate(settings.ns,operations,settings.revision);
  }
  if(Object.keys(patch).length){
    if(settings.revision===undefined)await ctx.settings.update(settings.ns,patch);
    else await ctx.settings.update(settings.ns,patch,settings.revision);
  }
  return false;
}
async function updateConfig(ctx,patch){return writeConfig(ctx,patch);}
async function unsetConfig(ctx,keys){return writeConfig(ctx,{},keys);}
function integrityOrThrow(store,label){
  const check=store.integrityCheck();
  if(!check.ok)throw new Error(`${label} SQLite integrity check failed: ${check.details.join('; ')}`);
  return check;
}
function fileInfo(path){
  try{
    const info=lstatSync(path,{bigint:true});
    if(!info.isFile()||info.isSymbolicLink())throw new Error(`Refusing to modify non-regular file: ${path}`);
    return info;
  }catch(error){
    if(error.code==='ENOENT')return null;
    throw error;
  }
}
function normalizedPath(path){
  let absolute=resolve(path);
  const extendedPrefix=String.fromCharCode(92,92,63,92);
  if(process.platform==='win32'&&absolute.startsWith(extendedPrefix))absolute=absolute.slice(extendedPrefix.length);
  return process.platform==='win32'?absolute.toLowerCase():absolute;
}
function samePath(left,right){return normalizedPath(left)===normalizedPath(right);}
function canonicalDatabasePath(path){
  const absolute=resolve(path),real=realpathSync(absolute);
  if(!samePath(absolute,real))throw new Error('Automatic migration refuses a symlink/reparse-point source database');
  return real;
}
function fileIdentity(path){
  const info=fileInfo(path);
  if(!info)return null;
  const identity={dev:String(info.dev),ino:String(info.ino)};
  if(identity.ino==='0'){
    identity.size=String(info.size);
    identity.mtimeMs=String(info.mtimeMs);
  }
  return identity;
}
function assertFileIdentity(path,expected){
  const actual=fileIdentity(path);
  if(!actual||expected.dev!==actual.dev||expected.ino!==actual.ino||(expected.ino==='0'&&(expected.size!==actual.size||expected.mtimeMs!==actual.mtimeMs)))throw new Error(`File identity changed; refusing cleanup: ${path}`);
}
function databaseFileIdentity(path){
  const main=fileIdentity(path);
  if(!main)throw new Error(`Source database is missing: ${path}`);
  return JSON.stringify({main,wal:fileIdentity(`${path}-wal`),shm:fileIdentity(`${path}-shm`)});
}
function validateMigrationId(id){
  if(typeof id!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(id))throw new Error('Migration transaction id is invalid');
  return id;
}
function retiredPath(path,id){return `${path}.dfm-retired-${validateMigrationId(id)}`;}
function assertPendingSourceIdentity(sourcePath,migrationId,serialized){
  let expected;
  try{expected=JSON.parse(serialized);}catch{throw new Error('Stored source database identity is invalid');}
  if(!expected?.main||!expected.main.dev||!expected.main.ino)throw new Error('Stored source database identity is incomplete');
  const source=resolve(sourcePath),retiredMain=retiredPath(source,migrationId);
  const originalMainInfo=fileInfo(source),retiredMainInfo=fileInfo(retiredMain);
  if(originalMainInfo&&retiredMainInfo)throw new Error('Both original and quarantined source databases exist; refusing cleanup');
  const mainPath=originalMainInfo?source:retiredMainInfo?retiredMain:null;
  if(mainPath){
    canonicalDatabasePath(mainPath);
    assertFileIdentity(mainPath,expected.main);
  }
  for(const key of ['wal','shm']){
    const original=`${source}-${key}`,retired=retiredPath(original,migrationId);
    const originalInfo=fileInfo(original),retiredInfo=fileInfo(retired);
    if(originalInfo&&retiredInfo)throw new Error(`Both original and quarantined ${key.toUpperCase()} files exist; refusing cleanup`);
    const actualPath=originalInfo?original:retiredInfo?retired:null;
    if(!expected[key]&&actualPath)throw new Error(`Unrecorded source ${key.toUpperCase()} sidecar exists; refusing cleanup`);
    if(expected[key]&&actualPath)assertFileIdentity(actualPath,expected[key]);
    if(!mainPath&&actualPath)throw new Error('Source database is missing but sidecars remain; refusing cleanup');
  }
  return Boolean(mainPath);
}
function cleanupOwnedStage(path){
  for(const candidate of [path,`${path}-wal`,`${path}-shm`]){
    const info=fileInfo(candidate);
    if(info)unlinkSync(candidate);
  }
}
function retireDatabaseFiles(sourcePath,migrationId,sourceIdentity){
  const main=resolve(sourcePath),quarantinedMain=retiredPath(main,migrationId);
  const mainInfo=fileInfo(main),retiredMainInfo=fileInfo(quarantinedMain);
  if(mainInfo&&retiredMainInfo)throw new Error('Both original and quarantined source databases exist; refusing cleanup');
  assertPendingSourceIdentity(main,migrationId,sourceIdentity);
  const pairs=[
    [`${main}-wal`,retiredPath(`${main}-wal`,migrationId)],
    [`${main}-shm`,retiredPath(`${main}-shm`,migrationId)],
    [main,quarantinedMain],
  ];
  const sidecarsPresent=pairs.slice(0,2).filter(([original,retired])=>fileInfo(original)||fileInfo(retired)).length;
  if(!mainInfo&&!retiredMainInfo&&(fileInfo(pairs[0][0])||fileInfo(pairs[1][0])||fileInfo(pairs[0][1])||fileInfo(pairs[1][1])))throw new Error('Source database is missing but sidecars remain; refusing to remove unrelated files');
  const expected=JSON.parse(sourceIdentity);
  const identityFor=path=>path===main?'main':path===`${main}-wal`?'wal':'shm';
  const moved=[];
  try{
    for(const [original,retired] of pairs){
      const originalInfo=fileInfo(original),retiredInfo=fileInfo(retired),key=identityFor(original);
      if(originalInfo&&retiredInfo)throw new Error(`Both source and quarantine files exist: ${original}`);
      const existing=originalInfo?original:retiredInfo?retired:null;
      if(existing){
        if(!expected[key])throw new Error(`Unrecorded source ${key.toUpperCase()} file appeared; refusing cleanup`);
        assertFileIdentity(existing,expected[key]);
      }
      if(originalInfo){renameSync(original,retired);moved.push([original,retired]);}
    }
  }catch(error){
    for(const [original,retired] of moved.reverse()){
      try{if(fileInfo(retired)&&!fileInfo(original)){assertFileIdentity(retired,expected[identityFor(original)]);renameSync(retired,original);}}
      catch(restoreError){console.error('[dafeiyu-memory] Failed to restore a quarantined source file',restoreError);}
    }
    throw error;
  }
  for(const [original,retired] of pairs.slice(0,2)){
    if(fileInfo(retired)){assertFileIdentity(retired,expected[identityFor(original)]);unlinkSync(retired);}
  }
  if(fileInfo(quarantinedMain)){assertFileIdentity(quarantinedMain,expected.main);unlinkSync(quarantinedMain);}
  return {sourceRemoved:Boolean(mainInfo||retiredMainInfo),sidecarsRemoved:sidecarsPresent};
}
async function copyDatabaseToTarget(store,controller,sourcePath,targetPath,bank,replaceTarget){
  if(samePath(sourcePath,targetPath))throw new Error('Source and target database paths are identical');
  const targetInfo=fileInfo(targetPath);
  const sidecars=[`${targetPath}-wal`,`${targetPath}-shm`].map(fileInfo);
  if(sidecars.some(Boolean))throw new Error('The selected target has WAL/SHM sidecars; close its database and retry without replacing an active file');
  if(targetInfo&&!replaceTarget)throw new Error('A database already exists at the selected target; confirm the exact target path before replacing it');
  if(targetInfo){
    const inspection=MemoryStore.inspectDatabase(targetPath,bank);
    if(!inspection.ok)throw new Error(`Selected target is not a compatible ${bank} memory database; it was not replaced: ${inspection.details.join('; ')}`);
  }
  const backfill=await controller.backfill();
  integrityOrThrow(store,'Source after session backfill');
  const sourceIdentity=databaseFileIdentity(sourcePath);
  const stagePath=join(dirname(targetPath),`.dafeiyu-memory-${randomUUID()}.stage`);
  let stagedStore,targetStore,previousTargetPath,snapshotStats,targetInstalled=false;
  try{
    await store.backup(stagePath);
    stagedStore=new MemoryStore(stagePath,bank);
    integrityOrThrow(stagedStore,'Staged copy');
    snapshotStats=stagedStore.stats();
    stagedStore.close();
    stagedStore=null;
    if(targetInfo){
      previousTargetPath=`${targetPath}.dfm-previous-${randomUUID()}`;
      renameSync(targetPath,previousTargetPath);
    }
    renameSync(stagePath,targetPath);
    targetInstalled=true;
    targetStore=new MemoryStore(targetPath,bank);
    integrityOrThrow(targetStore,'Reopened target before switching');
    const reopenedStats=targetStore.stats();
    if(snapshotStats.messages!==reopenedStats.messages||snapshotStats.chunks!==reopenedStats.chunks)throw new Error('Reopened target statistics do not match the staged SQLite snapshot');
    targetStore.close();
    targetStore=null;
    return {previousTargetPath,sourceIdentity,backfilledSessions:backfill.sessions,snapshotStats};
  }catch(error){
    if(targetStore){try{targetStore.close();}catch{}}
    if(targetInstalled){try{cleanupOwnedStage(targetPath);}catch(cleanupError){console.error('[dafeiyu-memory] Could not remove an invalid target copy',cleanupError);}}
    if(previousTargetPath){
      try{if(!fileInfo(targetPath)&&fileInfo(previousTargetPath))renameSync(previousTargetPath,targetPath);}
      catch(restoreError){console.error('[dafeiyu-memory] Failed to restore the previous target copy',restoreError);}
    }
    throw error;
  }finally{
    if(stagedStore){try{stagedStore.close();}catch{}}
    try{cleanupOwnedStage(stagePath);}catch(cleanupError){console.error('[dafeiyu-memory] Failed to remove migration staging files',cleanupError);}
  }
}
async function sessionTargetPage(ctx,offset,selectedIds=[]){
  if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid session-list offset');
  const records=await ctx.sessionQuery.listSessions();
  const page=records.slice(offset,offset+SESSION_PAGE_SIZE);
  const pageIds=new Set(page.map(record=>record.header.id));
  const selected=new Set(selectedIds);
  const byId=new Map(records.map(record=>[record.header.id,record]));
  const selectedRecords=selectedIds.map(id=>byId.get(id)).filter(record=>record&&!pageIds.has(record.header.id));
  const visible=[...page,...selectedRecords];
  let titleResults=[];
  try{
    if(visible.length)titleResults=await ctx.sessionQuery.readTitleSnapshots(visible.map(record=>record.header.id));
  }catch{}
  const titles=new Map();
  for(const result of titleResults){
    if(result.status==='fulfilled')titles.set(result.sessionId,result.value?.title?.title||'');
  }
  const items=visible.map(record=>{
    const header=record.header;
    const id=header.id;
    const fallback=header.cwd?.split(/[\\/]/).filter(Boolean).at(-1)||`Session ${id.slice(0,8)}`;
    return {id,title:titles.get(id)||fallback,createdAt:header.createdAt,live:record.live===true,persisted:record.persisted===true,selected:selected.has(id)};
  });
  return {
    items,
    total:records.length,
    offset,
    nextOffset:offset+page.length<records.length?offset+page.length:null,
    missingSelectedIds:selectedIds.filter(id=>!byId.has(id)),
  };
}
function workspaceTargets(ctx){
  return ctx.workspaceRegistry.list().map(workspace=>({
    id:workspace.id,title:workspace.title,sessionCount:workspace.sessionIds.length,
  }));
}
/**
 * 面板浏览用的作用域解析。**不要**复用 adapter 的 sessionScopeIds——那个需要
 * "当前会话"对象来判断归属，而面板没有当前会话概念。
 *
 * 面板的语义是"按用户设定好的绑定范围看记忆"：
 *   workspace 模式 → 该工作区登记的全部会话（工作区没会话就是空）
 *   session   模式 → 显式选中的会话列表（没选就是空）
 *
 * 关键：任何"解析不出来"的情况都返回 []，让 store 层生成 `AND 0`，
 * 查不到任何数据。绝不能返回 undefined——那等于查全库，会让不同工作区
 * 的记忆互相串台。
 *
 * `registry.get()` 在会话被删除后可能返回 null（内存态已摘除、磁盘态还在），
 * 因此失败时回退到 `list()` 里按 id 查找。否则会把"有 4 条记忆的工作区"
 * 误判成空范围，面板显示 0 而全库显示 4，用户无法理解。
 *
 * 任何异常都吞掉并返回 null：registry 抛错时如果向上冒泡，整个面板 RPC 会失败，
 * 用户看到白屏而不是"暂无记忆"。宁可显示空，也不能让面板不可用。
 */
function resolveWorkspace(ctx,workspaceId){
  if(!workspaceId)return null;
  const usable=item=>item&&Array.isArray(item.sessionIds)?item:null;
  try{
    const direct=usable(ctx.workspaceRegistry?.get?.(workspaceId));
    if(direct)return direct;
  }catch(error){
    console.warn('[dafeiyu-memory] workspaceRegistry.get 失败，尝试 list()',error);
  }
  try{
    const list=ctx.workspaceRegistry?.list?.();
    if(Array.isArray(list)){
      return usable(list.find(item=>item&&item.id===workspaceId));
    }
  }catch(error){
    console.warn('[dafeiyu-memory] workspaceRegistry.list 失败，按空范围处理',error);
  }
  return null;
}
export function panelScopeIds(ctx,value){
  if(value.bindingMode==='workspace'){
    const workspace=resolveWorkspace(ctx,value.bindingWorkspaceId);
    if(!workspace)return [];
    return workspace.sessionIds.filter(id=>typeof id==='string'&&id);
  }
  if(value.bindingMode==='session'){
    if(!Array.isArray(value.bindingSessionIds))return [];
    return value.bindingSessionIds.filter(id=>typeof id==='string'&&id);
  }
  return [];
}
/**
 * 面板实际查询用的会话集合 = 当前范围 ∪ 库内已有数据的会话。
 *
 * 为什么必须取并集：面板的职责是"管理这个库里的记忆"，而**孤儿记忆的定义
 * 就是"来源会话已不在当前范围"**。如果只用 panelScopeIds 过滤，这些孤儿
 * 会同时满足"在库里"和"不在范围内"，结果就是既看不见、又删不掉，
 * 用户会对着"本范围 0 条 / 全库 4 条"无法处理。
 *
 * 安全性：并集只放宽到"本库文件里确实存在的会话"，不会跨库、不会跨 bank，
 * 因为库文件本身已经是按范围切分的物理隔离。
 *
 * **只对 workspace 模式取并集**：工作区是"容器"，它的成员会变（会话被删、
 * 新会话加入），库里的历史成员理应继续可见。而 session 模式是用户**逐条
 * 点选**的精确清单——如果也取并集，用户取消勾选的会话仍会出现在面板里，
 * 绑定就形同虚设。session 模式严格只显示勾选的那几个。
 */
export function panelQuerySessions(ctx,value,store){
  const scoped=panelScopeIds(ctx,value);
  if(value.bindingMode!=='workspace')return scoped;
  let stored=[];
  try{
    stored=(store.sessionInventory({liveSessionIds:scoped}).items??[]).map(item=>item.sessionId);
  }catch(error){
    console.warn('[dafeiyu-memory] 读取库内会话清单失败，仅按绑定范围查询',error);
    return scoped;
  }
  return [...new Set([...scoped,...stored])];
}
/**
 * 把旧单库按工作区拆分到各自的库文件。只复制、不删除源数据。
 *
 * 返回每个工作区的迁移结果，供面板展示。工作区没有任何消息时也会生成一个空库，
 * 让用户能看到"这个范围确实是空的"而不是"文件不存在"。
 */
export function splitBankIntoScopes(ctx,sourceDatabase,bank,baseDir){
  const results=[];
  let source=null;
  try{
    source=new MemoryStore(sourceDatabase,bank);
  }catch(error){
    return {ok:false,error:`无法打开源库：${error?.message??error}`,results:[]};
  }
  try{
    const workspaces=ctx.workspaceRegistry?.list?.() ?? [];
    if(!workspaces.length)return {ok:true,results:[],note:'当前没有工作区'};
    // 记录所有被分配到某个工作区的会话，用来找出"谁都没要"的
    const assigned=new Set();
    for(const workspace of workspaces){
      const ids=(workspace.sessionIds??[]).filter(id=>typeof id==='string'&&id);
      for(const id of ids)assigned.add(id);
      // workspace.id 必须存在且可用；缺失时跳过而不是回退到 "undefined" 文件名，
      // 否则所有工作区会挤进同一个 workspace-undefine.sqlite3。
      const safeId=String(workspace.id??'').replace(/[^A-Za-z0-9_-]/g,'');
      if(!safeId){
        results.push({workspaceId:null,title:workspace.title,error:'工作区缺少 id，已跳过'});
        continue;
      }
      const targetPath=join(baseDir,`workspace-${safeId.slice(0,8)}.sqlite3`);
      let target=null;
      try{
        target=new MemoryStore(targetPath,bank);
        const {copied,skipped}=source.copySessionsTo(target,ids);
        results.push({workspaceId:workspace.id,title:workspace.title,path:targetPath,
          sessions:ids.length,copied,skipped});
      }catch(error){
        results.push({workspaceId:workspace.id,title:workspace.title,path:targetPath,
          error:String(error?.message??error)});
      }finally{
        try{target?.close();}catch{}
      }
    }
    // 兜底：不属于任何工作区的会话（历史上产生、后来工作区被删/改）如果留在旧库里，
    // 强制模式下会变成"面板永远看不到"的隐形数据。统一收进 unassigned 库，
    // 至少让用户能在面板里找到并处理它们。
    try{
      const inventory=source.sessionInventory({liveSessionIds:[...assigned]});
      const unassigned=[...new Set(inventory.items.filter(item=>item.orphan).map(item=>item.sessionId))];
      if(unassigned.length){
        const orphanPath=join(baseDir,'unassigned.sqlite3');
        let target=null;
        try{
          target=new MemoryStore(orphanPath,bank);
          const {copied,skipped}=source.copySessionsTo(target,unassigned);
          results.push({workspaceId:null,title:'未归属任何工作区',path:orphanPath,
            sessions:unassigned.length,copied,skipped,unassigned:true});
        }finally{
          try{target?.close();}catch{}
        }
      }
    }catch(error){
      results.push({workspaceId:null,title:'未归属任何工作区',error:String(error?.message??error)});
    }
    return {ok:true,results};
  }finally{
    try{source.close();}catch{}
  }
}
/**
 * 绑定范围变化后，把运行中的库切到新范围，并回灌该范围的历史。
 *
 * 为什么必须做：`database` 是 volatile 配置，写入不会重载插件。
 * 如果只写配置不换库，运行中的实例会继续读写旧库——用户看到
 * "保存了但没生效，点第二次才成功"，因为第二次恰好触发了别处的刷新。
 *
 * 失败语义：切库失败**不回滚配置**（配置已持久化，重启后会一致），
 * 但要把失败原因返回给面板，让用户知道当前运行的还是旧库。
 */
async function applyScopeSwitch(ctx,value,switchDatabase,backfill,result){
  if(!value.strictScope)return {...result,changed:true,scopeSwitch:null};
  const target=scopeDatabasePath(value);
  if(!target){
    return {...result,changed:true,scopeSwitch:{switched:false,reason:'当前绑定无法确定范围库路径'}};
  }
  const outcome=switchDatabase(target);
  let filled=null;
  if(outcome.switched){
    value.database=target;
    // 新库可能是空的，立刻从 session log 回灌当前范围
    try{
      filled=await backfill();
    }catch(error){
      filled={error:String(error?.message??error)};
    }
  }
  return {...result,changed:true,
    databasePath:target,
    scopeSwitch:{...outcome,backfill:filled},
    warning:outcome.error?`切换库失败，当前仍使用旧库：${outcome.error}`:undefined};
}
export function apply(ctx,config){
  const 基础=options(config);
  /* ⭐ 2026-10-31：范围以 <数据根目录>/scope.json 为准 —— 那是「设置」板块写的那份。
     读不到才回退到 cordis Config（兼容还没建 scope.json 的部署）。
     这是「拉」模式：设置保存只写文件，记忆在启动时读，不靠设置去推。

     ⭐ 2.3.0：数据根改为「三边同一个真源」。
     以前记忆用 profile 的 scopeDirectory、心情和灵魂各自用 <DSH_HOME>/bigfish/scopes，
     默认值不同；root.json 一空，记忆写一边、心情写另一边，同一次对话的记忆和心情就分居。
     现在的顺序：
       1. root.json 有自定义值   → 三边都用它
       2. root.json 不存在 且 profile 写了 scopeDirectory → 落成 root.json（一次性迁移）
       3. 都没有                 → <DSH_HOME>/bigfish/scopes（三边的共同默认）
     profile 里那个值只当**种子**用：用户在设置里点「恢复默认」之后不会再被它拉回去。 */
  const profileScope=基础.scopeDirectory&&isAbsolute(基础.scopeDirectory)?resolve(基础.scopeDirectory):'';
  if(profileScope)seedDataRootFromProfile(profileScope);
  const 范围根=resolveDataRoot(profileScope||(基础.database?dirname(基础.database):''));
  const value=applyScopeToValue(基础,readScope(范围根));
  ctx.effect(()=>{
    // 强制模式：库文件按范围切分。解析不出目标路径时退回原来的单库，
    // 并在下面把写入全部拦掉（strictScope + 空范围 = 不记录），
    // 绝不因为路径解析失败就默默写进"某个"库。
    //
    // store 必须可热切换：切换工作区时如果只写配置不换库，运行中的实例会继续
    // 读写旧库，用户看到"保存了但没生效，点第二次才成功"。
    // 用 holder 包一层，所有读写都走 holder.current，切换时原子替换。
    const holder={current:null};
    const openStore=database=>{
      const next=new MemoryStore(database,value.bank);
      holder.current=next;
      return next;
    };
    const scopedPath=value.strictScope?scopeDatabasePath(value):null;
    if(value.strictScope&&!scopedPath){
      console.warn('[dafeiyu-memory] 强制范围已开启但无法确定范围库路径（绑定为空？），本次不记录任何记忆');
    }
    const activeDatabase=scopedPath??value.database;
    openStore(activeDatabase);
    // adapter 用 activeDatabase 判断是否处于"强制且无库"状态
    if(scopedPath)value.database=scopedPath;
    /**
     * 切换运行中的库。用于绑定范围变化时立即生效，不必等插件重载。
     *
     * 失败时保持旧库不动——切换失败最坏的结果是"还用旧库"，
     * 绝不能出现"旧库关了、新库没开"的悬空状态。
     *
     * @returns {{switched:boolean, from:string, to:string, error?:string}}
     */
    function switchDatabase(target){
      const from=holder.current?.path??'';
      if(!target)return {switched:false,from,to:'',error:'目标库路径为空'};
      if(from&&samePath(from,target))return {switched:false,from,to:target};
      let next=null;
      try{
        next=new MemoryStore(target,value.bank);
      }catch(error){
        return {switched:false,from,to:target,error:String(error?.message??error)};
      }
      const previous=holder.current;
      holder.current=next;
      try{previous?.close();}catch{}
      return {switched:true,from,to:target};
    }
    // 门面：把所有调用转发给当前 holder.current。方法绑定到真实实例，
    // 保证 this 正确；属性（如 .db/.path）也走 getter。
    // 用 Proxy 而不是手写转发，是为了让新增的 store 方法自动可用。
    const store=new Proxy({},{
      get(_target,key){
        const current=holder.current;
        if(!current)throw new Error('Memory store is not open');
        const value=current[key];
        return typeof value==='function'?value.bind(current):value;
      },
      set(_target,key,next){
        const current=holder.current;
        if(!current)throw new Error('Memory store is not open');
        current[key]=next;
        return true;
      },
    });
    let controller;
    let migrationTask=null;
    let migrationStatus=value.pendingMigrationFrom?{state:'checking'}:null;
    const routeDisposers=[];
    async function verifyPendingMigration(){
      if(!value.pendingMigrationFrom)return;
      try{
        if(!value.pendingMigrationTarget||!samePath(value.pendingMigrationTarget,value.database))throw new Error('Migration target does not match the active database path');
        validateMigrationId(value.pendingMigrationId);
        if(!isAbsolute(value.pendingMigrationFrom)||!value.pendingMigrationSourceIdentity)throw new Error('Migration source identity is missing or invalid');
        assertPendingSourceIdentity(resolve(value.pendingMigrationFrom),value.pendingMigrationId,value.pendingMigrationSourceIdentity);
        integrityOrThrow(store,'Reopened target');
        const backfill=await controller.backfill();
        integrityOrThrow(store,'Reopened target after session backfill');
        migrationStatus={state:'ready',sessions:backfill.sessions,verifiedAt:Date.now()};
      }catch(error){
        migrationStatus={state:'blocked',error:String(error?.message??error)};
        console.error('[dafeiyu-memory] Migration verification blocked; old database retained',error);
      }
    }
    async function finalizeMigration(requestedId){
      if(!value.pendingMigrationFrom||!value.pendingMigrationTarget)throw new Error('No pending database migration is available');
      validateMigrationId(value.pendingMigrationId);
      if(requestedId!==value.pendingMigrationId)throw new Error('Migration confirmation is stale; refresh the settings panel');
      if(!value.pendingMigrationSourceIdentity||!isAbsolute(value.pendingMigrationFrom))throw new Error('Migration source identity is missing or invalid');
      if(!samePath(value.pendingMigrationTarget,value.database)||samePath(value.pendingMigrationFrom,value.database))throw new Error('Migration source/target paths are invalid');
      if(migrationTask)await migrationTask;
      if(!['ready','cleanup-pending'].includes(migrationStatus?.state))throw new Error(migrationStatus?.error||'The new database is not yet verified; the old database was retained');
      let backfill;
      try{
        integrityOrThrow(store,'Reopened target');
        backfill=await controller.backfill();
        integrityOrThrow(store,'Reopened target after session backfill');
        assertPendingSourceIdentity(resolve(value.pendingMigrationFrom),value.pendingMigrationId,value.pendingMigrationSourceIdentity);
      }catch(error){
        migrationStatus={state:'blocked',error:String(error?.message??error)};
        throw error;
      }
      try{
        const retirement=retireDatabaseFiles(value.pendingMigrationFrom,value.pendingMigrationId,value.pendingMigrationSourceIdentity);
        await unsetConfig(ctx,['pendingMigrationFrom','pendingMigrationTarget','pendingMigrationId','pendingMigrationSourceIdentity']);
        for(const key of ['pendingMigrationFrom','pendingMigrationTarget','pendingMigrationId','pendingMigrationSourceIdentity'])delete value[key];
        migrationStatus=null;
        return {...retirement,sessionsVerified:backfill.sessions};
      }catch(error){
        migrationStatus={...migrationStatus,state:'cleanup-pending',error:String(error?.message??error)};
        throw error;
      }
    }
    try{
      controller=attach(ctx,store,value,defineTool);
      // 强制模式下的自动回灌：新库是空的，必须把该范围的历史对话从 DSH
      // 持久化 session log 拉进来，否则用户切换范围后会看到"记忆全没了"。
      // 回灌本身受 adapter 的 inScope 门禁约束，只会拉当前范围内的会话。
      // 失败不阻断插件启动——记忆是增强项，不能拖垮对话。
      let scopeBackfill=null;
      if(value.strictScope&&scopedPath){
        scopeBackfill=controller.backfill()
          .then(result=>{
            console.info(`[dafeiyu-memory] 强制范围回灌完成：${result.sessions} 个会话 → ${scopedPath}`);
            return {state:'ready',...result,path:scopedPath};
          })
          .catch(error=>{
            console.error('[dafeiyu-memory] 强制范围回灌失败',error);
            return {state:'failed',error:String(error?.message??error),path:scopedPath};
          });
      }
      // 统计也按绑定范围走。面板是"管理我关心的记忆"，不是全库后台，
      // 顶部数字必须和下面的细胞数对得上，否则用户无法判断自己看到的是哪一部分。
      // 物理文件大小无法按会话切分，由 store 单独用 bankTotals 提供全库对照。
      routeDisposers.push(registerRpcRoute(ctx,ENDPOINT,
        ()=>store.storageStats({sessionIds:panelQuerySessions(ctx,value,store)}),'storage_stats_failed'));
      // 记忆细胞视图的数据源。只读分页，预览截断，不返回全文。
      // 作用域由 panelScopeIds 解析：解析不出来就是空数组 → store 生成 `AND 0`
      // → 查不到任何数据。绝不传 undefined（那会退化成查全库、跨工作区串台）。
      routeDisposers.push(registerRpcRoute(ctx,BROWSE_ENDPOINT,async payload=>{
        if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Invalid browse request');
        const sessionIds=panelQuerySessions(ctx,value,store);
        const action=payload.action??'page';
        if(action==='detail'){
          const id=Number(payload.id);
          if(!Number.isSafeInteger(id)||id<1)throw new Error('Invalid memory id');
          // browse 返回的是 message.id，必须用 readMessage 而不是 read（后者收 chunk.id）。
          // 同样要带 sessionIds，否则可以按 id 越界读到别的工作区。
          return store.readMessage(id,{length:6000,sessionIds});
        }
        // 会话清单：标出哪些记忆的来源会话已经从工作区移除（孤儿）。
        // 判定基准是"当前仍有效的会话"，由 workspaceRegistry 提供，
        // 与 panelScopeIds 同源，保证面板展示与范围过滤口径一致。
        if(action==='sessions'){
          // "有效会话"的判定基准是 **DSH 当前真实存在的会话**，不是工作区登记表。
          // 用户删掉会话后，workspace.json 里的 sessionIds 往往还留着残留项，
          // 若以登记表为准，这些会话产生的记忆永远会被判为"有效"，孤儿检测失效。
          const registered=value.bindingMode==='workspace'
            ?panelScopeIds(ctx,value)
            :(Array.isArray(value.bindingSessionIds)?value.bindingSessionIds:[]);
          const alive=new Set();
          try{
            const records=await ctx.sessionQuery?.listSessions?.();
            if(Array.isArray(records)){
              for(const record of records){
                const id=record?.header?.id;
                if(typeof id==='string'&&id)alive.add(id);
              }
            }
          }catch(error){
            // 读不到会话列表时退回"登记表"口径，宁可少报孤儿也不要误删
            console.warn('[dafeiyu-memory] 无法读取会话列表，孤儿判定退回工作区登记口径',error);
            return store.sessionInventory({liveSessionIds:registered});
          }
          return store.sessionInventory({liveSessionIds:[...alive]});
        }
        // 删除某个（已失效的）会话留下的全部记忆。
        // 破坏性操作：必须显式 confirm，且**只允许删 DSH 中已不存在的会话**。
        // 判定基准与 sessions 动作保持一致——用 sessionQuery.listSessions()，
        // 而不是工作区登记表（登记表在删会话后会残留）。
        if(action==='delete-session'){
          const target=typeof payload.sessionId==='string'?payload.sessionId.trim():'';
          if(!target)throw new Error('sessionId is required');
          if(payload.confirm!==true)throw new Error('删除记忆需要显式确认（confirm: true）');
          let alive=null;
          try{
            const records=await ctx.sessionQuery?.listSessions?.();
            if(Array.isArray(records)){
              alive=new Set();
              for(const record of records){
                const id=record?.header?.id;
                if(typeof id==='string'&&id)alive.add(id);
              }
            }
          }catch(error){
            throw new Error(`无法确认会话状态，已拒绝删除：${error?.message??error}`);
          }
          if(!alive)throw new Error('无法确认会话状态，已拒绝删除');
          if(alive.has(target)){
            throw new Error('该会话仍然存在，拒绝删除它的记忆。');
          }
          const result=store.deleteSessions([target]);
          console.info(`[dafeiyu-memory] 已删除会话 ${target} 的记忆：${result.messages} 条消息 / ${result.chunks} 个片段`);
          return {...result,sessionId:target};
        }
        if(action!=='page')throw new Error('Unsupported browse action');
        const offset=payload.offset??0;
        if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid offset');
        return store.browse({
          offset,limit:payload.limit??40,preview:payload.preview??110,
          query:typeof payload.query==='string'&&payload.query.trim()?payload.query.trim():null,
          role:payload.role==='user'||payload.role==='assistant'?payload.role:null,
          since:Number.isFinite(payload.since)?payload.since:null,
          before:Number.isFinite(payload.before)?payload.before:null,
          sessionIds,
        });
      },'memory_browse_failed'));
      /* 心情对接：只读 dsh-feiyu-mood 的 state.json，把当前心情与时间线
         折算成星图需要的情绪坐标。心情插件未安装/文件损坏时返回
         available:false，前端据此降级为随机色，绝不报错。 */
      routeDisposers.push(registerRpcRoute(ctx,MOOD_ENDPOINT,async payload=>{
        const state=readMoodState();
        if(!state){
          return {available:false,reason:'mood_plugin_unavailable'};
        }
        const key=state.lastActive&&state.moods[state.lastActive]
          ?state.lastActive
          :Object.keys(state.moods)[0];
        const slot=key?state.moods[key]:null;
        if(!slot)return {available:false,reason:'no_active_slot'};
        const current=moodToEmotion(slot);
        const timeline=Array.isArray(slot.timeline)?slot.timeline:[];
        // 只回传着色所需的字段，不回传 reason 等文本（可能含隐私内容）
        const points=timeline
          .filter(t=>Number.isFinite(Number(t?.at)))
          .map(t=>({at:Number(t.at),...moodToEmotion(t)}))
          .slice(-500);
        return {
          available:true,
          key,
          mood:Number.isFinite(Number(slot.mood))?Number(slot.mood):70,
          updatedAt:Number(slot.updatedAt)||0,
          current,
          points,
          hasTimeline:points.length>0,
        };
      },'memory_mood_failed'));
      routeDisposers.push(registerRpcRoute(ctx,SETTINGS_ENDPOINT,async payload=>{
        if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Invalid settings request');
        if(payload.action==='read'){
          const sessions=await sessionTargetPage(ctx,0,value.bindingSessionIds??[]);
          return {
            bindingMode:value.bindingMode,databasePath:value.database,
            bindingSessionIds:value.bindingSessionIds??null,bindingWorkspaceId:value.bindingWorkspaceId||null,
            sessionPage:sessions,workspaces:workspaceTargets(ctx),
            revision:settingsEntry(ctx).revision,
            strictScope:value.strictScope,
            scopeDirectory:value.scopeDirectory||null,
            scopePath:value.strictScope?scopeDatabasePath(value):null,
            scopeBackfill:scopeBackfill?await scopeBackfill:null,
            migration:value.pendingMigrationFrom?{
              id:value.pendingMigrationId||null,sourcePath:value.pendingMigrationFrom,targetPath:value.pendingMigrationTarget||null,
              state:migrationStatus?.state||'checking',error:migrationStatus?.error||null,
              sessions:migrationStatus?.sessions??null,
            }:null,
          };
        }
        /* ⭐ 2026-10-31：范围的唯一真源。设置面板只读写 scope.json，
           不再逐个调 set-binding-mode 去推两边（那会触发热切库与回灌）。 */
        if(payload.action==='read-scope'){
          return {
            root:范围根,
            path:scopeStorePath(范围根),
            saved:readScope(范围根),
            active:{
              mode:value.bindingMode,
              workspaceId:value.bindingWorkspaceId||'',
              sessionIds:value.bindingSessionIds||[],
            },
            scopePath:value.strictScope?scopeDatabasePath(value):null,
          };
        }
        if(payload.action==='write-scope'){
          const saved=writeScope(范围根,{
            mode:payload.mode,
            workspaceId:payload.workspaceId,
            sessionIds:payload.sessionIds,
          });
          return {
            ok:true,
            path:scopeStorePath(范围根),
            saved,
            active:{
              mode:value.bindingMode,
              workspaceId:value.bindingWorkspaceId||'',
              sessionIds:value.bindingSessionIds||[],
            },
            note:'已保存。重启 DSH 后记忆与心情都会按这个范围工作。',
          };
        }
        /* ⭐ 2026-10-31：数据根目录。scope.json 自己住在数据根里，所以「根在哪」
           不能写进 scope.json —— 单独存在 <DSH_HOME>/bigfish/root.json。
           同样走「拉」模式：写文件，重启后记忆与心情都按新根工作。 */
        if(payload.action==='read-data-root'){
          const 自定义=readDataRoot();
          /* ⭐ 2.3.3：必须同时给出「当前生效」和「下次启动会用」两个根。
             以前只给一个，用户改完目录却看到记忆库路径还是旧的，完全无法判断
             到底是没保存、还是没重启 —— 只能靠猜。 */
          const 下次=自定义||defaultDataRoot();
          const 当前=范围根;
          const 差=String(下次).toLowerCase()!==String(当前).toLowerCase();
          return {
            dataRoot:自定义,
            defaultRoot:范围根,
            // 当前这个进程实际在用的根
            activeRoot:当前,
            // 重启之后才会用的根
            pendingRoot:下次,
            // 两者不同 = 用户改了目录但还没重启
            restartNeeded:差,
            storePath:dataRootStorePath(),
            scopePath:value.strictScope?scopeDatabasePath(value):null,
            exists:自定义?existsSync(自定义):true,
            // 下次启动那个目录现在存在吗（不存在说明重启后会是全新空库）
            pendingExists:existsSync(下次),
          };
        }
        if(payload.action==='inspect-data-root-move'){
          // 只预演，不动任何文件 —— 面板用它来提示「会复制几个文件、多少 MB」
          const 目标=String(payload.dataRoot||'').trim();
          if(!目标)throw new Error('dataRoot must be a non-empty string');
          if(!isAbsolute(目标))throw new Error('Data root must be an absolute path');
          return inspectDataRootMove({from:范围根,to:目标,store:holder.current});
        }
        if(payload.action==='write-data-root'){
          if(typeof payload.dataRoot!=='string')throw new Error('dataRoot must be a string');
          const v=String(payload.dataRoot).trim();
          if(v&&!isAbsolute(v))throw new Error('Data root must be an absolute path');
          /* ⭐ 复制现有数据（方案 B）：
             顺序是「先复制、后改 root.json」—— 复制失败就什么都不改，用户还在旧目录里
             好好工作。源目录永远不删，只复制。 */
          let 复制=null;
          if(v&&payload.copyData===true){
            复制=copyDataRoot({from:范围根,to:v,store:holder.current});
            if(!复制.ok){
              return {
                ok:false,
                code:复制.code||'copy-failed',
                note:'复制失败，保存位置没有改动（仍然用 '+范围根+'）：'+(复制.reason||'未知原因'),
                copy:复制,
                dataRoot:readDataRoot(),
                storePath:dataRootStorePath(),
              };
            }
          }
          const saved=writeDataRoot(v);
          return {
            ok:true,
            dataRoot:saved,
            storePath:dataRootStorePath(),
            copy:复制,
            note:saved
              ? (复制&&复制.ok
                  ? '已保存并复制了 '+复制.copied.length+' 个文件到新目录（已校验）。重启 DSH 后生效。旧目录原地保留，确认没问题后可以自己删。'
                  : '已保存。重启 DSH 后记忆与心情都读写这个目录。旧目录里的数据不会自动搬 —— 需要的话把 scope.json 和各范围子目录一起移过去。')
              : '已恢复默认目录。重启 DSH 后生效。',
          };
        }
        if(payload.action==='list-sessions'){
          return sessionTargetPage(ctx,payload.offset??0,value.bindingSessionIds??[]);
        }
        if(payload.action==='split-bank'){
          // 一次性迁移：把旧单库按工作区拆到各自文件。只复制不删除。
          if(typeof payload.sourceDatabase!=='string'||!isAbsolute(payload.sourceDatabase))throw new Error('Source database must be an absolute path');
          const source=resolve(payload.sourceDatabase);
          if(!existsSync(source))throw new Error(`Source database not found: ${source}`);
          const baseDir=value.scopeDirectory&&isAbsolute(value.scopeDirectory)
            ?resolve(value.scopeDirectory):dirname(value.database);
          return splitBankIntoScopes(ctx,source,value.bank,baseDir);
        }
        if(payload.action==='set-strict-scope'){
          if(typeof payload.enabled!=='boolean')throw new Error('enabled must be a boolean');
          const patch={strictScope:payload.enabled};
          if(typeof payload.scopeDirectory==='string'){
            if(payload.scopeDirectory&&!isAbsolute(payload.scopeDirectory))throw new Error('Scope directory must be absolute');
            patch.scopeDirectory=payload.scopeDirectory;
          }
          await updateConfig(ctx,patch);
          value.strictScope=patch.strictScope;
          if(patch.scopeDirectory!==undefined)value.scopeDirectory=patch.scopeDirectory;
          return {strictScope:value.strictScope,scopeDirectory:value.scopeDirectory||null,
            scopePath:value.strictScope?scopeDatabasePath(value):null,changed:true};
        }
        if(payload.action==='set-binding-mode'){
          if(!['session','workspace'].includes(payload.bindingMode))throw new Error('Binding mode must be session or workspace');
          if(payload.bindingMode===value.bindingMode)return {bindingMode:value.bindingMode,changed:false};
          await updateConfig(ctx,{bindingMode:payload.bindingMode});
          value.bindingMode=payload.bindingMode;
          // 模式切换会改变范围库路径，必须同时热切换，否则要等重载才生效
          return applyScopeSwitch(ctx,value,switchDatabase,()=>controller.backfill(),{bindingMode:value.bindingMode});
        }
        if(payload.action==='set-session-targets'){
          if(payload.sessionIds===null){
            await unsetConfig(ctx,['bindingSessionIds']);
            delete value.bindingSessionIds;
            return applyScopeSwitch(ctx,value,switchDatabase,()=>controller.backfill(),{bindingSessionIds:null});
          }
          if(!Array.isArray(payload.sessionIds)||payload.sessionIds.some(id=>typeof id!=='string'||!id))throw new Error('Session targets must be a list of session ids');
          const sessionIds=[...new Set(payload.sessionIds)];
          const known=new Set((await ctx.sessionQuery.listSessions()).map(record=>record.header.id));
          const previouslySelected=new Set(value.bindingSessionIds??[]);
          if(sessionIds.some(id=>!known.has(id)&&!previouslySelected.has(id)))throw new Error('One or more selected sessions are no longer available; refresh the list and try again');
          await updateConfig(ctx,{bindingSessionIds:sessionIds});
          value.bindingSessionIds=sessionIds;
          return applyScopeSwitch(ctx,value,switchDatabase,()=>controller.backfill(),{bindingSessionIds:sessionIds});
        }
        if(payload.action==='set-workspace-target'){
          if(typeof payload.workspaceId!=='string')throw new Error('Workspace target must be an id or empty');
          if(payload.workspaceId&&!resolveWorkspace(ctx,payload.workspaceId))throw new Error('The selected workspace is no longer available; refresh the list and try again');
          await updateConfig(ctx,{bindingWorkspaceId:payload.workspaceId});
          value.bindingWorkspaceId=payload.workspaceId;
          return applyScopeSwitch(ctx,value,switchDatabase,()=>controller.backfill(),{bindingWorkspaceId:payload.workspaceId});
        }
        // 查询某个范围已有的记忆库，供"是否读取以往目录"提示使用
        if(payload.action==='inspect-scope'){
          const probe={...value,
            bindingMode:typeof payload.bindingMode==='string'?payload.bindingMode:value.bindingMode,
            bindingWorkspaceId:typeof payload.workspaceId==='string'?payload.workspaceId:value.bindingWorkspaceId,
            bindingSessionIds:Array.isArray(payload.sessionIds)?payload.sessionIds:value.bindingSessionIds};
          const target=scopeDatabasePath(probe);
          if(!target)return {path:null,exists:false,messages:0};
          const exists=existsSync(target);
          let messages=0;
          if(exists){
            try{
              const probeStore=new MemoryStore(target,value.bank);
              try{messages=probeStore.storageStats().messages;}finally{probeStore.close();}
            }catch(error){
              console.warn('[dafeiyu-memory] 探测范围库失败',error);
            }
          }
          return {path:target,exists,messages};
        }
        if(payload.action==='change-database-directory'){
          if(typeof payload.directory!=='string'||!payload.directory.trim()||!isAbsolute(payload.directory))throw new Error('Choose an absolute directory path');
          const directory=resolve(payload.directory);
          if(!statSync(directory).isDirectory())throw new Error('Selected path is not a directory');
          const target=resolve(realpathSync(directory),'memory.sqlite3');
          const source=canonicalDatabasePath(value.database);
          if(samePath(target,source))return {databasePath:value.database,changed:false};
          const migrationId=randomUUID();
          const replaced=await copyDatabaseToTarget(store,controller,source,target,value.bank,payload.replaceTarget===true);
          let persistenceError;
          try{
            await updateConfig(ctx,{database:target,pendingMigrationFrom:source,pendingMigrationTarget:target,
              pendingMigrationId:migrationId,pendingMigrationSourceIdentity:replaced.sourceIdentity});
          }catch(error){persistenceError=error;}
          finally{
            if(replaced.previousTargetPath){try{unlinkSync(replaced.previousTargetPath);}catch(cleanupError){console.error('[dafeiyu-memory] Could not remove replaced target backup',cleanupError);}}
          }
          if(persistenceError)throw new Error(`The settings update response was interrupted or rejected. The verified target remains at ${target}; the original database and sidecars were preserved. Refresh before retrying: ${persistenceError?.message??'unknown error'}`);
          // Volatile config edits are committed in place without reloading this plugin, so
          // `apply()` does not run again and this closure keeps its original snapshot. Update
          // the in-memory values here or `read` would keep reporting the previous database.
          value.database=target;
          value.pendingMigrationFrom=source;
          value.pendingMigrationTarget=target;
          value.pendingMigrationId=migrationId;
          value.pendingMigrationSourceIdentity=replaced.sourceIdentity;
          migrationStatus={state:'checking'};
          migrationTask=Promise.resolve().then(verifyPendingMigration);
          return {databasePath:target,changed:true,copied:true,migrationPending:true,migrationId,backfilledSessions:replaced.backfilledSessions};
        }
        if(payload.action==='retry-migration-verification'){
          if(!value.pendingMigrationFrom||payload.migrationId!==value.pendingMigrationId)throw new Error('Migration confirmation is stale; refresh the settings panel');
          migrationStatus={state:'checking'};
          migrationTask=Promise.resolve().then(verifyPendingMigration);
          await migrationTask;
          return {id:value.pendingMigrationId,state:migrationStatus?.state||'blocked',error:migrationStatus?.error||null,sessions:migrationStatus?.sessions??null};
        }
        if(payload.action==='finalize-migration')return finalizeMigration(payload.migrationId);
        throw new Error('Unsupported memory settings action');
      },'memory_settings_failed'));
      if(value.pendingMigrationFrom)migrationTask=Promise.resolve().then(verifyPendingMigration);
    }catch(error){
      for(const dispose of routeDisposers.reverse())void dispose();
      if(controller)void controller.close();
      else store.close();
      throw error;
    }
    console.info(`[dsh-bigfish/memory] 已启用；bank=${value.bank}；mode=${value.bindingMode}；数据库=${value.database}`);
    return async()=>{
      try{for(const dispose of routeDisposers.reverse())await dispose();}
      finally{
        try{if(migrationTask)await migrationTask;}
        finally{await controller.close();}
      }
    };
  });
}
