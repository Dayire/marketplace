/** The scanner verifies RPC ancestry before supplying this first-block evidence. */
export function validHistoricalAnchor(block, oldest, canonicalTarget) {
  const anchor = block.backfillAnchor;
  return (
    block.backfill === true &&
    Number.isSafeInteger(block.number) &&
    block.number >= 0 &&
    Number.isSafeInteger(oldest) &&
    block.number < oldest &&
    anchor != null &&
    Number.isSafeInteger(anchor.number) &&
    anchor.number >= oldest &&
    canonicalTarget?.hash === anchor.hash &&
    typeof anchor.parentHashVerified === "string" &&
    anchor.parentHashVerified === block.parentHash
  );
}
