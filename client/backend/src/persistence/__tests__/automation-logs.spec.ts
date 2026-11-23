import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInitialSnapshot } from '@workspace/core/snapshot';
import type { Automation } from '@workspace/core/contracts';
import { AppStateStore } from '../store';

let home = '';
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), 'automation-logs-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const file = (...segments: string[]) => path.join(home, ...segments);
const logFiles = async () => (await readdir(file('automations')).catch(() => [] as string[])).sort();
const load = () => new AppStateStore(home).load();

const automation = (id: string, runs: number): Automation => ({
  id, name: id, enabled: true, prompt: 'Check tasks', schedule: { intervalMinutes: 60 },
  target: { kind: 'newQuickChat', teamId: 'team-1', selection: { provider: 'codex', model: null, reasoningEffort: null, serviceTier: null } },
  executionLog: Array.from({ length: runs }, (_, index) => ({
    id: `${id}-run-${index}`, automationId: id, startedAt: `2026-11-0${index + 1}T00:00:00.000Z`, completedAt: `2026-11-0${index + 1}T00:01:00.000Z`, status: 'completed' as const,
  })),
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
});

function snapshotWithAutomations() {
  const snapshot = createInitialSnapshot();
  snapshot.automations = [automation('automation-issues', 3), automation('automation-idle', 0)];
  return snapshot;
}

describe('Automation logs', () => {
  it('keeps the log of each automation in its own file and the automation itself in roster.json', async () => {
    const snapshot = snapshotWithAutomations();

    await new AppStateStore(home).save(snapshot);

    expect(await logFiles()).toStrictEqual(['automation-issues.json']);
    const roster = await readFile(file('roster.json'), 'utf8');
    expect(roster).toContain('automation-issues');
    expect(roster).not.toContain('automation-issues-run-0');
    expect((await load()).automations).toStrictEqual(snapshot.automations);
  });

  it('deletes the log file when its log is cleared or its automation deleted', async () => {
    const snapshot = snapshotWithAutomations();
    snapshot.automations.push(automation('automation-weekly', 1));
    const store = new AppStateStore(home);
    await store.save(snapshot);
    expect(await logFiles()).toStrictEqual(['automation-issues.json', 'automation-weekly.json']);

    snapshot.automations[0]!.executionLog = [];
    snapshot.automations.pop();
    await store.save(snapshot);

    expect(await logFiles()).toStrictEqual([]);
  });

  it('moves a log still held in roster.json to its file on the next save', async () => {
    const snapshot = snapshotWithAutomations();
    await new AppStateStore(home).save(snapshot);
    const roster = JSON.parse(await readFile(file('roster.json'), 'utf8')) as { data: { automations: Automation[] } };
    roster.data.automations = structuredClone(snapshot.automations);
    await writeFile(file('roster.json'), JSON.stringify(roster));
    await rm(file('automations'), { recursive: true, force: true });

    const loaded = await load();
    expect(loaded.automations).toStrictEqual(snapshot.automations);

    await new AppStateStore(home).save(loaded);
    expect(await logFiles()).toStrictEqual(['automation-issues.json']);
    expect(await readFile(file('roster.json'), 'utf8')).not.toContain('automation-issues-run-0');
  });
});
