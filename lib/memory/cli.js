#!/usr/bin/env node
import { MemoryStore } from './lib/store.js';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const [operation,path,bank='dafeiyu',...args]=process.argv.slice(2);
if(!operation||!path){
  console.log('用法: dafeiyu-memory <status|search|read|sleep|replay|backup|anchor|important|import-v02> <数据库路径> <bank> [参数]');
  process.exit(1);
}
const store=new MemoryStore(resolve(path),bank);
try{
  let result;
  switch(operation){
    case 'status':result=store.stats();break;
    case 'search':result=store.recall(args.join(' '),{archive:true,maxChars:6000});break;
    case 'read':result=store.read(Number(args[0]),{offset:args[1]===undefined?null:Number(args[1])});break;
    case 'sleep':result=store.sleep();break;
    case 'replay':result=store.replay();break;
    case 'backup':await store.backup(resolve(args[0]));result={backup:resolve(args[0])};break;
    case 'anchor':result={id:store.anchor(args[0],args[1].split(',').map(Number),args.slice(2))};break;
    case 'important':store.configure(Number(args[0]),{category:'durable',importance:.9});result={ok:true};break;
    case 'import-v02':{
      const old=new DatabaseSync(resolve(args[0]),{readOnly:true});
      let count=0;
      try{
        // Explicit import: dates from the Python prototype may have been caller supplied.
        for(const row of old.prepare('SELECT m.*,c.owner FROM messages m JOIN conversations c ON c.id=m.conversation ORDER BY m.id').iterate()){
          if(row.owner!==args[1])continue;
          if(!['user','assistant'].includes(row.role))continue;
          if(store.capture({session:`legacy:${resolve(args[0])}:${row.conversation}`,eventKey:String(row.id),role:row.role,
            content:[{type:'text',text:row.content}],sourceTime:null}))count++;
        }
      }finally{old.close();}
      result={imported:count,note:'只导入指定 owner 的聊天原文；旧时间不冒充 DSH 系统时间，旧索引/锚点不迁移。'};break;
    }
    default:throw new Error('Unknown operation');
  }
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error(error.message);process.exitCode=1;}finally{store.close();}
