import { runtime } from "./runtime.mjs";
import { indexerOptions, catalogOptions } from "./indexer-options.mjs";
import { scanOnce } from "./indexer.mjs";
import { createHash } from "node:crypto";
import { runIndexingCycle } from './source-cycle.mjs';
const { store, config, rpc } = await runtime();
let releaseLease;
try {
  const command = process.argv[2] ?? "once";
  if (command !== "reconcile" && store.acquireIndexerLease)
    releaseLease = await store.acquireIndexerLease();
  if (command === "reconcile") {
    const state = {
      head: await store.head(),
      tokens: await store.list("token"),
      orders: await store.list("order"),
      config: await store.get("config", "marketplace"),
    };
    console.log(
      JSON.stringify({
        chain: config.chain,
        head: state.head,
        tokens: state.tokens.length,
        orders: state.orders.length,
        hash: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
      }),
    );
  } else if (command === "rewind") {
    const height = Number(process.argv[3]);
    if (!Number.isSafeInteger(height) || height < 0)
      throw new Error("Specify a nonnegative rewind block.");
    await store.rewind(height);
    console.log(JSON.stringify({ rewoundTo: await store.head() }));
  } else {
    if (!rpc) throw new Error("MARKETPLACE_RPC_URL is required.");
    const stop = process.env.MARKETPLACE_STOP_BLOCK
      ? Number(process.env.MARKETPLACE_STOP_BLOCK)
      : undefined;
    do {
      const result = process.env.MARKETPLACE_CATALOG_ENABLED === 'true'
        ? await runIndexingCycle(store, rpc, config, { ...catalogOptions(), live: { ...catalogOptions().live, stopAt: stop }, discovery: { ...catalogOptions().discovery, stopAt: stop } })
        : await scanOnce(store, rpc, config, { ...indexerOptions(), stopAt: stop });
      console.log(JSON.stringify(result));
      if (
        command !== "backfill" ||
        result.indexed >= Math.min(result.head, stop ?? Infinity)
      )
        break;
    } while (true);
  }
} finally {
  if (releaseLease) await releaseLease();
  await store.close();
}
