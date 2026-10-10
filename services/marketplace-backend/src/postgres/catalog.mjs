import { createHash } from "node:crypto";
import { address, uint, boundedInteger, ApiError } from "../domain.mjs";
import { marketStatus } from "../status.mjs";
import { collectionKey } from "../collection-catalog.mjs";
import { publicChainState } from "../catalog-state.mjs";
const tokenBody =
  "t.body || jsonb_build_object('metadata','{}'::jsonb,'attributes','[]'::jsonb) || COALESCE(m.body,'{}'::jsonb)";
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
const scopeHash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const parameters = () => {
  const values = [];
  return {
    values,
    bind: (value) => {
      values.push(value);
      return "$" + values.length;
    },
  };
};
export class PgCatalog {
  constructor(store, config) {
    this.store = store;
    this.config = config;
  }
  async assertVisible(collection) {
    const p = parameters(), a = p.bind(address(collection));
    if (!(await this.store.query(`SELECT ${this.visibilityWhere(a, p)} AS visible`, p.values)).rows[0].visible)
      throw new ApiError(
        "CONTENT_RESTRICTED",
        "Collection is restricted pending review",
        404,
      );
  }
  visibilityWhere(column, p) {
    const chain = p.bind(this.config.chainId ? collectionKey(this.config.chainId, "0").split(":")[0] : null),
      configured = p.bind((this.config.collections ?? []).map((c) => address(c.address)));
    return `(NOT EXISTS(SELECT 1 FROM app.moderation h WHERE h.collection=${column}) AND
      COALESCE((SELECT CASE WHEN jsonb_typeof(v.value->'visible')='boolean' THEN (v.value->>'visible')::boolean END
        FROM app.app_meta v WHERE v.key='catalog_visibility:' || ${chain} || ':' || ${column}),
        ${column}=ANY(${configured}::text[]) OR (EXISTS(SELECT 1 FROM market.collections registered WHERE registered.id=${column})
          AND NOT EXISTS(SELECT 1 FROM chain.collection_catalog discovered WHERE discovered.address=${column}
            AND (${chain}::text IS NULL OR discovered.chain_id=${chain})))))`;
  }
  standardWhere(column, p, standard) {
    const chain = p.bind(this.config.chainId ? collectionKey(this.config.chainId, "0").split(":")[0] : null),
      expected = p.bind(standard);
    return `NOT EXISTS(SELECT 1 FROM chain.collection_catalog current_source
      WHERE current_source.address=${column} AND current_source.chain_id=${chain}
      AND current_source.standard IN ('ERC721','ERC1155') AND current_source.standard<>${expected})`;
  }
  async withSources(page, collection) {
    const addresses = [...new Set([
      ...(collection ? [address(collection)] : []),
      ...page.items.map((item) => item.collection),
    ])].slice(0, 100);
    const sources = await Promise.all(addresses.map(async (a) => ({ collection: a, ...await this.chainState(a) })));
    return { ...page, sourceScope: "page", sources };
  }
  async page(
    sql,
    values,
    { limit, cursor, scope, descending = false, sortType = "numeric" },
  ) {
    const count = boundedInteger(limit),
      generation = await this.store.generation(),
      hash = scopeHash(scope);
    let where = "";
    if (cursor) {
      let c;
      try {
        if (cursor.length > 2048) throw new Error();
        c = JSON.parse(Buffer.from(cursor, "base64url").toString());
      } catch {
        throw new ApiError("CURSOR_MISMATCH", "Invalid cursor");
      }
      if (
        c.scope !== hash ||
        c.generation !== generation ||
        typeof c.id !== "string" ||
        c.type !== sortType ||
        (c.value !== null && typeof c.value !== "string") ||
        (sortType === "numeric" &&
          c.value !== null &&
          !/^-?\d+(?:\.\d+)?$/.test(c.value))
      )
        throw new ApiError(
          "CURSOR_MISMATCH",
          "Cursor belongs to another query or index generation",
        );
      values = [...values, c.value, c.id];
      const value =
          "$" +
          (values.length - 1) +
          "::" +
          (sortType === "numeric" ? "numeric" : "text"),
        id = "$" + values.length;
      where = `WHERE (sort_value IS NULL AND ${value} IS NOT NULL) OR sort_value ${descending ? "<" : ">"} ${value} OR (sort_value IS NOT DISTINCT FROM ${value} AND id>${id})`;
    }
    const rows = (
      await this.store.query(
        `SELECT * FROM (${sql}) page ${where} ORDER BY sort_value ${descending ? "DESC" : "ASC"} NULLS LAST,id ASC LIMIT $${values.length + 1}`,
        [...values, count + 1],
      )
    ).rows;
    const more = rows.length > count;
    if (more) rows.pop();
    const last = rows.at(-1);
    return {
      items: rows.map((r) => ({
        ...r.body,
        ...(r.best ? { bestListing: r.best } : {}),
      })),
      nextCursor: more
        ? Buffer.from(
            JSON.stringify({
              scope: hash,
              generation,
              type: sortType,
              value: last.sort_value == null ? null : String(last.sort_value),
              id: last.id,
            }),
          ).toString("base64url")
        : null,
      basis: "indexed",
      generation,
    };
  }
  async tokenWhere(collection, o = {}, omit) {
    if (collection) await this.assertVisible(collection);
    const p = parameters(),
      clauses = [
        "NOT t.burned",
        this.visibilityWhere("t.collection", p),
        this.standardWhere("t.collection", p, "ERC721"),
      ];
    if (collection) clauses.push(`t.collection=${p.bind(address(collection))}`);
    if (o.collections) {
      if (!Array.isArray(o.collections) || o.collections.length > 100)
        throw new ApiError("INVALID_QUERY", "At most 100 collections");
      clauses.push(
        `t.collection=ANY(${p.bind(o.collections.map(address))}::text[])`,
      );
    }
    if (o.owner) clauses.push(`t.owner=${p.bind(address(o.owner))}`);
    if (o.tokenIds) {
      if (!Array.isArray(o.tokenIds) || o.tokenIds.length > 100)
        throw new ApiError("INVALID_QUERY", "Invalid token IDs");
      clauses.push(
        `t.token_id=ANY(${p.bind(o.tokenIds.map((v) => uint(v)))}::numeric[])`,
      );
    }
    if (o.q) {
      if (o.q.length > 100)
        throw new ApiError("INVALID_QUERY", "Search too long");
      clauses.push(
        `((m.body->'metadata'->>'name') ILIKE ${p.bind("%" + o.q + "%")} OR t.body->>'tokenId'=${p.bind(o.q)})`,
      );
    }
    const filters = o.filters ?? [];
    if (!Array.isArray(filters) || filters.length > 20)
      throw new ApiError("INVALID_FILTER", "At most 20 trait filters");
    for (const f of filters) {
      if (typeof f.name !== "string" || !f.name || f.name.length > 100)
        throw new ApiError("INVALID_FILTER", "Invalid trait name");
      if (f.name === omit) continue;
      const sub = [`a.token_id=t.id`, `a.name=${p.bind(f.name)}`];
      if (f.values !== undefined) {
        if (
          !Array.isArray(f.values) ||
          !f.values.length ||
          f.values.length > 50
        )
          throw new ApiError("INVALID_FILTER", "Invalid values");
        sub.push(
          `a.value IN (SELECT value FROM jsonb_array_elements(${p.bind(JSON.stringify(f.values))}::jsonb))`,
        );
      }
      for (const [key, op] of [
        ["min", ">="],
        ["max", "<="],
      ])
        if (f[key] != null) {
          if (!Number.isFinite(f[key]))
            throw new ApiError("INVALID_FILTER", "Invalid range");
          sub.push(`a.numeric_value ${op} ${p.bind(f[key])}`);
        }
      clauses.push(
        `EXISTS(SELECT 1 FROM market.attributes a WHERE ${sub.join(" AND ")})`,
      );
    }
    return { ...p, clauses };
  }
  async tokens(collection, o = {}) {
    const p = await this.tokenWhere(collection, o),
      sort = o.sort ?? "token-asc";
    let expr = "t.token_id";
    const currency = o.currency ? address(o.currency) : null;
    const listing = `o.kind='listing' AND o.state='open' AND o.expiry>${p.bind(Math.floor(Date.now() / 1000))} AND o.collection=t.collection AND o.token_id=t.token_id AND o.maker=t.owner${currency ? " AND o.currency=" + p.bind(currency) : ""}`;
    if (sort.startsWith("price")) {
      if (!currency)
        throw new ApiError(
          "CURRENCY_REQUIRED",
          "Select a currency for price sorting",
        );
      expr = "best.price";
    } else if (sort === "recent") expr = "t.first_seen_block";
    else if (/^(power|level|health|resource-count)-(asc|desc)$/.test(sort)) {
      expr = sort.startsWith("resource-count")
        ? "(m.body->>'resourceCount')::numeric"
        : `(SELECT a.numeric_value FROM market.attributes a WHERE a.token_id=t.id AND lower(a.name)=${p.bind(sort.split("-")[0])} AND a.numeric_value IS NOT NULL ORDER BY a.numeric_value LIMIT 1)`;
    } else if (!["token-asc", "token-desc"].includes(sort))
      throw new ApiError("INVALID_SORT", "Unsupported sort");
    if (o.listedOnly === true || o.listedOnly === "true")
      p.clauses.push("best.body IS NOT NULL");
    const page = await this.page(
      `SELECT t.id,${tokenBody} AS body,${expr} AS sort_value,best.body AS best FROM market.tokens t LEFT JOIN market.token_metadata m ON m.id=t.id LEFT JOIN LATERAL(SELECT o.body,o.buyer_debit AS price FROM market.orders o WHERE ${listing} ORDER BY o.buyer_debit,o.id LIMIT 1) best ON true WHERE ${p.clauses.join(" AND ")}`,
      p.values,
      {
        ...o,
        scope: {
          resource: "tokens",
          collection,
          ...o,
          cursor: undefined,
          limit: undefined,
        },
        descending: sort.endsWith("desc") || sort === "recent",
      },
    );
    return this.withSources(page, collection);
  }
  async token(collection, id) {
    await this.assertVisible(collection);
    const record = this.config.chainId
      ? await this.store.get("catalog_collection", collectionKey(this.config.chainId, collection)) : null;
    if (record?.standard === "ERC1155")
      throw new ApiError("NOT_FOUND", "ERC721 token not indexed", 404);
    const row = await this.store.get(
      "token",
      `${address(collection)}:${uint(id)}`,
    );
    if (!row) throw new ApiError("NOT_FOUND", "Token not indexed", 404);
    return {
      ...row,
      ...await this.chainState(collection),
      listings: (
        await this.orders(collection, {
          tokenId: id,
          kind: "listing",
          state: "open",
          limit: 100,
        })
      ).items,
    };
  }
  holdings(account, o = {}) {
    return this.tokens(o.collection, { ...o, owner: account });
  }
  async balances(account, o = {}) {
    if (o.collection) await this.assertVisible(o.collection);
    if (o.sort && o.sort !== "token-asc" && o.sort !== "token-desc")
      throw new ApiError("INVALID_QUERY", "Balances support token-asc or token-desc");
    const p = parameters(), where = ["b.balance>0", `b.owner=${p.bind(address(account))}`,
      this.visibilityWhere("b.collection", p), this.standardWhere("b.collection", p, "ERC1155")];
    if (o.collection) where.push(`b.collection=${p.bind(address(o.collection))}`);
    if (o.collections) {
      if (!Array.isArray(o.collections) || o.collections.length > 100)
        throw new ApiError("INVALID_QUERY", "At most 100 collections");
      where.push(`b.collection=ANY(${p.bind(o.collections.map(address))}::text[])`);
    }
    if (o.tokenIds) {
      if (!Array.isArray(o.tokenIds) || o.tokenIds.length > 100)
        throw new ApiError("INVALID_QUERY", "Invalid token IDs");
      where.push(`b.token_id=ANY(${p.bind(o.tokenIds.map((id) => uint(id)))}::numeric[])`);
    }
    const page = await this.page(`SELECT b.id,b.body || jsonb_build_object('id',b.id,'standard','ERC1155',
      'metadata','{}'::jsonb,'attributes','[]'::jsonb) || COALESCE(m.body,'{}'::jsonb) AS body,
      b.token_id AS sort_value FROM market.erc1155_balances b
      LEFT JOIN market.token_metadata m ON m.id=b.collection || ':' || b.token_id::text WHERE ${where.join(" AND ")}`,
    p.values, { ...o, descending: o.sort === "token-desc", scope: { ...o, resource: "balances", owner: address(account),
      cursor: undefined, limit: undefined } });
    return this.withSources({ ...page, standard: "ERC1155" }, o.collection);
  }
  async orders(collection, o = {}) {
    if (collection) await this.assertVisible(collection);
    const p = parameters(),
      where = [this.visibilityWhere("o.collection", p)];
    for (const [column, value] of Object.entries({
      collection: collection ? address(collection) : undefined,
      token_id: o.tokenId != null ? uint(o.tokenId) : undefined,
      currency: o.currency ? address(o.currency) : undefined,
      kind: o.kind === "offer" ? undefined : o.kind,
      maker: o.maker ? address(o.maker) : undefined,
    }))
      if (value != null) where.push(`o.${column}=${p.bind(value)}`);
    if (o.tokenMatch != null)
      where.push(
        `(o.kind='collection_offer' OR o.token_id=${p.bind(uint(o.tokenMatch))})`,
      );
    if (o.kind === "offer")
      where.push("o.kind IN ('token_offer','collection_offer')");
    const now = Math.floor(Date.now() / 1000);
    if (o.state === "expired")
      where.push(`o.state='open' AND o.expiry<=${p.bind(now)}`);
    else if (o.state) {
      where.push(`o.state=${p.bind(o.state)}`);
      if (o.state === "open") where.push(`o.expiry>${p.bind(now)}`);
    }
    if (o.availableOnly)
      where.push(
        "EXISTS(SELECT 1 FROM market.tokens t WHERE t.collection=o.collection AND t.token_id=o.token_id AND t.owner=o.maker)",
      );
    if (o.received)
      where.push(
        `o.kind IN ('token_offer','collection_offer') AND EXISTS(SELECT 1 FROM market.tokens t WHERE t.owner=${p.bind(address(o.received))} AND t.collection=o.collection AND (o.kind='collection_offer' OR t.token_id=o.token_id))`,
      );
    const page = await this.page(
      `SELECT o.id,o.body,o.buyer_debit AS sort_value FROM market.orders o WHERE ${where.join(" AND ")}`,
      p.values,
      {
        ...o,
        scope: {
          resource: "orders",
          collection,
          ...o,
          cursor: undefined,
          limit: undefined,
        },
        descending: o.kind !== "listing",
      },
    );
    page.items = await Promise.all(
      page.items.map(async (order) => {
        const token = await this.store.get(
          "token",
          `${order.collection}:${order.tokenId}`,
        );
        return {
          ...order,
          availability:
            order.state !== "open"
              ? order.state
              : BigInt(order.expiry) <= BigInt(now)
                ? "expired"
                : order.kind !== "listing"
                  ? "funding_unchecked"
                  : token?.owner !== order.maker
                    ? "transferred"
                    : "approval_unchecked",
        };
      }),
    );
    return page;
  }
  async traits(collection, o = {}) {
    const p = await this.tokenWhere(collection, o, o.traitName);
    if (o.traitName) p.clauses.push(`a.name=${p.bind(o.traitName)}`);
    const rows = (
      await this.store.query(
        `SELECT a.name,a.value,jsonb_typeof(a.value) AS type,COUNT(DISTINCT t.id)::text AS count FROM market.tokens t LEFT JOIN market.token_metadata m ON m.id=t.id JOIN market.attributes a ON a.token_id=t.id WHERE ${p.clauses.join(" AND ")} GROUP BY a.name,a.value ORDER BY a.name,COUNT(DISTINCT t.id) DESC,a.value LIMIT 1000`,
        p.values,
      )
    ).rows;
    const groups = new Map();
    for (const r of rows) {
      const group = groups.get(r.name) ?? {
        name: r.name,
        kind:
          r.type === "number"
            ? "number"
            : r.type === "boolean"
              ? "boolean"
              : "string",
        values: [],
      };
      group.values.push({ value: r.value, count: r.count });
      groups.set(r.name, group);
    }
    return [...groups.values()];
  }
  async collections() {
    const p = parameters(),
      chain = p.bind(this.config.chainId ? collectionKey(this.config.chainId, "0").split(":")[0] : null),
      visible = this.visibilityWhere("c.address", p);
    const rows = (
      await this.store.query(
        `SELECT c.address FROM (SELECT id AS address FROM market.collections UNION
          SELECT address FROM chain.collection_catalog WHERE chain_id=${chain}) c
          WHERE ${visible} ORDER BY c.address LIMIT 1000`, p.values,
      )
    ).rows;
    return Promise.all(rows.map((r) => this.collection(r.address)));
  }
  async collection(raw) {
    const a = address(raw);
    await this.assertVisible(a);
    const saved = await this.store.get("collection", a),
      record = this.config.chainId ? await this.store.get("catalog_collection", collectionKey(this.config.chainId, a)) : null,
      c = saved ?? (record ? { address: a, name: record.classification?.name ?? a } : null);
    if (!c) throw new ApiError("NOT_FOUND", "Collection not indexed", 404);
    const tokenCount = (
      await this.store.query(
        `SELECT COUNT(*)::text AS count FROM (SELECT token_id FROM market.tokens WHERE collection=$1 AND NOT burned
          AND ($2::text IS NULL OR $2='ERC721')
          UNION SELECT token_id FROM market.erc1155_balances WHERE collection=$1 AND balance>0
          AND ($2::text IS NULL OR $2='ERC1155')) observed`,
        [a, ["ERC721", "ERC1155"].includes(record?.standard) ? record.standard : null],
      )
    ).rows[0].count;
    const floors = [];
    const now = Math.floor(Date.now() / 1000);
    for (const currency of this.config.currencies ?? []) {
      const row = (
        await this.store.query(
          "SELECT o.buyer_debit::text AS price FROM market.orders o JOIN market.tokens t ON t.collection=o.collection AND t.token_id=o.token_id AND t.owner=o.maker WHERE o.kind='listing' AND o.state='open' AND o.collection=$1 AND o.currency=$2 AND o.expiry>$3 ORDER BY o.buyer_debit LIMIT 1",
          [a, address(currency.address), now],
        )
      ).rows[0];
      if (row)
        floors.push({
          currency: address(currency.address),
          symbol: currency.symbol,
          price: row.price,
        });
    }
    const listingCount = (
      await this.store.query(
        "SELECT COUNT(*)::text AS count FROM market.orders WHERE kind='listing' AND state='open' AND collection=$1 AND expiry>$2",
        [a, now],
      )
    ).rows[0].count;
    const verification = (
      await this.store.query("SELECT value FROM app.app_meta WHERE key=$1", [
        `verification:${a}`,
      ])
    ).rows[0];
    return {
      ...c,
      ...await this.chainState(a),
      verified: verification?.value?.verified ?? false,
      tokenCount,
      listingCount,
      floorByCurrency: floors,
    };
  }
  async activity(o = {}) {
    if (o.collection) await this.assertVisible(o.collection);
    const p = parameters(),
      where = [this.visibilityWhere("a.collection", p)];
    for (const key of ["collection", "tokenId", "type"])
      if (o[key] != null) {
        const column = {
          collection: "collection",
          tokenId: "token_id",
          type: "type",
        }[key];
        where.push(
          `a.${column}=${p.bind(key === "collection" ? address(o[key]) : String(o[key]))}`,
        );
      }
    if (o.account) {
      const at = p.bind(address(o.account));
      where.push(
        `(a.body->>'maker'=${at} OR a.body->>'buyer'=${at} OR a.body->>'seller'=${at} OR a.body->>'from'=${at} OR a.body->>'to'=${at})`,
      );
    }
    return this.page(
      `SELECT a.id,a.body,a.block_number AS sort_value FROM market.activity a WHERE ${where.join(" AND ")}`,
      p.values,
      {
        ...o,
        scope: {
          resource: "activity",
          ...o,
          cursor: undefined,
          limit: undefined,
        },
        descending: true,
      },
    );
  }
  async search(q) {
    if (typeof q !== "string" || q.length < 1 || q.length > 100)
      throw new ApiError("INVALID_QUERY", "Search needs 1–100 characters");
    return {
      collections: (await this.collections())
        .filter(
          (c) =>
            c.name.toLowerCase().includes(q.toLowerCase()) ||
            c.address.endsWith(q.replace(/^0x/, "")),
        )
        .slice(0, 20),
      tokens: (await this.tokens(null, { q, limit: 20 })).items,
      discoveredCollections: await this.discoveredCollections(q),
    };
  }
  async chainState(raw) {
    const a = address(raw), key = this.config.chainId ? collectionKey(this.config.chainId, a) : null;
    const [record, saved, progress, rpc, generation, reconciliation] = await Promise.all([
      key ? this.store.get("catalog_collection", key) : null,
      key ? this.store.get("source_coverage", key) : null,
      this.store.get("progress", a), this.store.get("status", "rpc"), this.store.generation(),
      this.store.get("status", `reconciliation:${a}`),
    ]);
    const checkpoint = saved?.mode !== "configured_scan" && saved ? saved.block : progress?.block;
    return publicChainState(this.config, a, { record, saved, progress, rpc, generation, reconciliation,
      canonicalHash: checkpoint != null ? (await this.store.canonicalBlock(checkpoint))?.hash : null });
  }
  async discoveredCollections(q) {
    const p = parameters(), chain = p.bind(this.config.chainId ? collectionKey(this.config.chainId, "0").split(":")[0] : null),
      visible = this.visibilityWhere("c.address", p), needle = p.bind(`%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    const rows = (await this.store.query(`SELECT c.body FROM chain.collection_catalog c WHERE c.chain_id=${chain}
      AND c.standard IN ('ERC721','ERC1155') AND ${visible}
      AND (lower(c.address) LIKE ${needle} OR lower(COALESCE(c.body->'classification'->>'name','')) LIKE ${needle})
      ORDER BY c.id LIMIT 20`, p.values)).rows;
    return Promise.all(rows.map(async ({ body: record }) => ({
      address: record.address, state: record.state, standard: record.standard,
      method: record.classification?.method ?? null, ...await this.chainState(record.address), basis: "chain",
    })));
  }
  async coverage() {
    const records = (await this.store.query(`SELECT body FROM chain.collection_catalog
      WHERE chain_id=$1 ORDER BY id LIMIT 1000`,
    [this.config.chainId ? collectionKey(this.config.chainId, "0").split(":")[0] : null])).rows.map((r) => r.body);
    const entries = await Promise.all(records.map(async (record) => ({
      address: record.address, state: record.state, standard: record.standard,
      method: record.classification?.method ?? null,
      reason: record.state === "failed" ? record.quarantine?.last?.message ?? record.classification?.uncertainty ?? "classification failed"
        : record.state === "unsupported" ? record.classification?.evidence?.reason ?? record.classification?.uncertainty ?? "unsupported contract type" : null,
      quarantine: record.quarantine ? { observations: record.quarantine.observations, last: record.quarantine.last } : null,
      ...await this.chainState(record.address),
    })));
    const notIndexed = [];
    for (const c of this.config.collections ?? [])
      if ((await this.store.get("progress", address(c.address)))?.block == null)
        notIndexed.push({ address: address(c.address), startBlock: c.startBlock ?? null });
    const counts = {};
    for (const entry of entries) counts[entry.state] = (counts[entry.state] ?? 0) + 1;
    return { counts, unsupported: entries.filter((e) => e.state === "unsupported"),
      quarantined: entries.filter((e) => e.quarantine), notIndexed, records: entries, truncated: records.length === 1000 };
  }
  async stats(collection, { currency, days = 7 } = {}) {
    const a = address(collection),
      c = currency ? address(currency) : null,
      period = boundedInteger(days, 7, 365),
      since = Math.floor(Date.now() / 86400000) * 86400 - (period - 1) * 86400;
    const rows = (
      await this.store.query(
        `SELECT body FROM market.daily_stats WHERE body->>'collection'=$1 AND (body->>'day')::bigint>=$2${c ? " AND body->>'currency'=$3" : ""}`,
        [a, since, ...(c ? [c] : [])],
      )
    ).rows;
    const groups = new Map();
    for (const { body: x } of rows) {
      const g = groups.get(x.currency) ?? {
        currency: x.currency,
        volume: "0",
        sales: 0,
        history: [],
      };
      g.volume = (BigInt(g.volume) + BigInt(x.volume)).toString();
      g.sales += x.sales;
      groups.set(x.currency, g);
    }
    const history = (
      await this.store.query(
        `SELECT body FROM market.activity WHERE type='order_filled' AND collection=$1 AND timestamp>=$2${c ? " AND currency=$3" : ""} ORDER BY timestamp DESC,id DESC LIMIT 200`,
        [a, since, ...(c ? [c] : [])],
      )
    ).rows.reverse();
    for (const { body: x } of history)
      groups.get(x.currency)?.history.push({
        timestamp: x.provenance.timestamp,
        price: x.buyerDebit,
        tokenId: x.tokenId,
      });
    const floorHistory = (
      await this.store.query(
        `SELECT body FROM market.floor_history WHERE body->>'collection'=$1 AND (body->>'timestamp')::bigint>=$2${c ? " AND body->>'currency'=$3" : ""} ORDER BY (body->>'timestamp')::bigint DESC LIMIT 1000`,
        [a, since, ...(c ? [c] : [])],
      )
    ).rows
      .reverse()
      .map((r) => r.body);
    return {
      venue: "biblio",
      days: period,
      periodStart: since,
      periodEnd: Math.floor(Date.now() / 1000),
      periodBasis: "UTC calendar days including today",
      byCurrency: [...groups.values()],
      floors: (await this.collection(a)).floorByCurrency,
      floorHistory,
      historyLimit: 200,
    };
  }
  async status() {
    const required = [
      ...(this.config.collections ?? []).map((c) => address(c.address)),
      ...(this.config.marketplace ? [address(this.config.marketplace)] : []),
    ];
    let history = await this.store.get("status", "history");
    if (history?.state === "passed") {
      const checkpoint = await this.store.canonicalBlock(
        history.checkpointBlock,
      );
      if (
        !checkpoint ||
        BigInt(checkpoint.hash) !== BigInt(history.checkpointHash)
      )
        history = { ...history, state: "invalid_checkpoint" };
    }
    return marketStatus(this.config, {
      head: await this.store.head(),
      rpc: await this.store.get("status", "rpc"),
      cfg: await this.store.get("config", "marketplace"),
      progress: await Promise.all(
        required.map((source) => this.store.get("progress", source)),
      ),
      generation: await this.store.generation(),
      history,
    });
  }
}
