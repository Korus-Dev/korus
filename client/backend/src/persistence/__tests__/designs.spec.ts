import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInitialSnapshot } from '@workspace/core/snapshot';
import type { DesignWorkspace } from '@workspace/core/design';
import { AppStateStore } from '../store';
import { StoreFormatError, parseStoreFile } from '../store-format';

let home = '';
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), 'designs-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const file = (...segments: string[]) => path.join(home, ...segments);
const readJson = async (...segments: string[]) => JSON.parse(await readFile(file(...segments), 'utf8')) as { schemaVersion: number; data: Record<string, unknown> };
const designFiles = async () => (await readdir(file('designs')).catch(() => [] as string[])).sort();
const load = () => new AppStateStore(home).load();

const content = { title: 'Launch', css: '', comments: [], artboards: [{ id: 'desktop', title: 'Desktop', width: 960, height: 640, root: { id: 'root', tag: 'main', children: [{ id: 'heading', tag: 'h1', text: 'Hello' }] } }] };
const design = (id: string): DesignWorkspace => ({
  conversationRef: null, isOpen: true, selectedArtboardId: 'desktop', selectedNodeId: null,
  document: { id, revision: 3, content }, undo: [], checkpoints: [{ id: `${id}-saved`, title: 'Saved', revision: 2, content }],
});
const emptyDesign = (): DesignWorkspace => ({ conversationRef: null, isOpen: true, selectedArtboardId: null, selectedNodeId: null, document: null, undo: [], checkpoints: [] });

function snapshotWithDesigns() {
  const snapshot = createInitialSnapshot();
  snapshot.agents[0]!.designWorkspaces = [design('design-launch'), emptyDesign()];
  snapshot.agents[1]!.designWorkspaces = [design('design-pricing')];
  return snapshot;
}

describe('Designs', () => {
  it('keeps each design in its own file and only what the agent needs to find it in roster.json', async () => {
    const snapshot = snapshotWithDesigns();

    await new AppStateStore(home).save(snapshot);

    expect(await designFiles()).toStrictEqual(['design-launch.json', 'design-pricing.json']);
    const roster = await readFile(file('roster.json'), 'utf8');
    expect(roster).not.toContain('Hello');
    expect(roster).toContain('design-launch');
    expect((await load()).agents.slice(0, 2).map(agent => agent.designWorkspaces)).toStrictEqual([
      snapshot.agents[0]!.designWorkspaces, snapshot.agents[1]!.designWorkspaces,
    ]);
  });

  it('deletes the file of a deleted design and the designs of a deleted agent', async () => {
    const snapshot = snapshotWithDesigns();
    const store = new AppStateStore(home);
    await store.save(snapshot);

    snapshot.agents[0]!.designWorkspaces = [emptyDesign()];
    snapshot.agents.splice(1, 1);
    snapshot.teams[0]!.agentIds = snapshot.teams[0]!.agentIds.filter(id => snapshot.agents.some(agent => agent.id === id));
    await store.save(snapshot);

    expect(await designFiles()).toStrictEqual([]);
  });

  it('moves the designs of a schema-7 roster out on the next save, and older builds refuse the roster from the start', async () => {
    const snapshot = snapshotWithDesigns();
    await new AppStateStore(home).save(snapshot);
    const roster = await readJson('roster.json');
    // A schema-7 roster held every design inline.
    roster.schemaVersion = 7;
    (roster.data.agents as Array<Record<string, unknown>>)[0]!.designWorkspaces = snapshot.agents[0]!.designWorkspaces;
    (roster.data.agents as Array<Record<string, unknown>>)[1]!.designWorkspaces = snapshot.agents[1]!.designWorkspaces;
    await writeFile(file('roster.json'), JSON.stringify(roster));
    await rm(file('designs'), { recursive: true, force: true });

    const loaded = await load();
    const rewritten = await readFile(file('roster.json'), 'utf8');
    expect(() => parseStoreFile('roster.json', rewritten, 7)).toThrowError(StoreFormatError);
    expect(loaded.agents[0]!.designWorkspaces).toStrictEqual(snapshot.agents[0]!.designWorkspaces);

    await new AppStateStore(home).save(loaded);
    expect(await designFiles()).toStrictEqual(['design-launch.json', 'design-pricing.json']);
    expect(await readFile(file('roster.json'), 'utf8')).not.toContain('Hello');
  });

  it('refuses to start, rather than drop it, when a design roster.json names is missing', async () => {
    await new AppStateStore(home).save(snapshotWithDesigns());
    await rm(file('designs', 'design-pricing.json'));

    await expect(load()).rejects.toThrowError(StoreFormatError);
    await expect(load()).rejects.toThrowError('design-pricing');
  });
});
