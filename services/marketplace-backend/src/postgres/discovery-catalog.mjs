import { address, boundedInteger, ApiError } from "../domain.mjs";
import { collectionVisible } from "../catalog-state.mjs";
import {
  collectionKey,
  collectionRecord,
  sourceCoverage,
  sourceReadiness,
  COLLECTION_STATES,
} from "../collection-catalog.mjs";

/** Called within the migration/initialization transaction. Existing evidence wins.
 * Seed configured coverage honestly; its live checkpoint remains chain.progress.
 */
export async function seedRegisteredCollections(db) {
  await db.query(`INSERT INTO chain.collection_catalog(id,body)
    SELECT (i.value->>'chainId') || ':' || c.id,
      jsonb_build_object('id',(i.value->>'chainId') || ':' || c.id,
        'chainId',i.value->>'chainId','address',c.id,
        'state',CASE WHEN p.id IS NULL THEN 'unknown' ELSE 'syncing' END,
        'standard',NULL,'deployment',NULL,'classHistory','[]'::jsonb,
        'classification',NULL,'decoderVersion',NULL,'replayGeneration',g.value)
    FROM market.collections c CROSS JOIN chain.meta i CROSS JOIN chain.meta g
      LEFT JOIN chain.progress p ON p.id=c.id
    WHERE i.key='identity' AND i.value->>'chainId' IS NOT NULL AND g.key='generation'
    ON CONFLICT(id) DO NOTHING`);
  await db.query(`INSERT INTO chain.source_coverage(id,body)
    SELECT (i.value->>'chainId') || ':' || p.id,
      p.body || jsonb_build_object('id',(i.value->>'chainId') || ':' || p.id,
        'chainId',i.value->>'chainId','address',p.id,
        'startBlock',p.body->'startBlock',
        'block',CASE WHEN p.body->>'block' IS NOT NULL AND p.body->>'hash' IS NOT NULL THEN p.body->'block' ELSE 'null'::jsonb END,
        'hash',CASE WHEN p.body->>'block' IS NOT NULL AND p.body->>'hash' IS NOT NULL THEN p.body->'hash' ELSE 'null'::jsonb END,
        'observedAt',p.body->'observedAt',
        'sourceType',CASE WHEN p.id=i.value->>'marketplace' THEN 'marketplace' ELSE 'nft' END,
        'mode','configured_scan','replayGeneration',g.value,'gaps','[]'::jsonb)
    FROM chain.progress p CROSS JOIN chain.meta i CROSS JOIN chain.meta g
    WHERE i.key='identity' AND i.value->>'chainId' IS NOT NULL AND g.key='generation'
    ON CONFLICT(id) DO NOTHING`);
}

