import { marketStatus } from "./status.mjs";
import { createHash } from "node:crypto";
import { address, uint, boundedInteger, ApiError } from "./domain.mjs";
import { collectionKey } from "./collection-catalog.mjs";
const j = (alias, path) => `json_extract(${alias}.body,'$.${path}')`;
function filtersSql(options, params, omit) {
  const clauses = [];
  const filters = options.filters ?? [];
  if (!Array.isArray(filters) || filters.length > 20)
    throw new ApiError("INVALID_FILTER", "At most 20 trait filters.");
  for (const f of filters) {
    if (typeof f.name !== "string" || !f.name || f.name.length > 100)
      throw new ApiError("INVALID_FILTER", "Invalid trait name.");
    if (f.name === omit) continue;
    const sub = ["json_extract(a.value,'$.name')=?"];
    params.push(f.name);
    if (f.values !== undefined) {
      if (!Array.isArray(f.values) || !f.values.length || f.values.length > 50)
        throw new ApiError("INVALID_FILTER", "Invalid values.");
      sub.push(
        "json_extract(a.value,'$.value') IN (SELECT value FROM json_each(?))",
      );
      params.push(JSON.stringify(f.values));
    }
    for (const [key, op] of [
      ["min", ">="],
      ["max", "<="],
    ])
      if (f[key] != null) {
        if (!Number.isFinite(f[key]))
          throw new ApiError("INVALID_FILTER", "Invalid range.");
        sub.push(
          `json_type(a.value,'$.value') IN ('integer','real') AND json_extract(a.value,'$.value') ${op} ?`,
        );
        params.push(f[key]);
      }
    clauses.push(
      `EXISTS (SELECT 1 FROM json_each(t.body,'$.attributes') a WHERE ${sub.join(" AND ")})`,
    );
  }
  return clauses;
}
function scopeHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function decodeCursor(cursor, scope, generation) {
  if (!cursor) return null;
  if (cursor.length > 2048)
    throw new ApiError("CURSOR_MISMATCH", "Invalid cursor.");
  let x;
  try {
    x = JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    throw new ApiError("CURSOR_MISMATCH", "Invalid cursor.");
  }
  if (
    x.scope !== scope ||
    x.generation !== generation ||
    typeof x.id !== "string" ||
    !["blob", "number", "string", "null"].includes(x.type)
  )
    throw new ApiError(
      "CURSOR_MISMATCH",
      "Cursor belongs to another query or index generation.",
    );
  if (x.type === "blob") {
    if (typeof x.value !== "string" || !/^[\da-f]{64}$/.test(x.value))
      throw new ApiError("CURSOR_MISMATCH", "Invalid cursor value.");
    x.value = Buffer.from(x.value, "hex");
  }
  if (x.type === "number" && !Number.isFinite(x.value))
    throw new ApiError("CURSOR_MISMATCH", "Invalid cursor value.");
  return x;
}
export class Catalog {
  constructor(store, config) {
    this.store = store;
    this.config = config;
  }
  assertVisible(collection) {
    if (
      this.store.app
        .prepare("SELECT 1 FROM moderation WHERE collection=?")
        .get(address(collection))
    )
      throw new ApiError(
        "CONTENT_RESTRICTED",
        "Collection is restricted pending review.",
        404,
      );
  }
  page(sql, params, { limit, cursor, scope, descending = false }) {
    const count = boundedInteger(limit),
      generation = this.store.generation();
    const hash = scopeHash(scope),
      c = decodeCursor(cursor, hash, generation);
    const extra = [];
    let where = "";
    if (c) {
      where = `WHERE (sort_value IS NULL AND ? IS NOT NULL) OR sort_value ${descending ? "<" : ">"} ? OR (sort_value IS ? AND id>?)`;
      extra.push(c.value, c.value, c.value, c.id);
    }
    const rows = this.store.db
      .prepare(
        `SELECT * FROM (${sql}) ${where} ORDER BY sort_value IS NULL,sort_value ${descending ? "DESC" : "ASC"},id ASC LIMIT ?`,
      )
      .all(...params, ...extra, count + 1);
    const more = rows.length > count;
    if (more) rows.pop();
    const last = rows.at(-1);
    let nextCursor = null;
    if (more && last) {
      const v = last.sort_value,
        type = v == null ? "null" : v instanceof Uint8Array ? "blob" : typeof v;
      nextCursor = Buffer.from(
        JSON.stringify({
          scope: hash,
          generation,
          id: last.id,
          type,
          value: type === "blob" ? Buffer.from(v).toString("hex") : v,
        }),
      ).toString("base64url");
    }
    return {
      items: rows.map((row) => ({
        ...JSON.parse(row.body),
        ...(row.best ? { bestListing: JSON.parse(row.best) } : {}),
      })),
      nextCursor,
    };
  }
  tokenWhere(collection, options = {}, omit) {
    if (collection) this.assertVisible(collection);
    const params = [],
      clauses = ["t.kind='token'", `COALESCE(${j("t", "burned")},0)=0`];
    const hidden = this.store.app
      .prepare("SELECT collection FROM moderation")
      .all()
      .map((r) => r.collection);
    if (hidden.length) {
      clauses.push(
        `${j("t", "collection")} NOT IN (SELECT value FROM json_each(?))`,
      );
      params.push(JSON.stringify(hidden));
    }
    if (collection) {
      clauses.push(`${j("t", "collection")}=?`);
      params.push(address(collection));
    }
    if (options.collections) {
      if (
        !Array.isArray(options.collections) ||
        options.collections.length > 100
      )
        throw new ApiError("INVALID_QUERY", "At most 100 collections.");
      clauses.push(
        `${j("t", "collection")} IN (SELECT value FROM json_each(?))`,
      );
      params.push(JSON.stringify(options.collections.map(address)));
    }
    if (options.owner) {
      clauses.push(`${j("t", "owner")}=?`);
      params.push(address(options.owner));
    }
    if (options.tokenIds) {
      const ids = options.tokenIds;
      if (!Array.isArray(ids) || ids.length > 100)
        throw new ApiError("INVALID_QUERY", "Invalid token IDs.");
      clauses.push(`${j("t", "tokenId")} IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(ids.map((v) => uint(v))));
    }
    if (options.q) {
      if (options.q.length > 100)
        throw new ApiError("INVALID_QUERY", "Search too long.");
      clauses.push(
        `(lower(COALESCE(${j("t", "metadata.name")},'')) LIKE ? OR ${j("t", "tokenId")}=?)`,
      );
      params.push(`%${options.q.toLowerCase()}%`, options.q);
    }
    clauses.push(...filtersSql(options, params, omit));
    return { params, clauses };
  }
  tokens(collection, options = {}) {
    const { params, clauses } = this.tokenWhere(collection, options);
    const sort = options.sort ?? "token-asc";
    let expr = "t.num_key";
    const prefix = [];
    const listingWhere = `o.kind='order' AND ${j("o", "kind")}='listing' AND ${j("o", "state")}='open' AND CAST(${j("o", "expiry")} AS INTEGER)>? AND ${j("o", "collection")}=${j("t", "collection")} AND ${j("o", "tokenId")}=${j("t", "tokenId")} AND ${j("o", "maker")}=${j("t", "owner")}`;
    const currency = options.currency ? address(options.currency) : null;
    const sub = `SELECT o.body FROM entities o WHERE ${listingWhere}${currency ? ` AND ${j("o", "currency")}=?` : ""} ORDER BY o.num_key,o.id LIMIT 1`;
    const now = Math.floor(Date.now() / 1000);
    const subParams = [now, ...(currency ? [currency] : [])];
    if (sort.startsWith("price")) {
      if (!currency)
        throw new ApiError(
          "CURRENCY_REQUIRED",
          "Select a currency for price sorting.",
        );
      expr = `(SELECT o.num_key FROM entities o WHERE ${listingWhere} AND ${j("o", "currency")}=? ORDER BY o.num_key,o.id LIMIT 1)`;
      prefix.push(...subParams);
    } else if (sort === "recent") expr = j("t", "firstSeenBlock");
    else if (/^(power|level|health|resource-count)-(asc|desc)$/.test(sort)) {
      if (sort.startsWith("resource-count"))
        expr = `${j("t", "resourceCount")}`;
      else {
        expr =
          "(SELECT json_extract(a.value,'$.value') FROM json_each(t.body,'$.attributes') a WHERE lower(json_extract(a.value,'$.name'))=? AND json_type(a.value,'$.value') IN ('integer','real') LIMIT 1)";
        prefix.push(sort.split("-")[0]);
      }
    } else if (!["token-asc", "token-desc"].includes(sort))
      throw new ApiError("INVALID_SORT", "Unsupported sort.");
    if (options.listedOnly === true || options.listedOnly === "true") {
      clauses.push(`EXISTS (${sub})`);
      params.push(...subParams);
    }
    const sql = `SELECT t.id,t.body,${expr} AS sort_value,(${sub}) AS best FROM entities t WHERE ${clauses.join(" AND ")}`;
    const scope = {
      resource: "tokens",
      collection,
      owner: options.owner,
      collections: options.collections,
      listedOnly: options.listedOnly,
      sort,
      currency,
      filters: options.filters,
      q: options.q,
      tokenIds: options.tokenIds,
    };
    const page = this.page(sql, [...prefix, ...subParams, ...params], {
      ...options,
      scope,
      descending: sort.endsWith("desc") || sort === "recent",
    });
    // Token holdings are always backed by indexed supported collections;
    // chain-wide claims live under discoveredCollections / operator catalog.
    return { ...page, basis: "indexed" };
  }
  token(collection, id) {
    this.assertVisible(collection);
    const row = this.store.get("token", `${address(collection)}:${uint(id)}`);
    if (!row) throw new ApiError("NOT_FOUND", "Token not indexed.", 404);
    return {
      ...row,
      listings: this.orders(collection, {
        tokenId: id,
        kind: "listing",
        state: "open",
      }).items,
    };
  }
  holdings(account, options = {}) {
    return this.tokens(options.collection, { ...options, owner: account });
  }
  orders(collection, options = {}) {
    if (collection) this.assertVisible(collection);
    const params = [],
      clauses = ["o.kind='order'"];
    for (const [key, value] of Object.entries({
      collection: collection ? address(collection) : undefined,
      tokenId: options.tokenId != null ? uint(options.tokenId) : undefined,
      currency: options.currency ? address(options.currency) : undefined,
      kind: options.kind === "offer" ? undefined : options.kind,
      maker: options.maker ? address(options.maker) : undefined,
    }))
      if (value != null) {
        clauses.push(`${j("o", key)}=?`);
        params.push(value);
      }
    if (options.tokenMatch != null) {
      clauses.push(
        `(${j("o", "kind")}='collection_offer' OR ${j("o", "tokenId")}=?)`,
      );
      params.push(uint(options.tokenMatch));
    }
    if (options.kind === "offer") {
      clauses.push(`${j("o", "kind")} IN ('token_offer','collection_offer')`);
    }
    const now = Math.floor(Date.now() / 1000);
    if (options.state === "expired") {
      clauses.push(
        `${j("o", "state")}='open' AND CAST(${j("o", "expiry")} AS INTEGER)<=?`,
      );
      params.push(now);
    } else if (options.state) {
      clauses.push(`${j("o", "state")}=?`);
      params.push(options.state);
      if (options.state === "open") {
        clauses.push(`CAST(${j("o", "expiry")} AS INTEGER)>?`);
        params.push(now);
      }
    }
    if (options.availableOnly) {
      clauses.push(
        `EXISTS(SELECT 1 FROM entities t WHERE t.kind='token' AND ${j("t", "collection")}=${j("o", "collection")} AND ${j("t", "tokenId")}=${j("o", "tokenId")} AND ${j("t", "owner")}=${j("o", "maker")})`,
      );
    }
    if (options.received) {
      const a = address(options.received);
      clauses.push(
        `${j("o", "kind")} IN ('token_offer','collection_offer') AND EXISTS(SELECT 1 FROM entities t WHERE t.kind='token' AND ${j("t", "owner")}=? AND ${j("t", "collection")}=${j("o", "collection")} AND (${j("o", "kind")}='collection_offer' OR ${j("t", "tokenId")}=${j("o", "tokenId")}))`,
      );
      params.push(a);
    }
    const page = this.page(
      `SELECT o.id,o.body,o.num_key AS sort_value FROM entities o WHERE ${clauses.join(" AND ")}`,
      params,
      {
        ...options,
        scope: {
          resource: "orders",
          collection,
          ...options,
          cursor: undefined,
          limit: undefined,
        },
        descending: options.kind !== "listing",
      },
    );
    page.items = page.items.map((o) => {
      const token = this.store.get("token", `${o.collection}:${o.tokenId}`);
      return {
        ...o,
        availability:
          o.state !== "open"
            ? o.state
            : BigInt(o.expiry) <= BigInt(now)
              ? "expired"
              : o.kind !== "listing"
                ? "funding_unchecked"
                : token?.owner !== o.maker
                  ? "transferred"
                  : "approval_unchecked",
      };
    });
    return page;
  }
  traits(collection, options = {}) {
    const { params, clauses } = this.tokenWhere(
      collection,
      options,
      options.traitName,
    );
    if (options.traitName) {
      clauses.push("json_extract(a.value,'$.name')=?");
      params.push(options.traitName);
    }
    const rows = this.store.db
      .prepare(
        `SELECT json_extract(a.value,'$.name') AS name,json_extract(a.value,'$.value') AS value,json_type(a.value,'$.value') AS type,COUNT(DISTINCT t.id) AS count FROM entities t,json_each(t.body,'$.attributes') a WHERE ${clauses.join(" AND ")} GROUP BY name,value,type ORDER BY name,count DESC,value LIMIT 1000`,
      )
      .all(...params);
    const groups = new Map();
    for (const r of rows) {
      const g = groups.get(r.name) ?? {
        name: r.name,
        kind: ["integer", "real"].includes(r.type)
          ? "number"
          : ["true", "false"].includes(r.type)
            ? "boolean"
            : "string",
        values: [],
      };
      g.values.push({
        value: r.type === "true" ? true : r.type === "false" ? false : r.value,
        count: String(r.count),
      });
      groups.set(r.name, g);
    }
    return [...groups.values()];
  }
  collections() {
    return this.store
      .list("collection")
      .filter(
        (c) =>
          !this.store.app
            .prepare("SELECT body FROM moderation WHERE collection=?")
            .get(c.address),
      )
      .map((c) => this.collection(c.address));
  }
  collection(raw) {
    this.assertVisible(raw);
    const a = address(raw),
      c = this.store.get("collection", a);
    if (!c) throw new ApiError("NOT_FOUND", "Collection not registered.", 404);
    const tokens = this.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM entities WHERE kind='token' AND json_extract(body,'$.collection')=? AND COALESCE(json_extract(body,'$.burned'),0)=0",
      )
      .get(a).count;
    const floors = [];
    let listingCount = 0;
    for (const currency of this.config.currencies ?? []) {
      const active = this.store.db
        .prepare(
          `SELECT o.body FROM entities o JOIN entities t ON t.kind='token' AND ${j("t", "collection")}=${j("o", "collection")} AND ${j("t", "tokenId")}=${j("o", "tokenId")} AND ${j("t", "owner")}=${j("o", "maker")} WHERE o.kind='order' AND ${j("o", "kind")}='listing' AND ${j("o", "state")}='open' AND ${j("o", "collection")}=? AND ${j("o", "currency")}=? AND CAST(${j("o", "expiry")} AS INTEGER)>? ORDER BY o.num_key LIMIT 1`,
        )
        .get(a, address(currency.address), Math.floor(Date.now() / 1000));
      if (active) {
        const order = JSON.parse(active.body);
        floors.push({
          currency: address(currency.address),
          symbol: currency.symbol,
          price: order.buyerDebit,
        });
      }
    }
    listingCount = this.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM entities WHERE kind='order' AND json_extract(body,'$.kind')='listing' AND json_extract(body,'$.state')='open' AND json_extract(body,'$.collection')=? AND CAST(json_extract(body,'$.expiry') AS INTEGER)>?",
      )
      .get(a, Math.floor(Date.now() / 1000)).count;
    const verification = this.store.app
      .prepare("SELECT value FROM app_meta WHERE key=?")
      .get(`verification:${a}`);
    return {
      ...c,
      ...this.chainState(a),
      verified: verification ? JSON.parse(verification.value).verified : false,
      tokenCount: String(tokens),
      listingCount: String(listingCount),
      floorByCurrency: floors,
    };
  }
  /** Indexed provenance for one collection: live source coverage plus the
   *  chain-derived discovery/classification record. Additive — existing
   *  consumers keep every field they already read. */
  chainState(raw) {
    const a = address(raw);
    const progress = this.store.get("progress", a) ?? null;
    const record = this.config.chainId
      ? (this.store.get(
          "catalog_collection",
          collectionKey(this.config.chainId, a),
        ) ?? null)
      : null;
    return {
      coverage: progress
        ? {
            startBlock: progress.startBlock ?? null,
            block: progress.block,
            hash: progress.hash,
            observedAt: progress.observedAt ?? null,
          }
        : null,
      chain: record
        ? {
            state: record.state,
            standard: record.standard,
            method: record.classification?.method ?? null,
            uncertainty: record.classification?.uncertainty ?? null,
            decoderVersion: record.decoderVersion ?? null,
          }
        : null,
    };
  }
  /** Operator coverage report (#116): every chain record with an explicit
   *  reason for anything unsupported, quarantined or unproven, plus
   *  registered collections that still have no coverage. */
  coverage() {
    const records = this.store.list("catalog_collection");
    const entries = records.map((record) => {
      const evidence = record.classification?.evidence;
      const reason =
        record.state === "unsupported"
          ? (evidence?.reason ??
            record.classification?.uncertainty ??
            "unsupported contract type")
          : record.state === "failed"
            ? (record.quarantine?.last?.message ??
              record.classification?.uncertainty ??
              "classification failed")
            : null;
      return {
        address: record.address,
        state: record.state,
        standard: record.standard ?? null,
        method: record.classification?.method ?? null,
        reason,
        quarantine: record.quarantine
          ? {
              observations: record.quarantine.observations,
              last: record.quarantine.last,
            }
          : null,
        ...(record.gaps?.length ? { gaps: record.gaps } : {}),
      };
    });
    const notIndexed = (this.config.collections ?? [])
      .map((c) => ({
        address: address(c.address),
        startBlock: c.startBlock ?? null,
      }))
      .filter((c) => this.store.get("progress", c.address)?.block == null);
    const counts = {};
    for (const entry of entries)
      counts[entry.state] = (counts[entry.state] ?? 0) + 1;
    return {
      counts,
      unsupported: entries.filter((entry) => entry.state === "unsupported"),
      quarantined: entries.filter((entry) => entry.quarantine),
      notIndexed,
      records: entries,
    };
  }
  /** Chain-scope (full-chain) discovery results, clearly labeled so search
   *  consumers never mistake them for indexed holdings. */
  discoveredCollections(q) {
    const needle = typeof q === "string" ? q.trim().toLowerCase() : "";
    return this.store
      .list("catalog_collection")
      .filter((record) => record.standard === "ERC721")
      .filter(
        (record) =>
          !needle ||
          String(record.address).toLowerCase().includes(needle) ||
          String(record.classification?.name ?? "")
            .toLowerCase()
            .includes(needle),
      )
      .slice(0, 20)
      .map((record) => ({
        address: record.address,
        state: record.state,
        standard: record.standard,
        method: record.classification?.method ?? null,
        basis: "chain",
      }));
  }
  activity(options = {}) {
    const params = [],
      where = ["a.kind='activity'"];
    for (const key of ["collection", "tokenId", "type"])
      if (options[key] != null) {
        where.push(`${j("a", key)}=?`);
        params.push(
          key === "collection" ? address(options[key]) : String(options[key]),
        );
      }
    if (options.account) {
      const a = address(options.account);
      where.push(
        `(${j("a", "maker")}=? OR ${j("a", "buyer")}=? OR ${j("a", "seller")}=? OR ${j("a", "from")}=? OR ${j("a", "to")}=?)`,
      );
      params.push(a, a, a, a, a);
    }
    return this.page(
      `SELECT a.id,a.body,${j("a", "provenance.blockNumber")} AS sort_value FROM entities a WHERE ${where.join(" AND ")}`,
      params,
      {
        ...options,
        scope: {
          resource: "activity",
          ...options,
          cursor: undefined,
          limit: undefined,
        },
        descending: true,
      },
    );
  }
  search(q) {
    if (typeof q !== "string" || q.length < 1 || q.length > 100)
      throw new ApiError("INVALID_QUERY", "Search needs 1–100 characters.");
    return {
      collections: this.collections()
        .filter(
          (c) =>
            c.name.toLowerCase().includes(q.toLowerCase()) ||
            c.address.endsWith(q.replace(/^0x/, "")),
        )
        .slice(0, 20),
      tokens: this.tokens(null, { q, limit: 20 }).items,
      discoveredCollections: this.discoveredCollections(q),
    };
  }
  stats(collection, { currency, days = 7 } = {}) {
    const a = address(collection),
      c = currency ? address(currency) : null,
      period = boundedInteger(days, 7, 365),
      since = Math.floor(Date.now() / 86400000) * 86400 - (period - 1) * 86400;
    const rows = this.store.db
      .prepare(
        `SELECT body FROM entities WHERE kind='stats_day' AND json_extract(body,'$.collection')=? AND json_extract(body,'$.day')>=?${c ? " AND json_extract(body,'$.currency')=?" : ""}`,
      )
      .all(a, since, ...(c ? [c] : []));
    const groups = new Map();
    for (const row of rows) {
      const x = JSON.parse(row.body),
        g = groups.get(x.currency) ?? {
          currency: x.currency,
          volume: "0",
          sales: 0,
          history: [],
        };
      g.volume = (BigInt(g.volume) + BigInt(x.volume)).toString();
      g.sales += x.sales;
      groups.set(x.currency, g);
    }
    const history = this.store.db
      .prepare(
        `SELECT body FROM entities WHERE kind='activity' AND json_extract(body,'$.type')='order_filled' AND json_extract(body,'$.collection')=? AND json_extract(body,'$.provenance.timestamp')>=?${c ? " AND json_extract(body,'$.currency')=?" : ""} ORDER BY json_extract(body,'$.provenance.timestamp') DESC,id DESC LIMIT 200`,
      )
      .all(a, since, ...(c ? [c] : []))
      .reverse();
    for (const row of history) {
      const x = JSON.parse(row.body),
        g = groups.get(x.currency);
      if (g)
        g.history.push({
          timestamp: x.provenance.timestamp,
          price: x.buyerDebit,
          tokenId: x.tokenId,
        });
    }
    const floorHistory = this.store.db
      .prepare(
        `SELECT body FROM entities WHERE kind='floor_history' AND json_extract(body,'$.collection')=? AND json_extract(body,'$.timestamp')>=?${c ? " AND json_extract(body,'$.currency')=?" : ""} ORDER BY json_extract(body,'$.timestamp') DESC LIMIT 1000`,
      )
      .all(a, since, ...(c ? [c] : []))
      .reverse()
      .map((row) => JSON.parse(row.body));
    return {
      venue: "biblio",
      days: period,
      periodStart: since,
      periodEnd: Math.floor(Date.now() / 1000),
      periodBasis: "UTC calendar days including today",
      byCurrency: [...groups.values()],
      floors: this.collection(a).floorByCurrency,
      floorHistory,
      historyLimit: 200,
    };
  }
  status() {
    const head = this.store.head(),
      rpc = this.store.get("status", "rpc"),
      cfg = this.store.get("config", "marketplace");
    const required = [
      ...(this.config.collections ?? []).map((c) => address(c.address)),
      ...(this.config.marketplace ? [address(this.config.marketplace)] : []),
    ];
    const progress = required.map((source) =>
      this.store.get("progress", source),
    );
    return marketStatus(this.config, {
      head,
      rpc,
      cfg,
      progress,
      generation: this.store.generation(),
    });
  }
}
