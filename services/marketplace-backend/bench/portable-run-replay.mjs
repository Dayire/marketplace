// Portable copy: normal pg package resolution; explicit frozen inputs and local PG18.6 binary/scratch options.
const { default: pg } = await import(process.env.MEASUREMENT_PG_MODULE ?? "pg");
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";
import assert from "node:assert/strict";
import { RecordedRpc, stable, contentDigest } from "./replay-utils.mjs";
import { digest } from "./capture-utils.mjs";
const root=dirname(fileURLToPath(import.meta.url)), runtime=join(root,"../runtime");
const outputBase=resolve(process.env.MEASUREMENT_OUTPUT_DIR??root);mkdirSync(outputBase,{recursive:true});
const output=join(outputBase,`replay-${new Date().toISOString().replace(/[:.]/g,"-")}`);mkdirSync(output);
const pgBin=resolve(process.env.MEASUREMENT_PG_BIN_DIR??join(runtime,"postgresql/bin"));
const scratch=resolve(process.env.MEASUREMENT_SCRATCH_DIR??runtime);mkdirSync(scratch,{recursive:true});
const pgVersion=spawnSync(join(pgBin,"postgres"),["--version"],{encoding:"utf8"}).stdout?.trim();
assert.match(pgVersion??"",/18\.6\b/,"This evidence runner requires the pinned PostgreSQL18.6 binary");
const capture=resolve(process.env.MEASUREMENT_CAPTURE_DIR??readFileSync(join(root,"latest-capture.txt"),"utf8").trim());
const stateDirectory=resolve(process.env.MEASUREMENT_STATE_DIR??readFileSync(join(root,"latest-state.txt"),"utf8").trim());
const history=JSON.parse(readFileSync(join(capture,"historical.json"))), recent=JSON.parse(readFileSync(join(capture,"recent.json")));
const registry=JSON.parse(readFileSync(join(capture,"registry.json"))).chains.SN_MAIN;
const state=JSON.parse(readFileSync(join(stateDirectory,"state.json")));
const classes={historical:JSON.parse(readFileSync(join(capture,"historical-realms-class.json"))),recent:JSON.parse(readFileSync(join(capture,"recent-realms-class.json")))};
const liveDirectory=process.env.MEASUREMENT_WITH_LIVE?resolve(process.env.MEASUREMENT_LIVE_DIR??readFileSync(join(root,"latest-live.txt"),"utf8").trim()):null;
const live=liveDirectory?JSON.parse(readFileSync(join(liveDirectory,"live.json"))):null;
if(live){assert.equal(live.failures.length,0);assert.ok(live.state.classes.every(c=>BigInt(c.classHash)===BigInt(classes.recent.classHash)));classes.live=classes.recent;}
const windowState=window=>window.label==="live"?{...state,...live.state}:state;
const versions=process.argv[2]?[{label:process.argv[4]??"candidate",source:resolve(process.argv[2]),sha:process.argv[3]}]:[{label:"main",source:join(root,"source-main"),sha:"561d94538c794f48ea12ae41617aa6dc8af53432"},{label:"pr122",source:join(root,"source-pr122"),sha:"a03ff136c351ed931ad96a9fd7dd17e6c93696e5"}];
for (const version of versions) {
 assert.match(version.label, /^[a-z][a-z0-9_]{0,31}$/);
 const provenanceFile=join(version.source,"SOURCE-PROVENANCE.json");
 if(existsSync(provenanceFile)){
  assert.equal(version.sha,JSON.parse(readFileSync(provenanceFile,"utf8")).sha,"SHA must match the frozen archive");
 }else{
  const observed=spawnSync("git",["-C",version.source,"rev-parse","HEAD"],{encoding:"utf8"});
  assert.equal(observed.status,0,"Use an exact Git checkout or a frozen archive with SOURCE-PROVENANCE.json");
  assert.equal(version.sha,observed.stdout.trim(),"SHA must match the checkout");
  const clean=spawnSync("git",["-C",version.source,"diff","--quiet",version.sha,"--","services/marketplace-backend/src","config/marketplace","packages/marketplace-sdk/src"]);
  assert.equal(clean.status,0,"Executed backend/registry/SDK sources must match the supplied commit");
 }
}
const cluster=join(scratch,`measurement-cluster-${Date.now()}`);mkdirSync(cluster,{mode:0o700});
const passwordPath=join(cluster,"local.password"),password=randomBytes(32).toString("hex");writeFileSync(passwordPath,password,{mode:0o600,flag:"wx"});
const listener=net.createServer();await new Promise((ok,bad)=>{listener.once("error",bad);listener.listen(0,"127.0.0.1",ok);});const port=listener.address().port;await new Promise(ok=>listener.close(ok));
const user="measurement_admin",data=join(cluster,"data"),localConfig=join(cluster,"local-config.json");writeFileSync(localConfig,JSON.stringify({port,user,passwordPath}),{mode:0o600});
const env={...process.env,PGHOST:"127.0.0.1",PGPORT:String(port),PGUSER:user,PGPASSWORD:password,PGDATABASE:"postgres"};
const command=(name,args)=>{const res=spawnSync(join(pgBin,name),args,{env,encoding:"utf8",timeout:60000});if(res.status!==0)throw new Error(`${name} failed (${res.status}): ${res.stderr??""}`);return res.stdout;};
command("initdb",["-D",data,"-U",user,"--auth-host=scram-sha-256","--auth-local=peer","--pwfile",passwordPath,"--encoding=UTF8","--locale=C"]);
writeFileSync(join(data,"postgresql.conf"),`\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nmax_connections=40\n`,{flag:"a"});
const start=()=>command("pg_ctl",["-D",data,"-l",join(cluster,"server.log"),"-w","start"]),stop=()=>command("pg_ctl",["-D",data,"-w","stop","-m","fast"]);
const pools=new Set();
function pool(database){const pool=new pg.Pool({host:"127.0.0.1",port,user,password,database,max:4});pools.add(pool);return pool;}
async function close(pool){await pool.end();pools.delete(pool);}
function instrument(pool){
 const metrics={statements:0,sqlWrites:0,affectedRows:0,sqlMs:0},connect=pool.connect.bind(pool),wrapped=new WeakSet();
 const wrap=(client)=>{if(!client||wrapped.has(client))return client;wrapped.add(client);const query=client.query.bind(client);
  client.query=function(sql,...args){const before=performance.now();const record=(res)=>{metrics.statements++;metrics.sqlMs+=performance.now()-before;const text=typeof sql==="string"?sql:sql.text;if(/^\s*(INSERT|UPDATE|DELETE)\b/i.test(text)){metrics.sqlWrites++;metrics.affectedRows+=res?.rowCount??0;}return res;};
   const callback=typeof args.at(-1)==="function"?args.pop():null;
   if(callback)return query(sql,...args,(error,res)=>{if(!error)record(res);callback(error,res);});
   const result=query(sql,...args);return result?.then?result.then(record):result;
  };return client;};
 pool.connect=function(callback){return typeof callback==="function"?connect((error,client,release)=>callback(error,wrap(client),release)):connect().then(wrap);};return metrics;
}
async function tableDigests(pool){const names=(await pool.query("SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND (table_schema=ANY($1) OR (table_schema='public' AND table_name='marketplace_migrations')) ORDER BY 1,2",[["chain","market","app","media"]])).rows,result={};for(const {table_schema:s,table_name:t} of names){if(!/^[a-z_][a-z0-9_]*$/.test(s)||!/^[a-z_][a-z0-9_]*$/.test(t))throw new Error("Unsafe table name");const rows=(await pool.query(`SELECT to_jsonb(t) AS row FROM "${s}"."${t}" t ORDER BY to_jsonb(t)::text`)).rows;result[`${s}.${t}`]={count:rows.length,sha256:digest(JSON.stringify(rows))};}return result;}
const compatibleKinds=["token","order","activity","approval","operator","stats_day","floor_current","floor_history"];
async function compatible(store){const result={};for(const kind of compatibleKinds)result[kind]=stable(await store.list(kind));return result;}
async function stats(pool){const size=(await pool.query("SELECT pg_database_size(current_database())::text AS bytes,pg_current_wal_lsn()::text AS lsn")).rows[0];const rows=(await pool.query("SELECT schemaname,relname,pg_total_relation_size(relid)::text AS bytes,n_live_tup::text,n_tup_ins::text,n_tup_upd::text,n_tup_del::text FROM pg_stat_user_tables ORDER BY schemaname,relname")).rows;return {...size,tables:rows};}
async function seedDurable(pool){await pool.query("INSERT INTO app.app_meta VALUES('measurement-fixture',$1)",[{synthetic:true,value:"application state must survive chain recovery"}]);const bytes=Buffer.from("synthetic application media preservation fixture"),name=digest(bytes)+".svg";await pool.query("INSERT INTO media.assets VALUES($1,'image/svg+xml',$2)",[name,bytes]);return {name,sha256:digest(bytes)};}
async function durable(pool,expected){const app=(await pool.query("SELECT value FROM app.app_meta WHERE key='measurement-fixture'")).rows[0];const media=(await pool.query("SELECT bytes FROM media.assets WHERE name=$1",[expected.name])).rows[0];assert.equal(app.value.synthetic,true);assert.equal(digest(media.bytes),expected.sha256);return true;}
const results=[],failures=[];let running=false;
try{
 start();running=true;
 for(const version of versions){
  const src=join(version.source,"services/marketplace-backend/src");
  const {migrate}=await import(pathToFileURL(join(src,"postgres/migrate.mjs")));const {PgStore}=await import(pathToFileURL(join(src,"postgres/store.mjs")));const {scanOnce}=await import(pathToFileURL(join(src,"indexer.mjs")));const {preflight}=await import(pathToFileURL(join(src,"preflight.mjs")));
  for(const window of [history,recent,...(live?[live]:[])]){
   const database=`${version.label}_${window.label}`;command("createdb",[database]);const connection=pool(database);await migrate(connection);const store=new PgStore(connection),synthetic=await seedDurable(connection);
   const config={...registry,chain:"SN_MAIN",marketplace:window.label==="historical"?null:registry.marketplace,marketplaceClassHash:window.label==="historical"?null:windowState(window).marketplaceClassHash,marketplaceStartBlock:window.from,collections:registry.collections.map(c=>({...c,startBlock:window.from}))};
   const rpc=new RecordedRpc(window,registry,classes[window.label],windowState(window));
   let density=null;
   if(existsSync(join(src,"discovery-scan.mjs"))&&window.label==="historical"){
    try{await scanOnce(store,rpc,config,{window:64,stopAt:window.to,receiptConcurrency:2});density={rejected:false};}
    catch(error){density={rejected:true,code:error.code,head:await store.head()};assert.equal(error.code,"WINDOW_EVENTS_DENSE");assert.equal(density.head,null);}
   }
   const rpcStart=rpc.calls.length,metrics=instrument(connection),before=await stats(connection),started=performance.now(),chunks=[];
   let crash=null;
   for(let n=window.from;n<=window.to;n+=16){
    if(window.label==="historical"&&n===window.from+32){
     const snapshot=await tableDigests(connection),b=window.blocks[32];
     const blockFile=join(output,`${version.label}-crash-block.json`);writeFileSync(blockFile,JSON.stringify({number:b.block_number,hash:b.block_hash,parentHash:b.parent_hash,timestamp:b.timestamp,events:[],sources:config.collections.map(c=>c.address),sourceStarts:Object.fromEntries(config.collections.map(c=>[c.address,c.startBlock])),observedAt:Date.now()}));
     const child=spawn(process.execPath,[join(root,"portable-crash-writer.mjs")],{env:{...process.env,MEASUREMENT_LOCAL_CONFIG:localConfig,MEASUREMENT_LOCAL_DATABASE:database,MEASUREMENT_STORE_MODULE:join(src,"postgres/store.mjs"),MEASUREMENT_BLOCK_FILE:blockFile},stdio:["ignore","ignore","pipe","ipc"]});
     let stderr="";child.stderr.on("data",bytes=>{stderr+=bytes.toString();});
     const message=await Promise.race([once(child,"message"),once(child,"exit").then(()=>{throw new Error(`Crash child exited: ${stderr.slice(0,300)}`);}),new Promise((_,bad)=>{const t=setTimeout(()=>bad(new Error("Crash worker did not reach uncommitted state")),10000);t.unref();})]);
     const ended=once(child,"exit");child.kill("SIGKILL");await ended;
     assert.deepEqual(await tableDigests(connection),snapshot,"killed writer leaves no partial indexed data or source checkpoint");
     crash={signal:"SIGKILL",uncommittedBoundary:message[0],allTableDigestsUnchanged:true};
    }
    const priorMetrics={...metrics},priorLsn=(await connection.query("SELECT pg_current_wal_lsn()::text AS lsn")).rows[0].lsn;
    const begin=performance.now(),scan=await scanOnce(store,rpc,config,{window:16,stopAt:Math.min(n+15,window.to),receiptConcurrency:2,commitBatchSize:16}),scanMs=performance.now()-begin;
    const currentLsn=(await connection.query("SELECT pg_current_wal_lsn()::text AS lsn")).rows[0].lsn;
    const chunkWal=(await connection.query("SELECT pg_wal_lsn_diff($1,$2)::text AS bytes",[currentLsn,priorLsn])).rows[0].bytes;
    chunks.push({from:n,to:Math.min(n+15,window.to),ms:scanMs,sqlWrites:metrics.sqlWrites-priorMetrics.sqlWrites,affectedRows:metrics.affectedRows-priorMetrics.affectedRows,walBytes:chunkWal,scan});
   }
   const elapsedMs=performance.now()-started,after=await stats(connection);const walBytes=(await connection.query("SELECT pg_wal_lsn_diff($1,$2)::text AS bytes",[after.lsn,before.lsn])).rows[0].bytes;
   const common=await compatible(store);writeFileSync(join(output,`${version.label}-${window.label}-common.json`),JSON.stringify(common,null,2));
   assert.equal((await store.head()).number,window.to);const progress=await store.list("progress");for(const source of progress){assert.equal(source.block,window.to);assert.equal(BigInt(source.hash),BigInt(window.blocks.at(-1).block_hash));}
   const strictRegistry={...config,collections:registry.collections,marketplace:registry.marketplace,marketplaceClassHash:registry.marketplaceClassHash,marketplaceStartBlock:registry.marketplaceStartBlock};
   const quote=await preflight(store,null,strictRegistry,{account:"0x2",items:[{maker:"0x3",nonce:"1"}]});assert.equal(quote.canSubmit,false);assert.ok(quote.reasons.includes("SOURCE_BACKFILL_REQUIRED"));
   const replayCalls=rpc.calls.slice(rpcStart),pureScanMsSum=chunks.reduce((n,c)=>n+c.ms,0);
   const entry={label:version.label,sha:version.sha,sample:window.label,database,from:window.from,to:window.to,registryDeploymentStart:registry.collections[0].startBlock,completeHistory:false,elapsedMs,pureScanMsSum,blocksPerSecond:window.blocks.length/(pureScanMsSum/1000),chunks,density,rpcCallsReplayed:replayCalls.length,rpcCallsByMethod:Object.fromEntries([...new Set(replayCalls.map(c=>c.method))].map(method=>[method,replayCalls.filter(c=>c.method===method).length])),rpcTransport:"offline replay from actual receipts; no replay network timing claim",sql:{...metrics,walBytes,pureScanWrites:chunks.reduce((n,c)=>n+c.sqlWrites,0),pureScanWalBytes:chunks.reduce((n,c)=>n+BigInt(c.walBytes),0n).toString(),databaseGrowthBytes:String(BigInt(after.bytes)-BigInt(before.bytes)),before,after},compatibilitySha256:contentDigest(common),progress:stable(progress),preflight:{canSubmit:quote.canSubmit,reasons:quote.reasons},crash,durablePreserved:await durable(connection,synthetic),noProductionTrades:true};
   const previousProgress=stable(await store.list("progress"));
   await assert.rejects(scanOnce(store,{call:async()=>{throw Object.assign(new Error("controlled unavailable RPC"),{code:"RPC_UNAVAILABLE"});}},config,{window:16}),{code:"RPC_UNAVAILABLE"});
   assert.equal(contentDigest(await compatible(store)),contentDigest(common));assert.deepEqual(stable(await store.list("progress")),previousProgress);
   const unavailable=await store.get("status","rpc");assert.equal(unavailable.error,"RPC_UNAVAILABLE");assert.equal(unavailable.identityVerified,false);
   await scanOnce(store,new RecordedRpc(window,registry,classes[window.label],windowState(window)),config,{window:16});
   entry.scannerOutage={controlled:true,projectionUnchanged:true,sourceProgressUnchanged:true,errorRecorded:"RPC_UNAVAILABLE",successfulRetry:true};
   if(window.label==="historical"){
    const expected=await tableDigests(connection);await close(connection);const oldPid=readFileSync(join(data,"postmaster.pid"),"utf8").split("\n")[0];stop();running=false;start();running=true;const newPid=readFileSync(join(data,"postmaster.pid"),"utf8").split("\n")[0];assert.notEqual(oldPid,newPid);const recovered=pool(database);assert.deepEqual(await tableDigests(recovered),expected);const recoveryStore=new PgStore(recovered);
    const duplicateStart=performance.now();await scanOnce(recoveryStore,new RecordedRpc(window,registry,classes[window.label],windowState(window)),config,{window:16});assert.deepEqual(contentDigest(await compatible(recoveryStore)),contentDigest(common));entry.restart={postgresPidChanged:true,allTableDigestsMatch:true,duplicateCatchupMs:performance.now()-duplicateStart,projectionUnchanged:true};
    const dump=join(output,`${version.label}-historical.dump`),dumpStart=performance.now();command("pg_dump",["--format=custom","--file",dump,"--dbname",database]);const dumpMs=performance.now()-dumpStart;command("createdb",[`${database}_restore`]);const restoreStart=performance.now();command("pg_restore",["--exit-on-error","--no-owner","--no-acl","--dbname",`${database}_restore`,dump]);const restored=pool(`${database}_restore`);assert.deepEqual(await tableDigests(restored),await tableDigests(recovered));entry.dumpRestore={format:"custom",dumpMs,restoreMs:performance.now()-restoreStart,bytes:readFileSync(dump).length,sha256:digest(readFileSync(dump)),tablesVerified:Object.keys(expected).length,allTableContentDigestsMatch:true};await close(restored);
    const rewindStart=performance.now();await recoveryStore.rewind(window.from-1);assert.equal(await recoveryStore.head(),null);assert.equal((await recoveryStore.list("token")).length,0);await durable(recovered,synthetic);const rerpc=new RecordedRpc(window,registry,classes[window.label],windowState(window));for(let n=window.from;n<=window.to;n+=16)await scanOnce(recoveryStore,rerpc,config,{window:16,stopAt:Math.min(n+15,window.to),receiptConcurrency:2,commitBatchSize:16});assert.equal(contentDigest(await compatible(recoveryStore)),contentDigest(common));entry.reorg={controlledRollback:true,actualObservedFork:false,rewindTo:window.from-1,replayedThrough:window.to,ms:performance.now()-rewindStart,ownershipAndActivityDigestRestored:true,durablePreserved:await durable(recovered,synthetic)};await close(recovered);
   }else await close(connection);
   results.push(entry);writeFileSync(join(output,"partial-results.json"),JSON.stringify({results,failures},null,2));
  }
 }
}catch(error){failures.push({error:error.message,stack:error.stack?.split("\n").slice(0,5)});}
finally{for(const connection of pools)await connection.end().catch(()=>{});if(running)stop();}
const comparisons=[];for(const sample of ["historical","recent",...(live?["live"]:[])]){const rows=results.filter(r=>r.sample===sample);if(rows.length>1)comparisons.push({sample,baseline:rows[0].sha,candidate:rows[1].sha,commonProjectionEqual:rows[0].compatibilitySha256===rows[1].compatibilitySha256});}
const result={at:new Date().toISOString(),output,capture,stateDirectory,postgres:"18.6",node:process.version,results,comparisons,failures,noTransactionsSubmitted:true,limitations:["Single machine, single cold replay per version and sample; timings are exploratory, not a production SLA.","Replay is offline from real receipts; unfiltered inventory derives from those receipts, with one real global query page separately observed.","Historical samples start after contract deployment and cannot certify complete-history ownership or supply.","Process kill, outage/rate-limit, rollback and restart experiments are controlled local faults; no actual mainnet fork or provider outage is claimed.","No marketplace trades were observed in these samples; positive order lifecycle/preflight remain separately labeled fixtures."]};writeFileSync(join(output,"result.json"),JSON.stringify(result,null,2));writeFileSync(join(outputBase,"latest-replay.txt"),output+"\n");if(versions.length>1)writeFileSync(join(outputBase,"baseline-replay.txt"),output+"\n");console.log(JSON.stringify({output,results:results.map(r=>({label:r.label,sample:r.sample,elapsedMs:r.elapsedMs,sqlWrites:r.sql.sqlWrites,rpcCalls:r.rpcCallsReplayed,crash:r.crash,restart:r.restart,dumpRestore:r.dumpRestore,reorg:r.reorg})),comparisons,failures},null,2));if(failures.length)process.exitCode=1;
