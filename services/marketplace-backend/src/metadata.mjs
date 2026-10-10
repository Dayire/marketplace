import { address } from "./domain.mjs";
import { parseTokenMetadata } from "./metadata-data.mjs";
import {
  expandMetadataJobs,
  metadataCandidates,
  claimMetadataJob,
  completeMetadataJob,
} from "./metadata-store.mjs";
import { mapConcurrent } from "./concurrency.mjs";
import { createMediaFetcher } from "./media-fetch.mjs";
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError, u256Felts } from "./domain.mjs";
import { SELECTORS } from "./decode.mjs";
export function publicAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(ip) === 6) {
    const parts = ip.split(":"),
      n = parseInt(parts[0], 16);
    return (
      n >= 0x2000 &&
      n < 0x4000 &&
      n !== 0x2002 &&
      !(n === 0x2001 && parseInt(parts[1] || "0", 16) < 0x200) &&
      !ip.toLowerCase().startsWith("2001:db8:")
    );
  }
  return false;
}
export async function fetchPublic(
  raw,
  { maxBytes = 2 * 1024 * 1024, redirects = 3, timeoutMs = 8000 } = {},
) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new ApiError("UNSAFE_URI", "Unsupported metadata URI.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
    throw new ApiError(
      "UNSAFE_URI",
      "Metadata destination is private or reserved.",
    );
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          "accept-encoding": "identity",
          "user-agent": "BiblioMetadata/1",
        },
        timeout: timeoutMs,
        lookup: (_h, opts, cb) =>
          opts.all
            ? cb(null, [addresses[0]])
            : cb(null, addresses[0].address, addresses[0].family),
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          if (redirects <= 0 || !res.headers.location) {
            reject(new Error("Redirect limit"));
            return;
          }
          fetchPublic(new URL(res.headers.location, url).href, {
            maxBytes,
            redirects: redirects - 1,
            timeoutMs,
          }).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          const retry = res.headers["retry-after"];
          const retryAfterMs =
            retry && /^\d+$/.test(retry)
              ? Number(retry) * 1000
              : Math.max(0, Date.parse(retry ?? "") - Date.now()) || 0;
          reject(
            Object.assign(new Error(`Metadata HTTP ${res.statusCode}`), {
              status: res.statusCode,
              retryAfterMs,
            }),
          );
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error("Metadata exceeds size limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            bytes: Buffer.concat(chunks),
            contentType: String(res.headers["content-type"] ?? "").split(
              ";",
            )[0],
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Metadata timeout")));
    req.on("error", reject);
  });
}
// One shared per-host pacing gate for every origin fetch made with fetchPublic.
const pacedFetchPublic = createMediaFetcher(fetchPublic);

