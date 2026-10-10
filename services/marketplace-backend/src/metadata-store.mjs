import { randomUUID } from "node:crypto";
import { numericKey, MAX_U256 } from "./domain.mjs";
export async function expandMetadataJobs(store) {
  if (store.dialect === "postgres")
    return store.transaction(async () => {
      const row = (
        await store.query(
          "SELECT id,body FROM market.metadata_jobs WHERE body->>'state'='pending' AND id LIKE '%:*' ORDER BY id LIMIT 1",
        )
      ).rows[0];
      if (!row) return;
      const job = row.body;
      const rows = (
        await store.query(
          "SELECT id,token_id::text AS token_id FROM market.tokens WHERE collection=$1 AND token_id>=$2 AND token_id<=$3 AND ($4::numeric IS NULL OR token_id>$4::numeric) ORDER BY token_id LIMIT 100",
          [
            job.collection,
            job.fromTokenId ?? "0",
            job.toTokenId ?? MAX_U256.toString(),
            job.cursor ?? null,
          ],
        )
      ).rows;
      for (const token of rows)
        await store.put("metadata_job", token.id, {
          state: "pending",
          updatedAt: job.updatedAt,
        });
      await store.put("metadata_job", row.id, {
        ...job,
        state: rows.length === 100 ? "pending" : "complete",
        cursor: rows.at(-1)?.token_id ?? job.cursor,
      });
    });
  const rows = store.db
    .prepare(
      "SELECT id,body FROM entities WHERE kind='metadata_job' AND json_extract(body,'$.state')='pending' AND id LIKE '%:*' LIMIT 1",
    )
    .all();
  for (const row of rows) {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const job = JSON.parse(row.body),
        tokens = store.db
          .prepare(
            "SELECT id,body FROM entities WHERE kind='token' AND json_extract(body,'$.collection')=? AND num_key>=? AND num_key<=? AND (? IS NULL OR num_key>?) ORDER BY num_key LIMIT 100",
          )
          .all(
            job.collection,
            numericKey(job.fromTokenId ?? "0"),
            numericKey(job.toTokenId ?? MAX_U256),
            job.cursor ?? null,
            job.cursor ? numericKey(job.cursor) : null,
          );
      for (const token of tokens)
        store.put("metadata_job", token.id, {
          state: "pending",
          updatedAt: job.updatedAt,
        });
      store.put("metadata_job", row.id, {
        ...job,
        state: tokens.length === 100 ? "pending" : "complete",
        cursor: tokens.length
          ? JSON.parse(tokens.at(-1).body).tokenId
          : job.cursor,
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
  const fetchLimit = quota == null ? limit : limit * 3;
  const rows =
    store.dialect === "postgres"
      ? (
          await store.query(
            "SELECT t.body || COALESCE(m.body,'{}'::jsonb) AS body FROM market.tokens t LEFT JOIN market.token_metadata m ON m.id=t.id LEFT JOIN market.metadata_jobs job ON job.id=t.id WHERE NOT t.burned AND COALESCE((job.body->>'leaseUntil')::bigint,0)<$1 AND (COALESCE((m.body->>'metadataNextAttempt')::bigint,0)<$1 OR job.body->>'state'='pending') ORDER BY CASE WHEN job.body->>'state'='pending' THEN 0 ELSE 1 END, CASE WHEN m.body->>'image' IS NULL THEN 0 ELSE 1 END, COALESCE((m.body->>'metadataFetchedAt')::bigint,0),t.id LIMIT $2",
            [now, fetchLimit],
          )
        ).rows.map((r) => r.body)
      : store.db
          .prepare(
            "SELECT t.body FROM entities t LEFT JOIN entities job ON job.kind='metadata_job' AND job.id=t.id WHERE t.kind='token' AND COALESCE(json_extract(t.body,'$.burned'),0)=0 AND COALESCE(json_extract(job.body,'$.leaseUntil'),0)< ? AND (COALESCE(json_extract(t.body,'$.metadataNextAttempt'),0)< ? OR json_extract(job.body,'$.state')='pending') ORDER BY CASE WHEN json_extract(job.body,'$.state')='pending' THEN 0 ELSE 1 END, CASE WHEN json_extract(t.body,'$.image') IS NULL THEN 0 ELSE 1 END, COALESCE(json_extract(t.body,'$.metadataFetchedAt'),0),t.id LIMIT ?",
          )
          .all(now, now, fetchLimit)
          .map((r) => JSON.parse(r.body));
  if (quota == null) return rows;
  const picked = [],
    perCollection = new Map();
  for (const body of rows) {
    const collection =
      body.collection ?? String(body.id ?? "").split(":")[0] ?? "unknown";
    const used = perCollection.get(collection) ?? 0;
    if (used >= quota) continue;
    perCollection.set(collection, used + 1);
    picked.push(body);
    if (picked.length >= limit) break;
  }
  return picked;
}
export async function claimMetadataJob(store, token, now) {
  if (store.dialect === "postgres")
    return store.transaction(async () => {
      const job = (await store.get("metadata_job", token.id)) ?? {
        attempts: 0,
      };
      if ((job.leaseUntil ?? 0) > now) return null;
      const lease = randomUUID(),
        generation = await store.generation();
      await store.put("metadata_job", token.id, {
        ...job,
        state: "running",
        lease,
        leaseUntil: now + 60000,
        attempts: (job.attempts ?? 0) + 1,
      });
      return { job, lease, generation };
    });
  const generation = store.generation();
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
      const current = await store.get("token", token.id),
        job = await store.get("metadata_job", token.id);
      if (
        (await store.generation()) !== claim.generation ||
        !current ||
        current.updatedAt?.blockHash !== token.updatedAt?.blockHash ||
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
      });
      return true;
    });
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const current = store.get("token", token.id);
    if (
      store.generation() === claim.generation &&
      current &&
      current.updatedAt?.blockHash === token.updatedAt?.blockHash &&
      store.get("metadata_job", token.id)?.lease === claim.lease
    ) {
      store.put("token", token.id, { ...current, ...patch });
      store.put("metadata_job", token.id, {
        state: patch.metadataStatus === "ready" ? "complete" : "failed",
        attempts: (claim.job.attempts ?? 0) + 1,
        leaseUntil: 0,
        nextAttempt: patch.metadataNextAttempt,
        error: patch.metadataError,
      });
    }
    store.db.exec("COMMIT");
  } catch (e) {
    store.db.exec("ROLLBACK");
    throw e;
  }
}
