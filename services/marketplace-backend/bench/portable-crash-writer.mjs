const { default: pg } = await import(process.env.MEASUREMENT_PG_MODULE ?? "pg");
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const config=JSON.parse(readFileSync(process.env.MEASUREMENT_LOCAL_CONFIG));
const password=readFileSync(config.passwordPath,"utf8");
const pool=new pg.Pool({host:"127.0.0.1",port:config.port,user:config.user,password,database:process.env.MEASUREMENT_LOCAL_DATABASE,max:1});
const {PgStore}=await import(pathToFileURL(process.env.MEASUREMENT_STORE_MODULE));
const store=new PgStore(pool);
const block=JSON.parse(readFileSync(process.env.MEASUREMENT_BLOCK_FILE));
await store.transaction(async()=>{
 await store.applyBlock(block);
 process.send({state:"uncommitted",number:block.number,hash:block.hash});
 await new Promise(()=>{});
});
