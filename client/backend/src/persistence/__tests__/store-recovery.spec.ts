import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInitialSnapshot } from '@workspace/core/snapshot';
import { AppStateStore } from '../store';
import { StoreFormatError } from '../store-format';
import { restoreStoreBackup, storeRecovery } from '../store-recovery';

let home = '';
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), 'store-recovery-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const file = (...segments: string[]) => path.join(home, ...segments);
const load = () => new AppStateStore(home).load();
const failure = async (): Promise<StoreFormatError> => {
  const error = await load().then(() => null, (cause: unknown) => cause);
  if (!(error instanceof StoreFormatError)) throw new Error(`Expected a store format error, got ${String(error)}`);
  return error;
};
/** A copy of a store file as the backups folder names it. */
async function backup(name: string, text: string): Promise<void> {
  await mkdir(file('backups'), { recursive: true });
  await writeFile(file('backups', name), text);
}

describe('Store recovery', () => {
  it('offers the newest backup this build can read when a newer build wrote roster.json, and restores it', async () => {
    await new AppStateStore(home).save(createInitialSnapshot());
    const readable = await readFile(file('roster.json'), 'utf8');
    const newer = JSON.stringify({ ...JSON.parse(readable), schemaVersion: 99, writtenBy: 'daemon 9.0.0' });
    await writeFile(file('roster.json'), newer);
    await backup('roster-v7-2026-11-20T09-00-00.000Z.json', readable);
    await backup('provider-setup-roster-2026-11-22T14-30-00.000Z.json', readable);
    // Newer than anything this build reads, or a backup of another file: never offered.
    await backup('roster-v99-2026-11-23T08-00-00.000Z.json', newer);
    await backup('settings-v1-2026-11-23T08-00-00.000Z.json', readable);

    const recovery = await storeRecovery(home, await failure());

    expect(recovery).toStrictEqual({
      file: 'roster.json',
      reason: 'newer',
      message: expect.stringContaining('schema 99'),
      backup: { name: 'provider-setup-roster-2026-11-22T14-30-00.000Z.json', createdAt: '2026-11-22T14:30:00.000Z' },
    });
    await restoreStoreBackup(home, recovery, recovery.backup!.name);
    expect(await readFile(file('roster.json'), 'utf8')).toBe(readable);
    await expect(load()).resolves.toBeDefined();
  });

  it('offers a backup of a damaged settings.json, and never the copy that just failed again', async () => {
    await new AppStateStore(home).save(createInitialSnapshot());
    const readable = await readFile(file('settings.json'), 'utf8');
    await writeFile(file('settings.json'), '{ not json');
    await backup('settings-v1-2026-11-21T10-00-00.000Z.json', readable);
    await backup('settings-v1-2026-11-22T10-00-00.000Z.json', '{ not json');

    const recovery = await storeRecovery(home, await failure());

    expect(recovery).toMatchObject({ file: 'settings.json', reason: 'unreadable', backup: { name: 'settings-v1-2026-11-21T10-00-00.000Z.json' } });
  });

  it('restores roster.json when a file it names is what fails, and offers nothing without a usable backup', async () => {
    const snapshot = createInitialSnapshot();
    snapshot.agents[0]!.designWorkspaces = [{ conversationRef: null, isOpen: true, selectedArtboardId: null, selectedNodeId: null, undo: [], checkpoints: [],
      document: { id: 'design-1', revision: 1, content: { title: 'Launch', css: '', comments: [], artboards: [] } } }];
    await new AppStateStore(home).save(snapshot);
    await rm(file('designs', 'design-1.json'));

    expect(await storeRecovery(home, await failure())).toStrictEqual({ file: 'roster.json', reason: 'unreadable', message: expect.stringContaining('design-1'), backup: null });
  });

  it('refuses to restore anything but the backup it offered', async () => {
    await new AppStateStore(home).save(createInitialSnapshot());
    await writeFile(file('roster.json'), '{ not json');
    await backup('roster-v8-2026-11-22T10-00-00.000Z.json', 'anything');

    const recovery = await storeRecovery(home, await failure());

    await expect(restoreStoreBackup(home, recovery, '../settings.json')).rejects.toThrow('offered');
    expect(await readFile(file('roster.json'), 'utf8')).toBe('{ not json');
  });
});
