import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { numericKey, MAX_U256 } from "./domain.mjs";
// One metadata identity per (collection, token ID), even when an ERC1155 token
// has many owners. Balance rows remain the ownership authority; no ERC721 owner
// projection is synthesized to make metadata scheduling work.
const pgIndexedTokens = `SELECT id,collection,token_id,body,burned FROM market.tokens t
  WHERE NOT EXISTS(SELECT 1 FROM chain.collection_catalog c WHERE c.address=t.collection AND c.standard='ERC1155')
  UNION ALL SELECT collection || ':' || token_id::text AS id,collection,token_id,
    body - ARRAY['owner','balance','balanceFelts']::text[] || jsonb_build_object(
      'id',collection || ':' || token_id::text,'standard','ERC1155','metadataSourceId',id),false AS burned
  FROM (SELECT b.*,ROW_NUMBER() OVER (PARTITION BY collection,token_id
    ORDER BY (body->'updatedAt'->>'blockNumber')::bigint DESC NULLS LAST,
      (body->'updatedAt'->>'eventIndex')::bigint DESC NULLS LAST,id) AS source_rank
    FROM market.erc1155_balances b WHERE balance>0
      AND NOT EXISTS(SELECT 1 FROM chain.collection_catalog c WHERE c.address=b.collection AND c.standard='ERC721')) balances
  WHERE source_rank=1 AND NOT EXISTS(SELECT 1 FROM market.tokens t WHERE t.collection=balances.collection AND t.token_id=balances.token_id
    AND NOT EXISTS(SELECT 1 FROM chain.collection_catalog c WHERE c.address=t.collection AND c.standard='ERC1155'))`;
const sqliteIndexedTokens = `SELECT id,body,num_key FROM entities t WHERE kind='token'
  AND NOT EXISTS(SELECT 1 FROM entities c WHERE c.kind='catalog_collection'
    AND json_extract(c.body,'$.address')=json_extract(t.body,'$.collection') AND json_extract(c.body,'$.standard')='ERC1155')
  UNION ALL SELECT json_extract(body,'$.collection') || ':' || json_extract(body,'$.tokenId') AS id,
    json_set(json_remove(body,'$.owner','$.balance','$.balanceFelts'),'$.id',
      json_extract(body,'$.collection') || ':' || json_extract(body,'$.tokenId'),
      '$.standard','ERC1155','$.metadataSourceId',id) AS body,num_key
  FROM (SELECT b.*,ROW_NUMBER() OVER (PARTITION BY json_extract(body,'$.collection'),json_extract(body,'$.tokenId')
    ORDER BY json_extract(body,'$.updatedAt.blockNumber') DESC,json_extract(body,'$.updatedAt.eventIndex') DESC,id) AS source_rank
    FROM entities b WHERE kind='erc1155_balance' AND json_extract(body,'$.balance')!='0'
      AND NOT EXISTS(SELECT 1 FROM entities c WHERE c.kind='catalog_collection'
        AND json_extract(c.body,'$.address')=json_extract(b.body,'$.collection') AND json_extract(c.body,'$.standard')='ERC721')) balances
  WHERE source_rank=1 AND NOT EXISTS(SELECT 1 FROM entities t WHERE t.kind='token'
    AND json_extract(t.body,'$.collection')=json_extract(balances.body,'$.collection')
    AND json_extract(t.body,'$.tokenId')=json_extract(balances.body,'$.tokenId')
    AND NOT EXISTS(SELECT 1 FROM entities c WHERE c.kind='catalog_collection'
      AND json_extract(c.body,'$.address')=json_extract(t.body,'$.collection') AND json_extract(c.body,'$.standard')='ERC1155'))`;

const currentMetadataTarget = (store, token) => token.standard === "ERC1155"
  ? store.get("erc1155_balance", token.metadataSourceId) : store.get("token", token.id);
