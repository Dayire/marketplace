import { readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { RpcClient } from "./rpc.mjs";
import { address } from "./domain.mjs";
export async function runtime(env = process.env) {
  if (
    env.MARKETPLACE_STORE &&
    !["sqlite", "postgres"].includes(env.MARKETPLACE_STORE)
  )
    throw new Error("Unknown marketplace storage mode");
  const registry = JSON.parse(
    env.MARKETPLACE_REGISTRY_JSON ||
      readFileSync(
        env.MARKETPLACE_REGISTRY_PATH ??
          new URL("../../../config/marketplace/registry.json", import.meta.url),
        "utf8",
      ),
  );
  const chain = env.MARKETPLACE_CHAIN ?? "SN_MAIN",
    settings = registry.chains[chain];
  if (!settings) throw new Error(`Chain ${chain} is not registered.`);
  const config = {
    ...settings,
    chain,
    maintenance: env.MARKETPLACE_MAINTENANCE === "true",
    origin: env.MARKETPLACE_ORIGIN ?? "http://localhost:3000",
    operatorToken: env.MARKETPLACE_OPERATOR_TOKEN,
    trustedProxyHosts: env.MARKETPLACE_TRUSTED_PROXY_HOSTS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    trustedProxyAddresses: env.MARKETPLACE_TRUSTED_PROXY_ADDRESSES?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    ipfsGateway: env.MARKETPLACE_IPFS_GATEWAY ?? "https://ipfs.io/ipfs",
    assetDir: resolve(
      env.MARKETPLACE_ASSET_DIR ?? "services/marketplace-backend/data/assets",
    ),
  };
  if (env.MARKETPLACE_ADDRESS)
    config.marketplace = address(env.MARKETPLACE_ADDRESS);
  if (env.MARKETPLACE_START_BLOCK)
    config.marketplaceStartBlock = Number(env.MARKETPLACE_START_BLOCK);
  if (env.MARKETPLACE_CLASS_HASH)
    config.marketplaceClassHash = env.MARKETPLACE_CLASS_HASH;
  let store;
  if (
    env.MARKETPLACE_STORE === "postgres" ||
    (!env.MARKETPLACE_STORE && env.DATABASE_URL)
  ) {
    if (!env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for PostgreSQL.");
    const { Pool } = (await import("pg")).default;
    const { PgStore } = await import("./postgres/store.mjs");
    const { SCHEMA_VERSION } = await import('./postgres/migrate.mjs');
    const max = Number(env.MARKETPLACE_PG_POOL_SIZE ?? 6);
    if (!Number.isInteger(max) || max < 2 || max > 30)
      throw new Error("PostgreSQL pool size must be 2–30.");
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      statement_timeout: 30000,
      idle_in_transaction_session_timeout: 30000,
      application_name: `marketplace-${env.MARKETPLACE_PROCESS_ROLE ?? "api"}`,
    });
    pool.on("error", (error) =>
      console.error(
        JSON.stringify({
          event: "pg_pool_error",
          code: error.code ?? "CONNECTION_ERROR",
        }),
      ),
    );
    store = new PgStore(pool, { ownsPool: true });
    const identity = {
      chainId: "0x" + BigInt(config.chainId).toString(16),
      marketplace: config.marketplace ? address(config.marketplace) : null,
    };
    try {
      if (
        !(
          await store.query(
            "SELECT to_regclass('public.marketplace_migrations') AS table_name",
          )
        ).rows[0].table_name
      )
        throw new Error(
          `PostgreSQL schema migration ${SCHEMA_VERSION} is required before startup.`,
        );
      const versions = (await store.query('SELECT count(*) AS n FROM public.marketplace_migrations WHERE version BETWEEN 1 AND $1', [SCHEMA_VERSION])).rows[0];
      if (Number(versions.n) !== SCHEMA_VERSION)
        throw new Error(`PostgreSQL schema migration ${SCHEMA_VERSION} is required before startup.`);
      const actual = (
        await store.query("SELECT value FROM chain.meta WHERE key='identity'")
      ).rows[0]?.value;
      if (
        !actual ||
        actual.chainId !== identity.chainId ||
        actual.marketplace !== identity.marketplace
      )
        throw new Error(
          "PostgreSQL identity is missing or mismatched. Run the reviewed migration/registry initialization first.",
        );
    } catch (error) {
      await store.close();
      throw error;
    }
  } else {
    const path = resolve(
      env.MARKETPLACE_DB ?? `services/marketplace-backend/data/${chain}.sqlite`,
    );
    mkdirSync(dirname(path), { recursive: true });
    const { Store } = await import("./store.mjs");
    store = new Store(path);
    for (const c of config.collections)
      store.put("collection", address(c.address), {
        ...c,
        address: address(c.address),
        verified: false,
        ...store.get("collection", address(c.address)),
      });
  }
  const urls = [
    env.MARKETPLACE_RPC_URL,
    env.MARKETPLACE_RPC_FALLBACK_URL,
  ].filter(Boolean);
  const rpc = urls.length ? new RpcClient(urls) : null;
  return { store, config, rpc };
}