function feltBytes(v, length) {
  const n = BigInt(v);
  if (n < 0n || n >= 1n << BigInt(length * 8))
    throw new Error("Invalid Cairo byte word");
  return length
    ? Buffer.from(n.toString(16).padStart(length * 2, "0"), "hex")
    : Buffer.alloc(0);
}
export function decodeUri(felts) {
  if (
    !Array.isArray(felts) ||
    !felts.length ||
    felts.length > Math.ceil((2 * 1024 * 1024) / 31) + 3
  )
    throw new Error("Invalid token URI");
  if (felts.length === 1) {
    const h = BigInt(felts[0]).toString(16);
    return Buffer.from(h.length % 2 ? "0" + h : h, "hex").toString("utf8");
  }
  const count = Number(BigInt(felts[0]));
  if (count >= 0 && count + 3 === felts.length) {
    const pending = Number(BigInt(felts.at(-1)));
    if (pending < 0 || pending > 30) throw new Error("Invalid pending word");
    return Buffer.concat([
      ...felts.slice(1, 1 + count).map((f) => feltBytes(f, 31)),
      feltBytes(felts.at(-2), pending),
    ]).toString("utf8");
  }
  if (count + 1 === felts.length)
    return felts
      .slice(1)
      .map((f) => decodeUri([f]))
      .join("");
  throw new Error("Unsupported token URI encoding");
}
export function normalizeMetadata(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Metadata must be an object");
  const attributes = (Array.isArray(raw.attributes) ? raw.attributes : [])
    .slice(0, 200)
    .flatMap((a) => {
      if (!a || typeof a !== "object") return [];
      const name = String(a.trait_type ?? a.name ?? "").slice(0, 100);
      if (!name || !["string", "number", "boolean"].includes(typeof a.value))
        return [];
      let value = a.value;
      if (value === "true" || value === "false") value = value === "true";
      if (
        typeof value === "string" &&
        /^-?\d+(?:\.\d+)?$/.test(value) &&
        Number.isSafeInteger(Number(value))
      )
        value = Number(value);
      if (typeof value === "number" && !Number.isFinite(value)) return [];
      return [{ name, value }];
    });
  return {
    name: typeof raw.name === "string" ? raw.name.slice(0, 300) : null,
    description:
      typeof raw.description === "string"
        ? raw.description.slice(0, 5000)
        : null,
    image: typeof raw.image === "string" ? raw.image : null,
    attributes,
    resourceCount: new Set(
      attributes
        .filter((a) => a.name.toLowerCase() === "resource")
        .map((a) => a.value),
    ).size,
  };
}
const MAX_INLINE_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Consecutive image failures wait 5 min, 30 min, 2 h, 12 h and then 24 h. */
export const IMAGE_RETRY_BACKOFF_MS = Object.freeze([
  300000, 1800000, 7200000, 43200000, 86400000,
]);
/** Tokens whose metadata is current are re-read every six hours. */
export const READY_RECHECK_MS = 21600000;
const CID = "(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})";
const BARE_CID = new RegExp(`^${CID}(?:/|$)`);
const IMMUTABLE_MEDIA = new RegExp(
  `^(?:ipfs://(?:ipfs/)?|https?://[^/]+/ipfs/|/ipfs/)?${CID}(?:/|$)`,
);
/** Rewrites IPFS and Arweave references to gateway URLs; other URIs pass through. */
export function resolveMediaUri(
  uri,
  gateway = "https://ipfs.io/ipfs",
  arweaveGateway = "https://arweave.net",
) {
  if (typeof uri !== "string") return uri;
  const ipfs = (path) =>
    `${gateway.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  if (/^ipfs:\/\//i.test(uri))
    return ipfs(uri.slice("ipfs://".length).replace(/^ipfs\//i, ""));
  if (/^\/ipfs\//i.test(uri)) return ipfs(uri.slice("/ipfs/".length));
  if (BARE_CID.test(uri)) return ipfs(uri);
  if (/^ar:\/\//i.test(uri))
    return `${arweaveGateway.replace(/\/+$/, "")}/${uri
      .slice("ar://".length)
      .replace(/^\/+/, "")}`;
  return uri;
}
const immutableMediaUri = (uri) =>
  typeof uri === "string" &&
  (IMMUTABLE_MEDIA.test(uri) || /^(?:ar:|data:)/i.test(uri));
/** Decodes a data: URI (base64 or percent-encoded) into its bytes; null for other URIs. */
export function parseDataUri(uri, maxBytes = Infinity) {
  const match = /^data:([^,]*),([\s\S]*)$/i.exec(
    typeof uri === "string" ? uri : "",
  );
  if (!match) return null;
  const params = match[1].split(";").map((p) => p.trim().toLowerCase());
  const mime = params.shift() || "text/plain";
  const base64 = params.includes("base64");
  const payload = match[2];
  // Text this long must decode to more than maxBytes; skip the allocation.
  if (
    payload.length >
    (base64 ? Math.ceil((maxBytes * 4) / 3) + 4 : maxBytes * 3)
  )
    throw new Error("Inline data exceeds size limit");
  let bytes;
  if (base64) bytes = Buffer.from(payload, "base64");
  else {
    let text;
    try {
      text = decodeURIComponent(payload);
    } catch {
      text = payload; // inline SVG with raw "%" lengths is sent unencoded
    }
    bytes = Buffer.from(text, "utf8");
  }
  if (bytes.length > maxBytes) throw new Error("Inline data exceeds size limit");
  return { mime, bytes };
}
const IMAGE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};
const IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};
// Gateways commonly label media with these; the bytes decide instead of a rejection.
const GENERIC_TYPES = new Set([
  "",
  "application/octet-stream",
  "text/plain",
  "text/xml",
  "application/xml",
]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SVG_HEAD =
  /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i;
function sniffImage(bytes) {
  if (bytes.subarray(0, 8).equals(PNG_MAGIC)) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (/^GIF8[79]a/.test(bytes.toString("latin1", 0, 6))) return "gif";
  if (
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  )
    return "webp";
  if (
    SVG_HEAD.test(bytes.subarray(0, 1024).toString("utf8").replace(/^﻿/, ""))
  )
    return "svg";
  return null;
}
/** Maps a declared content type, or sniffed bytes for generic types, to an asset extension. */
export function imageExtension(contentType, bytes) {
  const type = String(contentType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const ext =
    IMAGE_EXTENSIONS[type] ?? (GENERIC_TYPES.has(type) ? sniffImage(bytes) : null);
  if (!ext) throw new Error("Unsupported image content type");
  return ext;
}
export async function refreshMetadata(
  store,
  rpc,
  config,
  {
    assetDir,
    limit = 10,
    // At most half the pass can come from a single collection by default.
    quota = null,
    concurrency = 4,
    fetchResource = fetchPublic,
    // Origin traffic shares one paced fetcher per host; injected fetchers run as given.
    fetchMedia = fetchResource === fetchPublic ? pacedFetchPublic : fetchResource,
  } = {},
) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error("Metadata concurrency must be 1–4");
  const resolve = (uri) =>
    resolveMediaUri(
      uri,
      config.ipfsGateway ?? "https://ipfs.io/ipfs",
      config.arweaveGateway,
    );
  await expandMetadataJobs(store);
  const now = Date.now();
  const perCollectionQuota = quota ?? Math.max(1, Math.ceil(limit / 2));
  const tokens = await metadataCandidates(store, now, limit, perCollectionQuota);
  await mapConcurrent(tokens, concurrency, async (token) => {
    let patch;
    const claim = await claimMetadataJob(store, token, Date.now());
    if (!claim) return;
    try {
      let values;
      try {
        values = await rpc.contract(
          token.collection,
          SELECTORS.token_uri,
          u256Felts(token.tokenId),
        );
      } catch {
        values = await rpc.contract(
          token.collection,
          SELECTORS.tokenURI,
          u256Felts(token.tokenId),
        );
      }
      const uri = decodeUri(values);
      const inline = parseDataUri(uri, MAX_INLINE_METADATA_BYTES);
      if (inline && !["application/json", "text/plain"].includes(inline.mime))
        throw new Error("Unsupported inline metadata type");
      const bytes = inline
        ? inline.bytes
        : (await fetchMedia(resolve(uri))).bytes;
      const raw = parseTokenMetadata(
          bytes.toString(),
          (config.collections ?? []).find(
            (c) => address(c.address) === address(token.collection),
          )?.metadata?.repairControlCharacters === true,
        ),
        metadata = normalizeMetadata(raw);
      const metadataHash = createHash("sha256").update(bytes).digest("hex");
      // Immutable cached bytes can outlive transient origin failures. Reuse only
      // when the source is unchanged; a new URI must never inherit old artwork.
      const sameSource =
        token.image &&
        (token.metadata?.imageSourceUri === metadata.image ||
          token.metadataHash === metadataHash);
      let image = sameSource ? token.image : null;
      if (!image && immutableMediaUri(metadata.image) && store.cachedImage)
        image = await store.cachedImage(metadata.image);
      let imageError = null;
      if (
        metadata.image &&
        !(image && immutableMediaUri(metadata.image)) &&
        (assetDir || store.dialect === "postgres")
      ) {
        try {
          const inlineImage = parseDataUri(metadata.image, MAX_IMAGE_BYTES);
          const asset = inlineImage
            ? { bytes: inlineImage.bytes, contentType: inlineImage.mime }
            : await fetchMedia(resolve(metadata.image), {
                maxBytes: MAX_IMAGE_BYTES,
                timeoutMs: 30000,
              });
          const ext = imageExtension(asset.contentType, asset.bytes);
          const name =
            createHash("sha256").update(asset.bytes).digest("hex") +
            "." +
            ext;
          if (store.dialect === "postgres")
            await store.saveAsset(name, IMAGE_TYPES[ext], asset.bytes);
          else {
            await mkdir(assetDir, { recursive: true });
            await writeFile(join(assetDir, name), asset.bytes);
          }
          image = `/api/marketplace/v1/chains/${config.chain}/assets/${name}`;
        } catch (error) {
          imageError = error.message;
        }
      }
      // Only a token left without any cached artwork counts as failing; a retained
      // copy keeps the regular cycle.
      const imageAttempts =
        imageError && !image ? (token.metadata?.imageAttempts ?? 0) + 1 : 0;
      const attributes = metadata.attributes;
      patch = {
        metadata: {
          ...metadata,
          // The cached asset once stored; until then the origin stays displayable.
          image: image ?? metadata.image,
          imageSourceUri: metadata.image,
          imageStatus: imageError
            ? "failed"
            : image
              ? "ready"
              : metadata.image
                ? "failed"
                : "absent",
          imageError,
          imageAttempts,
          attributes: attributes.map((a) => ({
            trait_type: a.name,
            value: a.value,
          })),
        },
        attributes,
        resourceCount: metadata.resourceCount,
        image,
        metadataUri: uri,
        metadataHash,
        metadataStatus: "ready",
        metadataError: null,
        metadataFetchedAt: now,
        metadataNextAttempt:
          Date.now() +
          (imageAttempts
            ? IMAGE_RETRY_BACKOFF_MS[
                Math.min(imageAttempts, IMAGE_RETRY_BACKOFF_MS.length) - 1
              ]
            : READY_RECHECK_MS),
      };
    } catch (e) {
      patch = {
        metadataStatus: "failed",
        metadataError: e.message,
        metadataNextAttempt: now + 300000,
      };
    }
    await completeMetadataJob(store, token, claim, patch);
  });
  return tokens.length;
}
