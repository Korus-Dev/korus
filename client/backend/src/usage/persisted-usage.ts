import type { DatabaseSync } from 'node:sqlite';
import { validConsumption, type PersistedExecutionUsage } from '@workspace/core/usage';

export const persistedUsageSchema = `
  CREATE TABLE IF NOT EXISTS persisted_usage (
    provider TEXT NOT NULL, root_id TEXT NOT NULL, session_id TEXT NOT NULL,
    execution_id TEXT NOT NULL, turn_id TEXT NOT NULL, started_at INTEGER NOT NULL,
    supplemental INTEGER NOT NULL, tokens TEXT NOT NULL,
    PRIMARY KEY (provider, root_id, session_id, execution_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS persisted_usage_prompt
    ON persisted_usage(provider,root_id,turn_id) WHERE supplemental=0;
  CREATE UNIQUE INDEX IF NOT EXISTS persisted_usage_execution
    ON persisted_usage(provider,session_id,execution_id);
  CREATE INDEX IF NOT EXISTS persisted_usage_started ON persisted_usage(started_at);
`;

/** A prompt is admitted just before its native start. Require one candidate in both directions. */
function matchesPrompt(startedAt: number, turn: { started_at: number; updated_at: number }): boolean {
  return startedAt >= turn.started_at && startedAt <= Math.min(turn.started_at + 1000, turn.updated_at);
}

export function reconcilePersistedUsage(db: DatabaseSync, provider: string, rootId: string,
  samples: readonly PersistedExecutionUsage[], from: number, now: number): number {
  const turns = db.prepare(`SELECT turn_id, started_at, updated_at, phase FROM executions
    WHERE provider=? AND session_id=? AND started_at>=? ORDER BY started_at DESC`).all(provider, rootId, from) as
    { turn_id: string; started_at: number; updated_at: number; phase: string }[];
  if (!turns.length) return 0;
  const validSamples = samples.filter(sample => Number.isSafeInteger(sample.startedAt)
    && sample.startedAt >= from && sample.startedAt <= now + 60000
    && validConsumption(sample.tokens) && sample.tokens.total === sample.tokens.input + sample.tokens.output
    && [sample.sessionId, sample.executionId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 2048));
  const prompted = validSamples.filter(sample => sample.sessionId === rootId && sample.prompted);
  const write = db.prepare('INSERT INTO persisted_usage VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING');
  const update = db.prepare(`UPDATE persisted_usage SET tokens=?
    WHERE provider=? AND root_id=? AND session_id=? AND execution_id=?
    AND tokens<>? AND json_extract(tokens,'$.total')<=?`);
  let changed = 0;
  for (const sample of validSamples) {
    const supplemental = sample.sessionId !== rootId || !sample.prompted;
    const candidates = supplemental ? [] : turns.filter(turn => matchesPrompt(sample.startedAt, turn));
    const turn = supplemental ? turns.find(item => item.started_at <= sample.startedAt) : candidates[0];
    if (!turn || (!supplemental && (turn.phase === 'started' || candidates.length !== 1
      || prompted.filter(item => matchesPrompt(item.startedAt, turn)).length !== 1))) continue;
    const tokens = JSON.stringify(sample.tokens);
    changed += Number(write.run(provider, rootId, sample.sessionId, sample.executionId, turn.turn_id,
      sample.startedAt, supplemental ? 1 : 0, tokens).changes);
    changed += Number(update.run(tokens, provider, rootId, sample.sessionId, sample.executionId, tokens, sample.tokens.input + sample.tokens.output).changes);
  }
  return changed;
}
