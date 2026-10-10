import { address } from '../../src/domain.mjs';
import { SELECTORS } from '../../src/decode.mjs';
import { canonicalHarness, legacyAbi } from './canonical-chain.mjs';
const A = address('0xa'), X = address('0xb');
const hash = n => `0x${(100 + n).toString(16)}`;
export const cfg = { chain: 'LOCAL', chainId: '0x1', marketplace: null, collections: [{ address: A, startBlock: 0 }], currencies: [] };
export const opts = { live: { window: 2 }, discovery: { span: 20, emitters: false }, backfill: { window: 2 } };
export function sourceHarness() {
  const rpc = canonicalHarness({ height: 6, events: new Map([[3, [{ from_address: X, keys: [SELECTORS.Transfer], data: ['0x0', '0x2', '7', '0'] }]]]) });
  const call = rpc.call;
  rpc.call = async (method, p) => {
    if (method === 'starknet_getClass') return { abi: [...legacyAbi,
      { type: 'function', name: 'transferFrom', inputs: [] },
    ] };
    if (method === 'starknet_call') return ['0x2'];
    if (method === 'starknet_getStateUpdate') {
      const n = p.block_id.block_number;
      return { block_hash: hash(n), state_diff: { deployed_contracts: n === 2 ? [{ address: X, class_hash: '0x11' }] : [], replaced_classes: [] } };
    }
    return call(method, p);
  };
  return rpc;
}

