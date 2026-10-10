import { address } from '../../src/domain.mjs';
const hash = n => `0x${(100 + n).toString(16)}`;
const OLD = '0x11', NEW = '0x12';
export const legacyAbi = [
  { type: 'function', name: 'ownerOf', inputs: [{ name: 'tokenId', type: 'Uint256' }], outputs: [{ name: 'owner', type: 'felt' }] },
  { type: 'event', name: 'Transfer', keys: [], data: [{ name: 'from', type: 'felt' }, { name: 'to', type: 'felt' }, { name: 'token_id', type: 'Uint256' }] },
  { type: 'event', name: 'Upgraded', keys: [], data: [{ name: 'class_hash', type: 'felt' }] },
];
export const modernAbi = [
  legacyAbi[0],
  { type: 'event', name: 'Transfer', kind: 'struct', members: [{ name: 'from', kind: 'key', type: 'core::starknet::contract_address::ContractAddress' }, { name: 'to', kind: 'key', type: 'core::starknet::contract_address::ContractAddress' }, { name: 'token_id', kind: 'data', type: 'core::integer::u256' }] },
  legacyAbi.at(-1),
];
export function canonicalHarness({ height = 10, events = new Map(), classes = () => OLD } = {}) {
  return { setHead: value => { height = value; }, call: async (method, p) => {
    if (method === 'starknet_chainId') return '0x1';
    const blockId = p.block_id;
    const n = blockId === 'latest' ? height : blockId?.block_number ?? Number(BigInt(blockId?.block_hash ?? '0x64')) - 100;
    if (method === 'starknet_getClassHashAt') return classes(n);
    if (method === 'starknet_getClass') return { abi: p.class_hash === NEW ? modernAbi : legacyAbi };
    if (method === 'starknet_call') return [BigInt(p.request.calldata[0]) === 8n ? '0x3' : '0x2'];
    if (method === 'starknet_getEvents') return { events: [...events.entries()].flatMap(([block, values]) => block >= p.filter.from_block.block_number && block <= p.filter.to_block.block_number
      ? values.map(raw => ({ ...raw, block_number: block, block_hash: hash(block), transaction_hash: `0x${(1000 + block).toString(16)}` })) : []) };
    return { block_number: n, block_hash: hash(n), parent_hash: n ? hash(n - 1) : '0x0', timestamp: n + 100,
      status: 'ACCEPTED_ON_L2', transactions: method === 'starknet_getBlockWithReceipts' && events.has(n)
        ? [{ receipt: { transaction_hash: `0x${(1000 + n).toString(16)}`, execution_status: 'SUCCEEDED', events: events.get(n) } }] : [] };
  } };
}
