/**
 * Where the profile pass has got to, read from a capture checkpoint.
 *
 * Kept out of the engine so it can be tested as the pure function it is: this
 * is the numerator the enrichment stage publishes, and getting it wrong is
 * invisible in a unit test of anything else.
 */

/**
 * How many contacts the profile pass has been *through*: written, skipped as
 * unchanged by a soft sync, or unavailable on LinkedIn.
 *
 * The stage used to report only the profiles it actually wrote, against a
 * denominator of the whole network. A full sync therefore stopped a little
 * short of its own total (LinkedIn does not serve every profile), and a soft
 * sync — which walks every contact and rewrites only the ones that changed —
 * showed "12 of 3,000" for a pass that was nearly done, then jumped to
 * complete. Counting the walk makes the numerator and the denominator the same
 * kind of thing, so the bar drawn from them means what it looks like it means.
 * The profiles actually written are still reported, as their own number, in the
 * message beside it.
 *
 * A page counts as walked once it has left the enrichment queue — a soft sync's
 * pages where everyone was already known never enter it — and the page in
 * flight is counted by its own batch outcomes, so the number keeps moving
 * within a page too.
 */
export function enrichmentWalked(progress, rowsPerChunk) {
  const uploaded = Math.max(0, Number(progress?.nextSequence) || 0);
  const size = Math.max(1, Number(rowsPerChunk) || 1);
  const total = Math.max(0, Number(progress?.totalConnections) || 0);
  const pending = new Set(
    Array.isArray(progress?.pendingEnrichmentSequences)
      ? progress.pendingEnrichmentSequences.map(Number)
      : [],
  );
  let walked = 0;
  for (let sequence = 0; sequence < uploaded; sequence++) {
    if (pending.has(sequence)) continue;
    const start = sequence * size;
    walked += total > 0 ? Math.max(0, Math.min(size, total - start)) : size;
  }
  for (const [key, outcome] of Object.entries(progress?.enrichmentBatchOutcomes || {})) {
    const sequence = Number(String(key).split(":")[0]);
    if (!pending.has(sequence)) continue;
    walked += (Number(outcome?.enriched) || 0) + (Number(outcome?.unavailable) || 0);
  }
  return total > 0 ? Math.min(walked, total) : walked;
}
