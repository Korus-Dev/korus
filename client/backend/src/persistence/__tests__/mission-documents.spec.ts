import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialSnapshot } from '@workspace/core/snapshot';
import { createMission, type Mission } from '@workspace/core/missions';
import type { MissionRun } from '@workspace/core/mission-types';
import type { AppSnapshot } from '@workspace/core/contracts';
import { AppStateStore } from '../store';
import { MissionService } from '../../mission-service';
import { AppBackendServer } from '../../server';
import { persistedStateFromSnapshot } from '../../state-persistence';
import { StoreFormatError, parseStoreFile } from '../store-format';

// Lets a test make the commit of one file fail, as a full disk or a crash would.
const faults = vi.hoisted(() => ({ failRenameTo: '' as string | ((to: string) => boolean), failUnlink: '' }));
vi.mock('node:fs/promises', async (load) => {
  const fs = await load<typeof import('node:fs/promises')>();
  return { ...fs,
    rename: async (from: string, to: string) => {
      const fail = typeof faults.failRenameTo === 'function' ? faults.failRenameTo(to) : to === faults.failRenameTo;
      if (fail) throw new Error('injected write failure');
      return fs.rename(from, to);
    },
    unlink: async (target: string) => {
      if (target === faults.failUnlink) throw new Error('injected removal failure');
      return fs.unlink(target);
    },
  };
});

let home = '';
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), 'mission-documents-')); });
afterEach(async () => { faults.failRenameTo = ''; faults.failUnlink = ''; await rm(home, { recursive: true, force: true }); });

const file = (...segments: string[]) => path.join(home, ...segments);
const readJson = async (...segments: string[]) => JSON.parse(await readFile(file(...segments), 'utf8')) as { schemaVersion: number; data: Record<string, unknown> };
const load = () => new AppStateStore(home).load();
type StoredMissionRecord = Record<string, unknown> & { documents?: string; execution?: { runs: Array<Record<string, unknown>> } };
const storedMissions = async () => (await readJson('roster.json')).data.missions as StoredMissionRecord[];
/** The file the roster names for a Mission's documents. */
const documentsFile = async (index = 0) => ['mission-documents', `${(await storedMissions())[index]!.documents}.json`];

const run = (mission: Mission, id: string, stage: MissionRun['stage'], status: MissionRun['status'], extra: Partial<MissionRun> = {}): MissionRun => ({
  id, stage, memberId: mission.execution!.memberIds[0]!, status, skills: [], feedback: '', startedAt: '2026-11-01T00:00:00.000Z', ...extra });

/** A Mission with documents, a finished run that kept a copy of them, a cancelled ticket draft and a run awaiting review. */
function snapshotWithMission(id?: string): { snapshot: AppSnapshot; mission: Mission } {
  const snapshot = createInitialSnapshot();
  const lead = snapshot.agents[0]!;
  const mission = createMission(snapshot, { outcome: 'Ship checkout', workflowType: 'shapeAndShipFeature', teamId: lead.teamId, orchestratorMemberId: lead.id });
  if (id) mission.id = id;
  mission.artifacts.requirements = { problem: 'committed requirements', acceptance: 'Under a second' };
  mission.artifacts.tickets = [{ id: 'mission-ticket-a', title: 'Cache prices', body: 'Cache the price list', done: true }];
  mission.artifacts.implementation = { changes: 'Cached prices', tests: 'Price tests pass' };
  mission.execution!.runs = [
    run(mission, 'mission-run-done', 'implementation', 'accepted', { proposal: structuredClone(mission.artifacts), implementationResult: { changes: 'Cached prices', tests: 'Price tests pass' } }),
    run(mission, 'mission-run-draft', 'tickets', 'cancelled', { draftTickets: [{ title: 'Draft kept for the next tickets run', done: false }] }),
    run(mission, 'mission-run-review', 'requirements', 'awaitingReview', { proposal: { ...structuredClone(mission.artifacts), requirements: { problem: 'proposed requirements', acceptance: 'done' } } }),
  ];
  return { snapshot, mission };
}
/** What a restart keeps: everything, except what a finished run proposed. */
function withoutFinishedProposal(mission: Mission): Mission {
  const kept = structuredClone(mission);
  for (const candidate of kept.execution!.runs) if (['accepted', 'cancelled', 'failed'].includes(candidate.status)) delete candidate.proposal;
  return kept;
}
/** The roster as 0.59 wrote it: schema 6, every Mission document inline. */
async function writeSchema6Roster(missions: Mission[]): Promise<string> {
  const roster = await readJson('roster.json');
  roster.schemaVersion = 6;
  roster.data.missions = structuredClone(missions);
  const bytes = JSON.stringify(roster);
  await writeFile(file('roster.json'), bytes);
  await rm(file('mission-documents'), { recursive: true, force: true });
  return bytes;
}

