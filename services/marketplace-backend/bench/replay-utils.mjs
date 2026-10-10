import { readMethod, digest } from "./capture-utils.mjs";
const canonical=(value)=>"0x"+BigInt(value).toString(16);
export function globalEvents(window) {
  const events=[];
  for(const block of window.blocks) for(const [transaction_index,tx] of block.transactions.entries()) {
    if(tx.receipt.execution_status==="REVERTED")continue;
    for(const [event_index,event] of tx.receipt.events.entries()) events.push({...event,block_number:block.block_number,block_hash:block.block_hash,transaction_hash:tx.receipt.transaction_hash??tx.transaction.transaction_hash,transaction_index,event_index});
  }
  return events;
}
export class RecordedRpc {
  constructor(window, registry, classData, state=null) {
    this.window=window;this.registry=registry;this.classData=classData;this.state=state;
    this.blocks=new Map(window.blocks.map(block=>[block.block_number,block]));
    if(window.anchors?.prior)this.blocks.set(window.from-1,window.anchors.prior);
    this.hashes=new Map([...this.blocks.values()].map(block=>[canonical(block.block_hash),block]));
    this.events=globalEvents(window);this.calls=[];this.rateLimits=0;this.urls=["https://recorded-public-receipts.invalid"];
  }
  async call(method, params) {
    readMethod(method);this.calls.push({method,params});
    if(method==="starknet_chainId")return this.registry.chainId;
    if(method==="starknet_getEvents") {
      const f=params.filter,from=f.from_block.block_number,to=f.to_block.block_number;
      if(from<this.window.from||to>this.window.to)throw new Error("Uncaptured event range requested");
      const keys=f.keys??[];
      const found=this.events.filter(event=>event.block_number>=from&&event.block_number<=to&&(!f.address||canonical(f.address)===canonical(event.from_address))&&keys.every((options,index)=>!options.length||(event.keys[index]!=null&&options.some(key=>canonical(key)===canonical(event.keys[index])))));
      const offset=f.continuation_token?Number(f.continuation_token.replace(/^replay:/,"")):0;
      if(!Number.isSafeInteger(offset)||offset<0)throw new Error("Invalid replay pagination");
      const end=offset+f.chunk_size;
      return {events:found.slice(offset,end),...(end<found.length?{continuation_token:`replay:${end}`}:{})};
    }
    const block=params?.block_id==="latest"?this.blocks.get(this.pinnedHeadNumber??this.window.to):params?.block_id?.block_number!=null?this.blocks.get(params.block_id.block_number):params?.block_id?.block_hash?this.hashes.get(canonical(params.block_id.block_hash)):null;
    if(method==="starknet_getBlockWithReceipts") {if(!block||!block.transactions?.every(tx=>tx.receipt))throw new Error("Uncaptured receipt block");return block;}
    if(method==="starknet_getBlockWithTxHashes") {if(!block)throw new Error("Uncaptured header");return {...block,transactions:(block.transactions??[]).map(tx=>tx.transaction?.transaction_hash??tx.receipt?.transaction_hash??tx)};}
    if(method==="starknet_getClassHashAt") {
      if(!block)throw new Error("Uncaptured class block");
      if(canonical(params.contract_address)===canonical(this.registry.marketplace)) {
        if(block.block_number<this.registry.marketplaceStartBlock)throw new Error("Marketplace not deployed in historical sample");
        if(!this.state?.marketplaceClassHash)throw new Error("Marketplace class observation missing");
        return this.state.marketplaceClassHash;
      }
      if(canonical(params.contract_address)!==canonical(this.classData.address))throw new Error("Uncaptured contract class");
      const observed=this.state?.classes?.find(value=>value.number===block.block_number&&canonical(value.blockHash)===canonical(block.block_hash));
      if(this.state&&!observed)throw new Error("Uncaptured per-block class");
      return observed?.classHash??this.classData.classHash;
    }
    if(method==="starknet_getClass") {
      if(canonical(params.class_hash)!==canonical(this.classData.classHash))throw new Error("Uncaptured class ABI");
      // Preserve the provider's actual string ABI, so older candidates exercise their real fallback.
      return this.classData.contractClass;
    }
    throw new Error(`No recorded response for ${method}`);
  }
  async batch(calls){return Promise.all(calls.map(call=>this.call(call.method,call.params)));}
}
const VOLATILE=new Set(["observedAt","fetchedAt","metadataFetchedAt","metadataNextAttempt","updatedAt","createdAt","durationMs","acquisitionMs","commitMs"]);
export function stable(value) {
  if(Array.isArray(value))return value.map(stable);
  if(!value||typeof value!=="object")return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key=>!VOLATILE.has(key)||((key==="updatedAt"||key==="createdAt")&&value[key]&&typeof value[key]==="object")).map(key=>[key,stable(value[key])]));
}
export const contentDigest=(value)=>digest(stable(value));
