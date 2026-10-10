// Keccak-f[1600], original Keccak-256 padding. Starknet's sn_keccak masks
// the resulting digest to 250 bits; SHA3-256 has different domain padding.
// Algorithm reference: https://keccak.team/files/Keccak-reference-3.0.pdf
const MASK64 = (1n << 64n) - 1n;
const ROUND_CONSTANTS = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n,
  0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an,
  0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n,
];
const ROTATIONS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotate = (value, bits) => bits === 0 ? value :
  ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & MASK64;

function permute(lanes) {
  for (const round of ROUND_CONSTANTS) {
    const columns = Array.from({ length: 5 }, (_, x) =>
      lanes[x] ^ lanes[x + 5] ^ lanes[x + 10] ^ lanes[x + 15] ^ lanes[x + 20]);
    for (let x = 0; x < 5; x++) {
      const delta = columns[(x + 4) % 5] ^ rotate(columns[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) lanes[x + 5 * y] ^= delta;
    }
    const moved = Array(25).fill(0n);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(lanes[x + 5 * y], ROTATIONS[x + 5 * y]);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        lanes[x + 5 * y] = moved[x + 5 * y] ^
          ((~moved[(x + 1) % 5 + 5 * y] & MASK64) & moved[(x + 2) % 5 + 5 * y]);
    lanes[0] ^= round;
  }
}

/** Hash bytes to a lowercase Keccak-256 hex digest, without a runtime package. */
export function keccak256(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Keccak input must be bytes");
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  const lanes = Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate; i++)
      lanes[Math.floor(i / 8)] ^= BigInt(padded[offset + i]) << BigInt((i % 8) * 8);
    permute(lanes);
  }
  let digest = "";
  for (let i = 0; i < 32; i++)
    digest += Number((lanes[Math.floor(i / 8)] >> BigInt((i % 8) * 8)) & 255n).toString(16).padStart(2, "0");
  return digest;
}

/** Starknet entrypoint/event selector. Default entrypoints are reserved zero. */
export function selectorFromName(name) {
  if (typeof name !== "string" || !name || name.length > 512)
    throw new TypeError("Selector name must be a bounded nonempty string");
  if (name === "__default__" || name === "__l1_default__") return "0x0";
  return "0x" + (BigInt("0x" + keccak256(new TextEncoder().encode(name))) & ((1n << 250n) - 1n)).toString(16);
}
