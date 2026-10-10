import test from "node:test";
import assert from "node:assert/strict";
import { RecordedRpc, globalEvents, contentDigest } from "./replay-utils.mjs";
const window={from:7,to:7,blocks:[{block_number:7,block_hash:"0x7",parent_hash:"0x6",status:"ACCEPTED_ON_L1",transactions:[{receipt:{transaction_hash:"0xaa",execution_status:"SUCCEEDED",events:[{from_address:"0x9",keys:["0x1"],data:[]},{from_address:"0x8",keys:["0x1"],data:[]}]}}]}]};
test("recorded replay retains actual event positions, supports all-emitter pagination, refuses uncaptured history and writes",async()=>{
 const rpc=new RecordedRpc(window,{chainId:"0x1"},{address:"0x9",classHash:"0x10",contractClass:{abi:"[]"}});
 assert.equal(globalEvents(window)[1].event_index,1);
 const filter={from_block:{block_number:7},to_block:{block_number:7},keys:[],chunk_size:1};
 const first=await rpc.call("starknet_getEvents",{filter});assert.equal(first.events[0].from_address,"0x9");
 const next=await rpc.call("starknet_getEvents",{filter:{...filter,continuation_token:first.continuation_token}});assert.equal(next.events[0].from_address,"0x8");
 await assert.rejects(rpc.call("starknet_getEvents",{filter:{...filter,from_block:{block_number:6}}}),/Uncaptured/);
 await assert.rejects(rpc.call("starknet_addInvokeTransaction",{}),/public reads/);
});
test("content comparisons normalize observation clocks while preserving provenance and monetary values",()=>{
 assert.equal(contentDigest({observedAt:1,amount:"9007199254740993",provenance:{blockHash:"0x7"}}),contentDigest({observedAt:2,amount:"9007199254740993",provenance:{blockHash:"0x7"}}));
 assert.notEqual(contentDigest({amount:"1",provenance:{blockHash:"0x7"}}),contentDigest({amount:"1",provenance:{blockHash:"0x8"}}));
 assert.notEqual(contentDigest({updatedAt:{blockHash:"0x7"}}),contentDigest({updatedAt:{blockHash:"0x8"}}));
});