describe('Mission documents', () => {
  it('keeps each Mission\'s documents out of roster.json and restores them in a fresh process', async () => {
    const { snapshot, mission } = snapshotWithMission();

    await new AppStateStore(home).save(snapshot);

    const [stored] = await storedMissions();
    expect(stored).not.toHaveProperty('artifacts');
    expect(stored!.execution!.runs.flatMap(candidate => Object.keys(candidate))).not.toEqual(expect.arrayContaining(['proposal', 'draftTickets', 'implementationResult']));
    expect(JSON.stringify(await readJson(...await documentsFile()))).toContain('Cache the price list');
    expect((await load()).missions).toStrictEqual([withoutFinishedProposal(mission)]);
  });

  it('keeps the last committed state when a save fails after writing the new documents', async () => {
    const { snapshot, mission } = snapshotWithMission();
    const store = new AppStateStore(home);
    await store.save(snapshot);
    const service = new MissionService(snapshot, next => store.save(next));
    faults.failRenameTo = file('roster.json');

    await expect(service.change(mission.id, current => {
      const review = current.execution!.runs[2]!;
      current.artifacts = structuredClone(review.proposal!);
      review.status = 'accepted';
    })).rejects.toThrow('injected');
    faults.failRenameTo = '';

    // The run can still be accepted: its documents and its proposal are those of the last committed save.
    expect((await load()).missions).toStrictEqual([withoutFinishedProposal(mission)]);
  });

  it('reports a committed save as done when an old documents version cannot be removed, and removes it on a later save', async () => {
    const { snapshot, mission } = snapshotWithMission();
    const store = new AppStateStore(home);
    await store.save(snapshot);
    const previous = await documentsFile();
    faults.failUnlink = file(...previous);
    const service = new MissionService(snapshot, next => store.save(next));

    await service.change(mission.id, current => { current.execution!.runs[2]!.status = 'accepted'; });

    expect(snapshot.missions![0]!.execution!.runs[2]!.status).toBe('accepted');
    expect((await load()).missions![0]!.execution!.runs[2]!.status).toBe('accepted');
    faults.failUnlink = '';
    await service.change(mission.id, current => { current.outcome = 'Ship checkout faster'; });
    expect(await readdir(file('mission-documents'))).toStrictEqual([(await documentsFile()).at(-1)]);
  });

  it('keeps the home loadable when deleting a Mission fails before roster.json is written', async () => {
    const { snapshot, mission } = snapshotWithMission();
    const store = new AppStateStore(home);
    await store.save(snapshot);
    const server = new AppBackendServer({ version: 'test', snapshot, saveSnapshot: next => store.save(next),
      deleteMissionHome: id => rm(file('missions', id), { recursive: true, force: true }) });
    try {
      faults.failRenameTo = file('roster.json');
      await expect(server.handleMessage({ jsonrpc: '2.0', id: 'delete', method: 'mission/delete',
        params: { input: { id: mission.id, revision: mission.revision, deleteWorktrees: false, confirmed: true } } })).rejects.toThrow('injected');
      faults.failRenameTo = '';

      expect((await load()).missions).toStrictEqual([withoutFinishedProposal(mission)]);
    } finally { await server.close(); }
  });

  it('removes a deleted Mission\'s documents once roster.json no longer refers to them', async () => {
    const { snapshot } = snapshotWithMission();
    const store = new AppStateStore(home);
    await store.save(snapshot);

    await store.save({ ...snapshot, missions: [] });

    expect(await readdir(file('mission-documents'))).toStrictEqual([]);
    expect(await load()).toMatchObject({ missions: [] });
  });

  it.each([
    ['missing', async (documents: string[]) => { await rm(file(...documents)); }],
    ['damaged', async (documents: string[]) => {
      const text = await readFile(file(...documents), 'utf8');
      await writeFile(file(...documents), text.replace('"tickets"', '"removedTickets"'));
    }],
  ])('refuses to start, naming the file, when a Mission\'s documents are %s', async (_, damage) => {
    const { snapshot } = snapshotWithMission();
    await new AppStateStore(home).save(snapshot);
    const documents = await documentsFile();
    await damage(documents);
    const roster = await readFile(file('roster.json'), 'utf8');

    await expect(load()).rejects.toThrowError(StoreFormatError);
    await expect(load()).rejects.toThrowError(documents.at(-1)!);
    expect(await readFile(file('roster.json'), 'utf8')).toBe(roster);
  });

  it('refuses to start, rather than drop it, when a Mission in roster.json has no documents at all', async () => {
    const { snapshot } = snapshotWithMission();
    await new AppStateStore(home).save(snapshot);
    const roster = await readJson('roster.json');
    delete (roster.data.missions as StoredMissionRecord[])[0]!.documents;
    const bytes = JSON.stringify(roster);
    await writeFile(file('roster.json'), bytes);

    await expect(load()).rejects.toThrowError(StoreFormatError);
    expect(await readFile(file('roster.json'), 'utf8')).toBe(bytes);
  });

  it('moves the documents of a schema-6 roster on load, after a verified backup that older builds refuse to rewrite', async () => {
    const { snapshot, mission } = snapshotWithMission();
    await new AppStateStore(home).save(snapshot);
    const original = await writeSchema6Roster([mission]);

    expect((await load()).missions).toStrictEqual([withoutFinishedProposal(mission)]);

    const migrated = await readFile(file('roster.json'), 'utf8');
    expect(migrated).not.toContain('Cache the price list');
    expect(() => parseStoreFile('roster.json', migrated, 6)).toThrowError(StoreFormatError);
    const backups = await readdir(file('backups'));
    expect(backups).toHaveLength(1);
    expect(await readFile(file('backups', backups[0]!), 'utf8')).toBe(original);
    expect((await load()).missions).toStrictEqual([withoutFinishedProposal(mission)]);
  });

  it.each([
    ['invalid documents', (mission: Mission) => { (mission.artifacts as unknown as Record<string, unknown>).tickets = null; }],
    ['no documents', (mission: Mission) => { delete (mission as Partial<Mission>).artifacts; }],
  ])('refuses a schema-6 Mission with %s before replacing the roster, naming the Mission', async (_, damage) => {
    const { snapshot, mission } = snapshotWithMission();
    await new AppStateStore(home).save(snapshot);
    damage(mission);
    const original = await writeSchema6Roster([mission]);

    await expect(load()).rejects.toThrowError(StoreFormatError);
    await expect(load()).rejects.toThrowError(mission.id);
    expect(await readFile(file('roster.json'), 'utf8')).toBe(original);
  });

  it('retries an interrupted schema-6 migration from the original roster', async () => {
    const { snapshot, mission } = snapshotWithMission();
    await new AppStateStore(home).save(snapshot);
    const original = await writeSchema6Roster([mission]);
    faults.failRenameTo = file('roster.json');

    await expect(load()).rejects.toThrow('injected');
    faults.failRenameTo = '';
    expect(await readFile(file('roster.json'), 'utf8')).toBe(original);

    expect((await load()).missions).toStrictEqual([withoutFinishedProposal(mission)]);
  });

  it('leaves the files agents keep in a Mission\'s working folder alone', async () => {
    const { snapshot, mission } = snapshotWithMission();
    await new AppStateStore(home).save(snapshot);
    await writeSchema6Roster([mission]);
    await mkdir(file('missions', mission.id), { recursive: true });
    await writeFile(file('missions', mission.id, 'mission.json'), '{"project":"an agent\'s own file"}');

    await load();

    expect(await readFile(file('missions', mission.id, 'mission.json'), 'utf8')).toBe('{"project":"an agent\'s own file"}');
  });

  it('migrates any valid Mission, whatever its id, and keeps runs that share an id apart', async () => {
    const { snapshot, mission } = snapshotWithMission('legacy-42');
    const twin = structuredClone(mission.execution!.runs[2]!);
    twin.proposal!.requirements.problem = 'a second proposal under the same run id';
    mission.execution!.runs.push(twin);
    await new AppStateStore(home).save(snapshot);
    await writeSchema6Roster([mission]);

    const [restored] = (await load()).missions!;

    expect(restored).toStrictEqual(withoutFinishedProposal(mission));
    expect(await readFile(file('roster.json'), 'utf8')).not.toContain('proposed requirements');
  });

  it('archives the documents with the layout a restored state.json replaces', async () => {
    const { snapshot } = snapshotWithMission();
    await new AppStateStore(home).save(snapshot);
    const replacement = structuredClone(snapshot);
    replacement.missions![0]!.artifacts.requirements.problem = 'from the restored state.json';
    await writeFile(file('state.json'), JSON.stringify(persistedStateFromSnapshot(replacement)));

    await new AppStateStore(home).load({ allowLegacyStartup: true });

    const archive = (await readdir(file('backups'))).find(name => name.startsWith('layout-before-migration-'))!;
    await expect(new AppStateStore(file('backups', archive)).load())
      .resolves.toMatchObject({ missions: [{ artifacts: { requirements: { problem: 'committed requirements' } } }] });
  });

  it('keeps the archived layout whole when archiving it is interrupted and retried', async () => {
    const { snapshot } = snapshotWithMission();
    await new AppStateStore(home).save(snapshot);
    await writeFile(file('state.json'), JSON.stringify(persistedStateFromSnapshot(structuredClone(snapshot))));
    faults.failRenameTo = to => to.includes('layout-before-migration-') && to.endsWith(`${path.sep}mission-documents`);

    await expect(new AppStateStore(home).load({ allowLegacyStartup: true })).rejects.toThrow('injected');
    faults.failRenameTo = '';
    await new AppStateStore(home).load({ allowLegacyStartup: true });

    const archives = (await readdir(file('backups'))).filter(name => name.startsWith('layout-before-migration-'));
    expect(archives).toHaveLength(1);
    await expect(new AppStateStore(file('backups', archives[0]!)).load())
      .resolves.toMatchObject({ missions: [{ artifacts: { requirements: { problem: 'committed requirements' } } }] });
  });

  it('writes a provider-setup backup that restores its Missions on its own', async () => {
    const { snapshot, mission } = snapshotWithMission();
    const store = new AppStateStore(home);
    await store.backupProviderSetup(snapshot);
    // Later saves collect documents the live roster no longer refers to.
    await store.save({ ...snapshot, missions: [] });
    const backups = await readdir(file('backups'));
    const restored = path.join(home, 'restored');
    await mkdir(restored);
    for (const name of ['roster', 'settings']) {
      await writeFile(path.join(restored, `${name}.json`), await readFile(file('backups', backups.find(backup => backup.startsWith(`provider-setup-${name}`))!)));
    }

    expect((await new AppStateStore(restored).load()).missions).toStrictEqual([withoutFinishedProposal(mission)]);
  });
});