export const metadataAuthorityVersion = (record) => record ? {
  id: record.id, standard: record.standard, state: record.state,
  replayGeneration: record.replayGeneration, decoderVersion: record.decoderVersion,
  classHash: record.classification?.classHash ?? null,
  implementationClassHash: record.classification?.implementationClassHash ?? null,
  currentClass: record.classHistory?.at(-1) ?? null,
} : null;
async function authorityCurrent(store, claim) {
  return !claim.sourceAuthority || isDeepStrictEqual(claim.sourceAuthority,
    metadataAuthorityVersion(await store.get("catalog_collection", claim.sourceAuthority.id)));
}
export async function expandMetadataJobs(store) {
  const now = Date.now();
  if (store.dialect === "postgres")
    return store.transaction(async () => {
      const row = (
        await store.query(
          "SELECT id,body FROM market.metadata_jobs WHERE body->>'state'='pending' AND id LIKE '%:*' ORDER BY COALESCE((body->>'expandedAt')::bigint,0),id LIMIT 1",
        )
      ).rows[0];
      if (!row) return;
      const job = row.body;
      const rows = (
        await store.query(
          `SELECT id,token_id::text AS token_id FROM (${pgIndexedTokens}) targets
            WHERE NOT burned AND collection=$1 AND token_id>=$2 AND token_id<=$3
            AND ($4::numeric IS NULL OR token_id>$4::numeric) ORDER BY token_id LIMIT 100`,
          [
            job.collection,
            job.fromTokenId ?? "0",
            job.toTokenId ?? MAX_U256.toString(),
            job.cursor ?? null,
          ],
        )
      ).rows;
      for (const token of rows) {
        const existing = await store.get("metadata_job", token.id);
        if ((existing?.leaseUntil ?? 0) > now) continue;
        await store.put("metadata_job", token.id, {
          ...existing,
          state: "pending",
          collection: job.collection,
          tokenId: token.token_id,
          updatedAt: job.updatedAt,
        });
      }
      await store.put("metadata_job", row.id, {
        ...job,
        state: rows.length === 100 ? "pending" : "complete",
        cursor: rows.at(-1)?.token_id ?? job.cursor,
        expandedAt: now,
      });
    });
  const rows = store.db
    .prepare(
      "SELECT id,body FROM entities WHERE kind='metadata_job' AND json_extract(body,'$.state')='pending' AND id LIKE '%:*' ORDER BY COALESCE(json_extract(body,'$.expandedAt'),0),id LIMIT 1",
    )
    .all();
  for (const row of rows) {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const job = JSON.parse(row.body),
        tokens = store.db
          .prepare(
            `SELECT id,body FROM (${sqliteIndexedTokens}) targets WHERE COALESCE(json_extract(body,'$.burned'),0)=0
              AND json_extract(body,'$.collection')=? AND num_key>=? AND num_key<=?
              AND (? IS NULL OR num_key>?) ORDER BY num_key LIMIT 100`,
          )
          .all(
            job.collection,
            numericKey(job.fromTokenId ?? "0"),
            numericKey(job.toTokenId ?? MAX_U256),
            job.cursor ?? null,
            job.cursor ? numericKey(job.cursor) : null,
          );
      for (const token of tokens) {
        const existing = store.get("metadata_job", token.id);
        if ((existing?.leaseUntil ?? 0) > now) continue;
        store.put("metadata_job", token.id, {
          ...existing,
          state: "pending",
          collection: job.collection,
          tokenId: JSON.parse(token.body).tokenId,
          updatedAt: job.updatedAt,
        });
      }
      store.put("metadata_job", row.id, {
        ...job,
        state: tokens.length === 100 ? "pending" : "complete",
        cursor: tokens.length
          ? JSON.parse(tokens.at(-1).body).tokenId
          : job.cursor,
        expandedAt: now,
      });
      store.db.exec("COMMIT");
    } catch (e) {
      store.db.exec("ROLLBACK");
      throw e;
    }
  }
}
export async function metadataCandidates(store, now, limit, quota = null) {
  // A per-collection quota keeps one collection from exhausting the queue;
  // quota=null keeps the legacy unlimited ranking for existing callers.
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Metadata limit must be 1–100");
  if (quota != null && (!Number.isInteger(quota) || quota < 1 || quota > limit))
    throw new Error("Metadata quota must be 1–limit");
  const pgEligible = `SELECT t.id,t.collection,t.body || COALESCE(m.body,'{}'::jsonb) AS body,
    CASE WHEN job.body->>'state'='pending' THEN 0 ELSE 1 END AS priority,
    CASE WHEN m.body->>'image' IS NULL THEN 0 ELSE 1 END AS missing_image,
    COALESCE((m.body->>'metadataFetchedAt')::bigint,0) AS fetched_at
    FROM (${pgIndexedTokens}) t LEFT JOIN market.token_metadata m ON m.id=t.id
    LEFT JOIN market.metadata_jobs job ON job.id=t.id
    WHERE NOT t.burned AND COALESCE((job.body->>'leaseUntil')::bigint,0)<=$1
      AND (COALESCE((m.body->>'metadataNextAttempt')::bigint,0)<=$1 OR job.body->>'state'='pending')`;
  const sqliteEligible = `SELECT t.id,json_extract(t.body,'$.collection') AS collection,
    json_patch(t.body,COALESCE(m.body,'{}')) AS body,
    CASE WHEN json_extract(job.body,'$.state')='pending' THEN 0 ELSE 1 END AS priority,
    CASE WHEN COALESCE(json_extract(m.body,'$.image'),json_extract(t.body,'$.image')) IS NULL THEN 0 ELSE 1 END AS missing_image,
    COALESCE(json_extract(m.body,'$.metadataFetchedAt'),json_extract(t.body,'$.metadataFetchedAt'),0) AS fetched_at
    FROM (${sqliteIndexedTokens}) t LEFT JOIN entities job ON job.kind='metadata_job' AND job.id=t.id
    LEFT JOIN entities m ON m.kind='token_metadata' AND m.id=t.id
    WHERE COALESCE(json_extract(t.body,'$.burned'),0)=0
      AND COALESCE(json_extract(job.body,'$.leaseUntil'),0)<=?
      AND (COALESCE(json_extract(m.body,'$.metadataNextAttempt'),json_extract(t.body,'$.metadataNextAttempt'),0)<=?
        OR json_extract(job.body,'$.state')='pending')`;
  const ranking = "priority,missing_image,fetched_at,id";
  // Apply the quota in SQL before the global limit. A bounded overfetch followed
  // by JS filtering can still contain only one large collection and starve others.
  const fair = (eligible, quotaParameter, limitParameter) =>
    `WITH eligible AS (${eligible}), ranked AS (
      SELECT *,ROW_NUMBER() OVER (PARTITION BY collection ORDER BY ${ranking}) AS collection_rank
      FROM eligible)
     SELECT body FROM ranked WHERE collection_rank<=${quotaParameter}
     ORDER BY collection_rank,${ranking} LIMIT ${limitParameter}`;
  const rows =
    store.dialect === "postgres"
      ? (
          await store.query(
            quota == null
              ? `SELECT body FROM (${pgEligible}) eligible ORDER BY ${ranking} LIMIT $2`
              : fair(pgEligible, "$3", "$2"),
            quota == null ? [now, limit] : [now, limit, quota],
          )
        ).rows.map((r) => r.body)
      : store.db
          .prepare(
            quota == null
              ? `SELECT body FROM (${sqliteEligible}) eligible ORDER BY ${ranking} LIMIT ?`
              : fair(sqliteEligible, "?", "?"),
          )
          .all(...(quota == null ? [now, now, limit] : [now, now, quota, limit]))
          .map((r) => JSON.parse(r.body));
  return rows;
}
export async function claimMetadataJob(store, token, now, expectedGeneration = null) {
  if (store.dialect === "postgres")
    return store.transaction(async () => {
      const job = (await store.get("metadata_job", token.id)) ?? {
        attempts: 0,
      };
      if ((job.leaseUntil ?? 0) > now) return null;
      const lease = randomUUID(),
        generation = await store.generation();
      if (expectedGeneration != null && generation !== expectedGeneration) return null;
      await store.put("metadata_job", token.id, {
        ...job,
        state: "running",
        lease,
        leaseUntil: now + 60000,
        attempts: (job.attempts ?? 0) + 1,
        replayGeneration: generation,
        sourceVersion: token.updatedAt ?? null,
      });
      return { job, lease, generation };
    });
  const generation = store.generation();
  if (expectedGeneration != null && generation !== expectedGeneration) return null;
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const job = store.get("metadata_job", token.id) ?? { attempts: 0 };
    if ((job.leaseUntil ?? 0) > now) {
      store.db.exec("ROLLBACK");
      return null;
    }
    const lease = randomUUID();
    store.put("metadata_job", token.id, {
      ...job,
      state: "running",
      lease,
      leaseUntil: now + 60000,
      attempts: (job.attempts ?? 0) + 1,
      replayGeneration: generation,
      sourceVersion: token.updatedAt ?? null,
    });
    store.db.exec("COMMIT");
    return { job, lease, generation };
  } catch (e) {
    store.db.exec("ROLLBACK");
    throw e;
  }
}
export async function completeMetadataJob(store, token, claim, patch) {
  if (store.dialect === "postgres")
    return store.transaction(async () => {
      const current = await currentMetadataTarget(store, token),
        job = await store.get("metadata_job", token.id);
      if (
        (await store.generation()) !== claim.generation ||
        !current ||
        !isDeepStrictEqual(current.updatedAt, token.updatedAt) ||
        !(await authorityCurrent(store, claim)) ||
        job?.lease !== claim.lease
      )
        return false;
      await store.putMetadata(token.id, patch);
      await store.put("metadata_job", token.id, {
        state: patch.metadataStatus === "ready" ? "complete" : "failed",
        attempts: (claim.job.attempts ?? 0) + 1,
        leaseUntil: 0,
        nextAttempt: patch.metadataNextAttempt,
        error: patch.metadataError,
        uri: patch.metadataUri ?? null,
        contentHash: patch.metadataHash ?? null,
        replayGeneration: claim.generation,
        sourceVersion: token.updatedAt ?? null,
        sourceAuthority: claim.sourceAuthority ?? null,
      });
      return true;
    });
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const current = currentMetadataTarget(store, token);
    if (
      store.generation() === claim.generation &&
      current &&
      isDeepStrictEqual(current.updatedAt, token.updatedAt) &&
      (!claim.sourceAuthority || isDeepStrictEqual(claim.sourceAuthority,
        metadataAuthorityVersion(store.get("catalog_collection", claim.sourceAuthority.id)))) &&
      store.get("metadata_job", token.id)?.lease === claim.lease
    ) {
      if (token.standard === "ERC1155")
        store.put("token_metadata", token.id, { ...store.get("token_metadata", token.id), ...patch });
      else store.put("token", token.id, { ...current, ...patch });
      store.put("metadata_job", token.id, {
        state: patch.metadataStatus === "ready" ? "complete" : "failed",
        attempts: (claim.job.attempts ?? 0) + 1,
        leaseUntil: 0,
        nextAttempt: patch.metadataNextAttempt,
        error: patch.metadataError,
        uri: patch.metadataUri ?? null,
        contentHash: patch.metadataHash ?? null,
        replayGeneration: claim.generation,
        sourceVersion: token.updatedAt ?? null,
        sourceAuthority: claim.sourceAuthority ?? null,
      });
    }
    store.db.exec("COMMIT");
  } catch (e) {
    store.db.exec("ROLLBACK");
    throw e;
  }
}
