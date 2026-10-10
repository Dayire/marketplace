import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createClientIdentity } from "./client-identity.mjs";
import { bestBid } from "./bids.mjs";
import { createCatalog } from "./catalog-access.mjs";
import { applicationStore } from "./application-store.mjs";
import { Auth } from "./auth.mjs";
import { preflight } from "./preflight.mjs";
import {
  address,
  uint,
  orderKey,
  ApiError,
  fromU256,
  u256Felts,
} from "./domain.mjs";
import { SELECTORS } from "./decode.mjs";
import { PgDiscoveryCatalog } from "./postgres/discovery-catalog.mjs";
function options(params) {
  const o = Object.fromEntries(params);
  for (const k of ["filters", "tokenIds", "collections"])
    if (o[k]) {
      try {
        o[k] = JSON.parse(o[k]);
      } catch {
        throw new ApiError("INVALID_QUERY", `Invalid ${k}.`);
      }
    }
  return o;
}
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536)
      throw new ApiError("BODY_TOO_LARGE", "Maximum body size is 64 KiB.", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new ApiError("INVALID_JSON", "Invalid JSON.");
  }
}
function cookieToken(req) {
  return req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("biblio_session="))
    ?.slice("biblio_session=".length);
}
export function createApi({ store, config, rpc, verifySignature }) {
  const baseStore = store;
  const origin = new URL(config.origin ?? "http://localhost:3000").origin;
  const auth = new Auth(store, {
    origin,
    chainId: config.chainId,
    verify:
      verifySignature ??
      (async (account, hash, signature) => {
        if (!rpc)
          throw new ApiError(
            "RPC_UNAVAILABLE",
            "Wallet verification is unavailable.",
            503,
          );
        const result = await rpc.contract(
          account,
          SELECTORS.is_valid_signature,
          [hash, String(signature.length), ...signature],
        );
        return (
          result.length === 1 && BigInt(result[0]) === BigInt("0x56414c4944")
        );
      }),
  });
  const limits = new Map();
  const clientIdentity = createClientIdentity(config);
  const api = createServer(async (req, res) => {
    let store = baseStore,
      catalog = createCatalog(store, config),
      app = applicationStore(store);
    const requestId = randomUUID();
    let readTransaction = false;
    res.setHeader("X-Request-ID", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const send = (data, status = 200) => {
      res.writeHead(status);
      res.end(JSON.stringify(data));
    };
    try {
      if ((req.url?.length ?? 0) > 8192)
        throw new ApiError("INVALID_QUERY", "URL is too long.", 414);
      if (req.headers.origin && req.headers.origin !== origin)
        throw new ApiError("ORIGIN_MISMATCH", "Origin not allowed.", 403);
      if (req.headers.origin === origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type,Authorization",
        );
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url, "http://localhost");
      if (config.maintenance && req.method === "POST")
        throw new ApiError(
          "MIGRATION_IN_PROGRESS",
          "Marketplace writes are temporarily paused for database migration.",
          503,
        );
      // Deployment probes must not compete with a visitor's quota.
      if (url.pathname === "/health/live") {
        send({ live: true });
        return;
      }
      const now = Date.now(),
        ip = await clientIdentity(req),
        entry = limits.get(ip);
      const bucket =
        entry && entry.expires > now
          ? entry
          : { count: 0, expires: now + 60000 };
      bucket.count++;
      limits.set(ip, bucket);
      if (limits.size > 10000) limits.delete(limits.keys().next().value);
      if (bucket.count > 300)
        throw new ApiError(
          "RATE_LIMITED",
          "Too many requests. Retry shortly.",
          429,
        );
      const parts = url.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      if (url.pathname === "/health/ready") {
        const status = await catalog.status();
        send(status, status.safeForCheckout ? 200 : 503);
        return;
      }
      if (url.pathname === "/rpc" && req.method === "POST") {
        const request = await body(req);
        const methods = new Set([
          "starknet_specVersion",
          "starknet_chainId",
          "starknet_blockNumber",
          "starknet_getBlockWithTxHashes",
          "starknet_getBlockWithTxs",
          "starknet_getTransactionReceipt",
          "starknet_getTransactionStatus",
          "starknet_getTransactionByHash",
          "starknet_getNonce",
          "starknet_call",
          "starknet_estimateFee",
          "starknet_estimateMessageFee",
          "starknet_getClassHashAt",
          "starknet_getClass",
          "starknet_getClassAt",
          "starknet_addInvokeTransaction",
        ]);
        if (
          !request ||
          request.jsonrpc !== "2.0" ||
          !["string", "number"].includes(typeof request.id) ||
          !methods.has(request.method)
        ) {
          send({
            jsonrpc: "2.0",
            id: request?.id ?? null,
            error: { code: -32601, message: "Unsupported wallet RPC method." },
          });
          return;
        }
        try {
          if (!rpc)
            throw new ApiError(
              "RPC_UNAVAILABLE",
              "Wallet RPC is not configured.",
              503,
            );
          const result = await rpc.call(request.method, request.params ?? []);
          send({ jsonrpc: "2.0", id: request.id, result });
        } catch (error) {
          send({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: error.details?.rpcCode ?? -32603,
              message: error.message,
              ...(error.details?.data ? { data: error.details.data } : {}),
            },
          });
        }
        return;
      }
      if (
        parts[0] !== "v1" ||
        parts[1] !== "chains" ||
        parts[2] !== config.chain
      )
        throw new ApiError("INVALID_CHAIN", "Unknown API chain or route.");
      const route = parts.slice(3),
        q = options(url.searchParams),
        token = cookieToken(req),
        account = await auth.account(token);
      if (route[0] === "assets" && req.method === "GET") {
        const name = route[1];
        if (
          (!config.assetDir && store.dialect !== "postgres") ||
          !name ||
          !/^([a-f0-9]{64})\.(png|jpg|gif|webp|svg)$/.test(name)
        )
          throw new ApiError("NOT_FOUND", "Asset unavailable.", 404);
        let bytes;
        try {
          bytes =
            store.dialect === "postgres"
              ? await store.asset(name)
              : await readFile(join(config.assetDir, name));
          if (!bytes) throw new Error("Asset missing");
        } catch {
          throw new ApiError("NOT_FOUND", "Asset unavailable.", 404);
        }
        res.setHeader(
          "Content-Type",
          {
            png: "image/png",
            jpg: "image/jpeg",
            webp: "image/webp",
            gif: "image/gif",
            svg: "image/svg+xml",
          }[name.split(".").at(-1)],
        );
        res.setHeader(
          "Content-Security-Policy",
          "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
        );
        res.setHeader("Cache-Control", "public,max-age=31536000,immutable");
        res.writeHead(200);
        res.end(bytes);
        return;
      }
      const requireAccount = () => {
        if (!account)
          throw new ApiError(
            "UNAUTHENTICATED",
            "Connect and verify your wallet.",
            401,
          );
        return account;
      };
      const operator = () => {
        const supplied =
          req.headers.authorization?.replace(/^Bearer /, "") ?? "";
        const secret = config.operatorToken;
        if (
          !secret ||
          Buffer.byteLength(supplied) !== Buffer.byteLength(secret) ||
          !timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))
        )
          throw new ApiError(
            "FORBIDDEN",
            "Operator credentials required.",
            403,
          );
      };
      const data = req.method === "POST" ? await body(req) : null;
      if (req.method === "GET" && !["quote", "best-bid"].includes(route[3])) {
        store = await baseStore.beginSnapshot();
        catalog = createCatalog(store, config);
        app = applicationStore(store);
        readTransaction = true;
      }
      let result;
      if (req.method === "POST" && token && req.headers.origin !== origin)
        throw new ApiError(
          "ORIGIN_MISMATCH",
          "Authenticated writes require a matching Origin.",
          403,
        );
      if (route[0] === "auth") {
        if (route[1] === "challenge" && req.method === "POST")
          result = await auth.challenge(data.account, data.origin);
        else if (route[1] === "verify" && req.method === "POST") {
          const session = await auth.verify(data.id, data.signature);
          res.setHeader(
            "Set-Cookie",
            `biblio_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${origin.startsWith("https:") ? "; Secure" : ""}`,
          );
          result = { account: session.account, expires: session.expires };
        } else if (route[1] === "session" && req.method === "GET")
          result = { account };
        else if (route[1] === "logout" && req.method === "POST") {
          await auth.logout(token);
          res.setHeader(
            "Set-Cookie",
            "biblio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          );
          result = { loggedOut: true };
        }
      } else if (route[0] === "notifications") {
        const a = requireAccount();
        if (req.method === "GET") result = await store.notifications(a);
        else if (req.method === "POST" && route[1] === "read") {
          if (typeof data.id !== "string")
            throw new ApiError("INVALID_QUERY", "Notification ID required.");
          await app.readNotification(a, data.id);
          result = { updated: true };
        }
      } else if (route[0] === "reports" && req.method === "POST") {
        const a = requireAccount();
        if (
          typeof data.reason !== "string" ||
          data.reason.trim().length < 5 ||
          data.reason.length > 2000
        )
          throw new ApiError(
            "INVALID_REPORT",
            "A reason of 5–2000 characters is required.",
          );
        const collection = address(data.collection);
        await catalog.collection(collection);
        const id = randomUUID();
        await app.createReport(
          id,
          a,
          {
            collection,
            tokenId: data.tokenId == null ? null : uint(data.tokenId),
            reason: data.reason.trim(),
          },
          Date.now(),
        );
        result = { id, status: "open" };
      } else if (route[0] === "operator") {
        operator();
        if (route[1] === "catalog" && req.method === "GET") {
          if (store.dialect !== "postgres")
            throw new ApiError(
              "CATALOG_UNAVAILABLE",
              "Discovery catalog requires PostgreSQL",
              503,
            );
          const discovery = new PgDiscoveryCatalog(store, config);
          if (route[2]) {
            const collection = await discovery.collection(route[2]),
              configured = config.collections?.find(
                (c) => address(c.address) === collection.address,
              );
            result = {
              ...collection,
              readiness: await discovery.readiness([
                {
                  address: collection.address,
                  requiredStartBlock:
                    configured?.startBlock ?? collection.deployment?.block,
                },
              ]),
            };
          } else result = await discovery.list(q);
        } else if (route[1] === "reports" && req.method === "GET")
          result = await app.reports();
        else if (route[1] === "reports" && req.method === "POST") {
          if (!["open", "resolved", "dismissed"].includes(data.status))
            throw new ApiError("INVALID_QUERY", "Invalid report state.");
          await app.updateReport(data.id, data.status);
          result = { updated: true };
        } else if (route[1] === "collections" && req.method === "POST") {
          const collection = address(data.address),
            old = await store.get("collection", collection);
          if (!old)
            throw new ApiError(
              "NOT_REGISTERED",
              "Add contract/start block to registry before publishing.",
              409,
            );
          await app.setCollection(collection, data);
          result = { updated: true };
        }
        if (route[1] === "metadata" && req.method === "POST") {
          const collection = address(data.collection);
          if (!(await store.get("collection", collection)))
            throw new ApiError(
              "NOT_REGISTERED",
              "Collection is not registered.",
            );
          const tokenId = data.tokenId == null ? null : uint(data.tokenId);
          await store.put("metadata_job", `${collection}:${tokenId ?? "*"}`, {
            collection,
            tokenId,
            state: "pending",
            requestedAt: Date.now(),
          });
          result = { queued: true };
        }
        if (route[1] === "coverage" && req.method === "GET")
          result = catalog.coverage();
                if (route[1] === "audit" && req.method === "GET")
          result = await app.audit();
        if (req.method === "POST") await app.recordAudit(route.join("/"), data);
      } else if (
        route[0] === "checkout" &&
        route[1] === "preflight" &&
        req.method === "POST"
      )
        result = await preflight(store, rpc, config, data);
      else if (
        route[0] === "orders" &&
        route[1] === "lookup" &&
        req.method === "POST"
      ) {
        if (
          !Array.isArray(data.orders) ||
          !data.orders.length ||
          data.orders.length > 25
        )
          throw new ApiError("INVALID_QUERY", "Expected 1–25 order keys.");
        result = {
          orders: await Promise.all(
            data.orders.map(async (k) => ({
              key: k,
              order: await store.get(
                "order",
                orderKey(
                  config.chain,
                  config.marketplace ?? "0",
                  k.maker,
                  k.nonce,
                ),
              ),
            })),
          ),
        };
      } else if (req.method === "GET") {
        if (route[0] === "collections") {
          if (!route[1]) result = await catalog.collections();
          else if (!route[2]) result = await catalog.collection(route[1]);
          else if (route[2] === "tokens")
            result = await catalog.tokens(route[1], q);
          else if (route[2] === "traits")
            result = await catalog.traits(route[1], {
              ...q,
              traitName: route[3],
            });
          else if (route[2] === "orders")
            result = await catalog.orders(route[1], q);
          else if (route[2] === "listings")
            result = await catalog.orders(route[1], {
              ...q,
              kind: "listing",
              state: "open",
              availableOnly: true,
            });
          else if (route[2] === "offers")
            result = await catalog.orders(route[1], {
              ...q,
              kind: "offer",
              state: "open",
            });
          else if (route[2] === "stats")
            result = await catalog.stats(route[1], q);
          else if (route[2] === "activity")
            result = await catalog.activity({ ...q, collection: route[1] });
        } else if (route[0] === "tokens" && route[1] && route[2]) {
          if (!route[3]) result = await catalog.token(route[1], route[2]);
          else if (route[3] === "activity")
            result = await catalog.activity({
              ...q,
              collection: route[1],
              tokenId: uint(route[2]),
            });
          else if (route[3] === "best-bid")
            result = await bestBid(store, rpc, config, route[1], route[2], q);
          else if (route[3] === "quote") {
            if (!rpc || !config.marketplace)
              throw new ApiError(
                "NOT_DEPLOYED",
                "Marketplace quote is unavailable.",
                503,
              );
            const values = await rpc.contract(
              config.marketplace,
              SELECTORS.quote_terms,
              [
                address(route[1]),
                ...u256Felts(route[2]),
                ...u256Felts(q.price),
              ],
            );
            if (values.length !== 7)
              throw new ApiError(
                "INVALID_QUOTE",
                "Unexpected royalty quote.",
                502,
              );
            result = {
              protocolFee: fromU256(values[0], values[1]),
              royaltyRecipient: address(values[2]),
              royaltyAmount: fromU256(values[3], values[4]),
              sellerProceeds: fromU256(values[5], values[6]),
              buyerDebit: uint(q.price),
            };
          }
        } else if (route[0] === "accounts" && route[1]) {
          if (route[2] === "holdings")
            result = await catalog.holdings(route[1], q);
          else if (route[2] === "orders")
            result = await catalog.orders(q.collection, {
              ...q,
              ...(q.direction === "received"
                ? { received: route[1] }
                : { maker: route[1] }),
              ...(q.direction === "listed" ? { kind: "listing" } : {}),
            });
          else if (route[2] === "activity")
            result = await catalog.activity({ ...q, account: route[1] });
        } else if (route[0] === "transactions" && route[1]) {
          const hash = "0x" + BigInt(uint(route[1], 252)).toString(16);
          result = await store.transactionStatus(hash);
        } else if (route[0] === "search") result = await catalog.search(q.q);
        else if (route[0] === "indexer" && route[1] === "status")
          result = await catalog.status();
        else if (route[0] === "marketplace" && route[1] === "config")
          result = {
            ...(await store.get("config", "marketplace")),
            chain: config.chain,
            chainId: config.chainId,
            marketplace: config.marketplace,
            currencies: config.currencies,
            collections: await Promise.all(
              config.collections.map(async (c) => ({
                ...c,
                enabled: !!(
                  await store.get(
                    "policy",
                    `collection_policy:${address(c.address)}`,
                  )
                )?.enabled,
              })),
            ),
            demo: !!config.demo,
            status: await catalog.status(),
          };
      }
      if (result === undefined)
        throw new ApiError("NOT_FOUND", "Route not found.", 404);
      const response = {
        data: result,
        meta: {
          schemaVersion: "1.0.0",
          chain: config.chain,
          marketplace: config.marketplace,
          indexedBlock: (await store.head())?.number ?? null,
          generation: await store.generation(),
          generatedAt: new Date().toISOString(),
        },
        requestId,
      };
      if (readTransaction) {
        await store.endSnapshot();
        readTransaction = false;
      }
      send(response);
    } catch (e) {
      if (readTransaction) {
        try {
          await store.endSnapshot();
        } catch {
          /* A dead connection must not escape the request error handler. */
        }
      }
      if (!res.headersSent)
        send(
          {
            error: {
              code: e.code ?? "INTERNAL_ERROR",
              message:
                e instanceof ApiError ? e.message : "Unexpected server error.",
              requestId,
              retryable: e.status >= 500,
            },
          },
          e.status ?? 500,
        );
      else res.end();
    }
  });
  api.requestTimeout = 15000;
  api.headersTimeout = 10000;
  return api;
}
