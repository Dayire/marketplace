import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join, resolve, sep } from "node:path";

/**
 * Loads artwork for share images without reaching arbitrary origins.
 *
 * Token metadata is untrusted, so the web server only reads three kinds of
 * source: images our backend has already cached (fetched over the private API
 * address), files in `public/`, and inline data URIs. Remote and IPFS origins
 * are skipped; the card falls back to collection artwork instead.
 *
 * The renderer (`next/og`) decodes PNG, JPEG, GIF and SVG. Other formats such
 * as WebP are skipped rather than converted.
 */

export type ShareArtworkSources = {
  /** Reads a file below `public/`, given a validated relative path. */
  readPublicFile(relativePath: string): Promise<Uint8Array | null>;
  /** Reads a content-addressed asset from the marketplace API. */
  fetchCachedAsset(chain: string, file: string): Promise<Uint8Array | null>;
};

const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 4000;

const CACHED_ASSET =
  /^(?:https?:\/\/[^/?#]+)?(?:\/api\/marketplace)?\/v1\/chains\/([A-Za-z0-9_]{1,32})\/assets\/([a-f0-9]{64}\.(png|jpg|gif|svg|webp))$/;
const PUBLIC_FILE =
  /^\/(?!api\/)((?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|svg))$/i;
const DATA_URI = /^data:image\/(?:png|jpeg|gif|svg\+xml)((?:;[^,;]+)*),(.*)$/is;
const SVG_HEAD =
  /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(<svg[^>]*>)/i;

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function sniff(bytes: Uint8Array) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";

  const head = new TextDecoder().decode(bytes.subarray(0, 2048)).replace(/^﻿/, "");
  const svg = SVG_HEAD.exec(head)?.[1];
  // The renderer sizes SVGs from their viewBox or explicit width and height.
  if (svg && (/viewBox=/i.test(svg) || (/\swidth=/i.test(svg) && /\sheight=/i.test(svg)))) {
    return "image/svg+xml";
  }
  return null;
}

/** A base64 data URI the renderer can draw, or null for unsupported bytes. */
export function shareImageDataUri(bytes: Uint8Array) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTWORK_BYTES) return null;
  const type = sniff(bytes);
  return type ? `data:${type};base64,${Buffer.from(bytes).toString("base64")}` : null;
}

function decodeDataUri(value: string) {
  const match = DATA_URI.exec(value);
  if (!match) return null;
  const [, parameters, payload] = match;
  try {
    return /;base64/i.test(parameters)
      ? Uint8Array.from(Buffer.from(payload, "base64"))
      : new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

async function loadCandidate(candidate: string, sources: ShareArtworkSources) {
  const value = candidate.trim();

  if (/^data:/i.test(value)) return decodeDataUri(value);

  const cached = CACHED_ASSET.exec(value);
  if (cached) {
    const [, chain, file, extension] = cached;
    return extension === "webp" ? null : sources.fetchCachedAsset(chain, file);
  }

  const local = PUBLIC_FILE.exec(value);
  if (local) return sources.readPublicFile(local[1]);

  return null;
}

/** The first candidate that loads as drawable artwork, as a data URI. */
export async function loadShareArtwork(
  candidates: ReadonlyArray<string | null | undefined>,
  sources: ShareArtworkSources = defaultShareArtworkSources,
) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const bytes = await loadCandidate(candidate, sources);
      const dataUri = bytes ? shareImageDataUri(bytes) : null;
      if (dataUri) return dataUri;
    } catch {
      // Try the next candidate; a missing or slow image must not break the card.
    }
  }
  return null;
}

const publicDirectory = resolve(process.cwd(), "public");
/** Files under `public/` do not change while the server runs. */
const publicFiles = new Map<string, Promise<Uint8Array | null>>();

export const defaultShareArtworkSources: ShareArtworkSources = {
  readPublicFile(relativePath) {
    const path = resolve(join(publicDirectory, relativePath));
    if (!path.startsWith(publicDirectory + sep)) return Promise.resolve(null);
    let bytes = publicFiles.get(path);
    if (!bytes) {
      bytes = readFile(path).then(
        (buffer) => new Uint8Array(buffer),
        () => {
          // Not kept, so a missing or briefly unreadable file is retried.
          publicFiles.delete(path);
          return null;
        },
      );
      publicFiles.set(path, bytes);
    }
    return bytes;
  },
  fetchCachedAsset(chain, file) {
    const base = (process.env.MARKETPLACE_API_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
    return readInternal(
      new URL(`${base}/v1/chains/${encodeURIComponent(chain)}/assets/${encodeURIComponent(file)}`),
    );
  },
};

/**
 * GET over Node's HTTP client rather than Next's instrumented `fetch`, so the
 * bytes never enter Next's data cache. Redirects are not followed, and a body
 * is abandoned as soon as it exceeds the size limit.
 */
function readInternal(url: URL) {
  return new Promise<Uint8Array | null>((resolveBytes, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      url,
      { method: "GET", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolveBytes(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ARTWORK_BYTES) {
            request.destroy();
            resolveBytes(null);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolveBytes(new Uint8Array(Buffer.concat(chunks))));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}