/** Internal/operator catalog. Public discovery expansion is a separate milestone. */
export class PgDiscoveryCatalog {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.chainId = collectionKey(config.chainId, "0").split(":")[0];
  }
  key(raw) {
    return collectionKey(this.chainId, raw);
  }
  async coverage(raw) {
    const collection = address(raw),
      saved = await this.store.get("source_coverage", this.key(collection));
    if (saved && saved.mode !== "configured_scan") return saved;
    // The existing scanner remains authoritative until independent source jobs land.
    const configured =
      (this.config.collections ?? []).some(
        (c) => address(c.address) === collection,
      ) ||
      (this.config.marketplace &&
        address(this.config.marketplace) === collection);
    if (!saved && !configured) return null;
    const progress = await this.store.get("progress", collection);
    const hasCheckpoint = progress?.block != null && progress?.hash != null;
    return sourceCoverage({
      ...saved,
      ...progress,
      chainId: this.chainId,
      address: collection,
      block: hasCheckpoint ? progress.block : null,
      hash: hasCheckpoint ? progress.hash : null,
      startBlock: progress?.startBlock ?? null,
      observedAt: progress?.observedAt ?? null,
      sourceType:
        this.config.marketplace &&
        collection === address(this.config.marketplace)
          ? "marketplace"
          : "nft",
      mode: "configured_scan",
      replayGeneration: await this.store.generation(),
    });
  }
  async collection(raw) {
    const a = address(raw),
      record = await this.store.get("catalog_collection", this.key(a));
    if (!record)
      throw new ApiError(
        "NOT_FOUND",
        "Collection has not been discovered",
        404,
      );
    const row = (
      await this.store.query(
        `SELECT
      (SELECT body FROM market.collections WHERE id=$1) AS registered,
      (SELECT value FROM app.app_meta WHERE key=$2) AS visibility,
      (SELECT value FROM app.app_meta WHERE key=$3) AS verification,
      EXISTS(SELECT 1 FROM app.moderation WHERE collection=$1) AS restricted,
      (SELECT body FROM market.policies WHERE id=$4) AS policy`,
        [
          a,
          `catalog_visibility:${record.id}`,
          `verification:${a}`,
          `collection:${a}`,
        ],
      )
    ).rows[0];
    const configured = (this.config.collections ?? []).some(
      (c) => address(c.address) === a,
    );
    return {
      ...row.registered,
      ...record,
      coverage: await this.coverage(a),
      indexed: record.state === "indexed",
      registered: !!row.registered,
      visible: collectionVisible(this.config, a, { registered: row.registered, record,
        visibility: row.visibility, restricted: row.restricted }),
      verified: row.verification?.verified === true,
      tradable:
        !!this.config.marketplace &&
        configured &&
        !!row.registered &&
        record.standard !== "ERC1155" &&
        row.policy?.enabled === true,
    };
  }
  async list({ limit, cursor, state } = {}) {
    const count = boundedInteger(limit),
      generation = await this.store.generation();
    if (state != null && !COLLECTION_STATES.includes(state))
      throw new ApiError("INVALID_QUERY", "Invalid catalog state");
    let after = "";
    if (cursor) {
      let decoded;
      try {
        if (typeof cursor !== "string" || cursor.length > 2048)
          throw new Error();
        decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
          throw new Error();
      } catch {
        throw new ApiError("CURSOR_MISMATCH", "Invalid catalog cursor");
      }
      if (
        decoded.chainId !== this.chainId ||
        decoded.generation !== generation ||
        decoded.state !== (state ?? null) ||
        typeof decoded.after !== "string" ||
        decoded.resource !== "discovery-catalog"
      )
        throw new ApiError(
          "CURSOR_MISMATCH",
          "Cursor belongs to another catalog query or generation",
        );
      after = decoded.after;
    }
    const rows = (
      await this.store.query(
        `SELECT address,id FROM chain.collection_catalog
      WHERE chain_id=$1 AND id>$2 AND ($3::text IS NULL OR state=$3) ORDER BY id LIMIT $4`,
        [this.chainId, after, state ?? null, count + 1],
      )
    ).rows;
    const more = rows.length > count;
    if (more) rows.pop();
    return {
      items: await Promise.all(rows.map((r) => this.collection(r.address))),
      generation,
      nextCursor: more
        ? Buffer.from(
            JSON.stringify({
              resource: "discovery-catalog",
              chainId: this.chainId,
              generation,
              state: state ?? null,
              after: rows.at(-1).id,
            }),
          ).toString("base64url")
        : null,
    };
  }
  async readiness(required) {
    if (!Array.isArray(required) || required.length > 1000)
      throw new ApiError("INVALID_QUERY", "Invalid source scope");
    const scope = required.map((s) => ({ ...s, chainId: this.chainId })),
      coverage = await Promise.all(scope.map((s) => this.coverage(s.address))),
      canonicalHashes = {};
    for (const block of new Set(
      coverage
        .filter(Boolean)
        .map((c) => c.block)
        .filter((n) => n !== null),
    ))
      canonicalHashes[block] =
        (await this.store.canonicalBlock(block))?.hash ?? null;
    const status = sourceReadiness(scope, coverage, {
      rpc: await this.store.get("status", "rpc"),
      generation: await this.store.generation(),
      canonicalHashes,
    });
    for (const source of status.sources) {
      const record = await this.store.get("catalog_collection", source.id);
      if (
        source.coverage?.mode === "catalog" &&
        record?.replayGeneration !== status.generation
      ) {
        source.ready = false;
        if (!source.reasons.includes("GENERATION_MISMATCH"))
          source.reasons.push("GENERATION_MISMATCH");
        if (!status.reasons.includes("GENERATION_MISMATCH"))
          status.reasons.push("GENERATION_MISMATCH");
        status.ready = false;
      }
      if (source.coverage?.mode === "catalog" && record?.state !== "indexed") {
        source.ready = false;
        if (!source.reasons.includes("SOURCE_SYNCING"))
          source.reasons.push("SOURCE_SYNCING");
        if (!status.reasons.includes("SOURCE_SYNCING"))
          status.reasons.push("SOURCE_SYNCING");
        status.ready = false;
      }
      if (record && ["failed", "unsupported"].includes(record.state)) {
        const reason =
          record.state === "failed" ? "SOURCE_FAILED" : "SOURCE_UNSUPPORTED";
        source.ready = false;
        source.reasons.push(reason);
        if (!status.reasons.includes(reason)) status.reasons.push(reason);
        status.ready = false;
      }
    }
    const history = await this.store.get("status", "history");
    if (history && coverage.some((c) => c?.mode === "configured_scan")) {
      const anchor =
        history.state === "passed" &&
        Number.isSafeInteger(history.checkpointBlock)
          ? await this.store.canonicalBlock(history.checkpointBlock)
          : null;
      if (
        !anchor ||
        history.checkpointHash == null ||
        BigInt(anchor.hash) !== BigInt(history.checkpointHash)
      ) {
        status.ready = false;
        status.reasons.push("HISTORY_RECONCILIATION_REQUIRED");
      }
    }
    return status;
  }
  /** The existing ordered writer owns catalog updates. Fact/progress undo records
   * share one transaction and cannot be committed against an orphan/stale head.
   */
  async commit(facts, progress, height) {
    return this.store.transaction(async () => {
      const generation = await this.store.generation(),
        head = await this.store.head();
      if (!head || height !== head.number)
        throw new ApiError(
          "CHAIN_GAP",
          "Catalog writes require the canonical writer head",
          409,
        );
      const identity = (
        await this.store.query(
          "SELECT value FROM chain.meta WHERE key='identity'",
        )
      ).rows[0]?.value;
      if (
        !identity ||
        collectionKey(identity.chainId, "0") !==
          collectionKey(this.chainId, "0")
      )
        throw new ApiError(
          "DATABASE_IDENTITY_MISMATCH",
          "Catalog writer belongs to another chain",
        );
      if (
        facts.chainId != null &&
        collectionKey(facts.chainId, facts.address) !== this.key(facts.address)
      )
        throw new ApiError(
          "DATABASE_IDENTITY_MISMATCH",
          "Catalog belongs to another chain",
        );
      const previous = await this.store.get(
        "catalog_collection",
        this.key(facts.address),
      );
      const record = collectionRecord({
        ...previous,
        ...facts,
        chainId: this.chainId,
        replayGeneration: facts.replayGeneration ?? generation,
      });
      if (record.replayGeneration !== generation)
        throw new ApiError(
          "STALE_GENERATION",
          "Catalog generation changed",
          409,
        );
      for (const p of [
        record.deployment,
        ...record.classHistory.flatMap((c) => [c.from, c.to]),
      ].filter(Boolean)) {
        const canonical =
          p.block <= height && (await this.store.canonicalBlock(p.block));
        if (!canonical || BigInt(canonical.hash) !== BigInt(p.hash))
          throw new ApiError(
            "CHAIN_GAP",
            "Catalog evidence is not anchored to canonical history",
            409,
          );
      }
      await this.store.put("catalog_collection", record.id, record, height);
      if (progress) {
        const coverage = sourceCoverage({
          ...progress,
          chainId: this.chainId,
          address: record.address,
          mode: "catalog",
          sourceType: "nft",
          replayGeneration: progress.replayGeneration ?? generation,
        });
        if (coverage.replayGeneration !== generation)
          throw new ApiError(
            "STALE_GENERATION",
            "Coverage generation changed",
            409,
          );
        if (coverage.block !== null) {
          const canonical =
            coverage.block <= height &&
            (await this.store.canonicalBlock(coverage.block));
          if (!canonical || BigInt(canonical.hash) !== BigInt(coverage.hash))
            throw new ApiError(
              "CHAIN_GAP",
              "Coverage checkpoint is not canonical",
              409,
            );
        }
        await this.store.put("source_coverage", record.id, coverage, height);
      }
      return record;
    });
  }
}
