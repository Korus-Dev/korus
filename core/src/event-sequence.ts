/**
 * Whether `event` directly continues a stream whose last applied sequence is `lastSeq`.
 *
 * A snapshot that replaced the snapshots queued before it carries `coveredFromSeq`; the sequences it stands in for
 * were never sent, and are not a gap.
 */
export function continuesEventSequence(lastSeq: number, event: { seq: number; type: string; coveredFromSeq?: number }): boolean {
  if (event.seq === lastSeq + 1) return true;
  return event.type === 'snapshot.updated' && event.coveredFromSeq !== undefined
    && event.coveredFromSeq <= lastSeq + 1 && event.seq > lastSeq;
}
