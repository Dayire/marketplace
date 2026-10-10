import { address } from './domain.mjs';
import { collectionKey } from './collection-catalog.mjs';
import { activeClassInterval } from './discovery.mjs';
import { DECODER_CAPABILITY } from './decode.mjs';

/** Indexing authority is deliberately separate from settlement configuration. */
export async function indexingSource(store, config, raw) {
  const collection = address(raw);
  const configured = (config.collections ?? []).find(c => address(c.address) === collection);
  if (configured) return configured;
  const record = await store.get('catalog_collection', collectionKey(config.chainId, collection));
  const evidence = record?.classification;
  if (!record || !['candidate', 'syncing', 'indexed'].includes(record.state)
      || !['ERC721', 'ERC1155'].includes(record.standard)
      || !evidence || evidence.standard !== record.standard || evidence.method === 'probe_failed'
      || ['proxy_unverified', 'fungible', 'abi_unavailable', 'unknown_implementation'].includes(evidence.uncertainty)
      || record.quarantine || record.decoderVersion !== DECODER_CAPABILITY
      || !Number.isSafeInteger(record.deployment?.block) || record.deployment.block < 0
      || !record.deployment.hash || !record.classHistory?.length) return null;
  const active = activeClassInterval(record, evidence.evidenceBlock ?? Number.MAX_SAFE_INTEGER);
  if (!active || !evidence.classHash || BigInt(active.classHash) !== BigInt(evidence.classHash)) return null;
  return { address: collection, startBlock: record.deployment.block, standard: record.standard,
    classHash: evidence.classHash, decoderVersion: record.decoderVersion, indexingOnly: true };
}

/** Only promoted, canonically complete sources join the shared live reader. */
export async function liveIndexingConfig(store, config) {
  const collections = [...(config.collections ?? [])], head = await store.head();
  if (!head) return { ...config, collections };
  for (const job of await store.list('backfill_job')) {
    if (job.state !== 'promoted' || BigInt(job.chainId) !== BigInt(config.chainId)) continue;
    if (collections.some(c => address(c.address) === address(job.collection))) continue;
    const source = await indexingSource(store, config, job.collection);
    const progress = await store.get('progress', address(job.collection));
    if (!source || !progress || progress.block !== head.number || BigInt(progress.hash) !== BigInt(head.hash)
        || progress.startBlock > source.startBlock) continue;
    collections.push(source);
  }
  return { ...config, collections };
}
