import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInitialSnapshot } from '@workspace/core/snapshot';
import type { AgentSubagentTree } from '@workspace/core/contracts';
import { AppStateStore } from '../store';
import { AppBackendServer } from '../../server';
import { backendMethods } from '@workspace/core/backend-protocol/methods';

let home = '';
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), 'roster-contents-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const rosterPath = () => path.join(home, 'roster.json');
type Roster = { schemaVersion: number; data: { subagents?: unknown; agents: Array<{ id: string; subagents?: unknown; pinned?: boolean }> } };
const readRoster = async () => JSON.parse(await readFile(rosterPath(), 'utf8')) as Roster;

const tree = (root: string): AgentSubagentTree => ({
  rootConversationId: root,
  nodes: { [`${root}-child`]: { conversationId: `${root}-child`, parentConversationId: root, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:01:00.000Z',
    status: 'completed', agentNickname: 'Scout', agentRole: 'explorer', prompt: 'Look around', model: 'gpt' } as AgentSubagentTree['nodes'][string] },
  operations: {}, activities: {},
});

describe('What roster.json keeps', () => {
  it('pins and unpins one agent using the existing roster schema', async () => {
    const store = new AppStateStore(home);
    const snapshot = createInitialSnapshot();
    const [agent, other] = snapshot.agents;
    await store.save(snapshot);
    const before = await readRoster();
    expect(before.data.agents.filter(item => item.pinned)).toStrictEqual([]);
    const server = new AppBackendServer({ version: 'test', snapshot: await store.load(), saveSnapshot: value => store.save(value) });
    const update = (pinned: boolean) => server.handleMessage({
      jsonrpc: '2.0', id: 'pin', method: backendMethods.agentUpdate, params: { input: { id: agent!.id, pinned } },
    });
    try {
      await update(true);
      const pinned = await readRoster();
      expect(pinned.schemaVersion).toBe(before.schemaVersion);
      expect(pinned.data.agents.find(item => item.id === agent!.id)?.pinned).toBe(true);
      expect(pinned.data.agents.find(item => item.id === other!.id)?.pinned).toBeUndefined();
      expect((await new AppStateStore(home).load()).agents.find(item => item.id === agent!.id)?.pinned).toBe(true);

      await update(false);
      expect((await readRoster()).data.agents.find(item => item.id === agent!.id)?.pinned).toBeUndefined();
      expect((await new AppStateStore(home).load()).agents.find(item => item.id === agent!.id)?.pinned).toBeUndefined();
    } finally {
      await server.close();
    }
  });
  it('keeps the subagents of an agent on that agent in roster.json', async () => {
    const snapshot = createInitialSnapshot();
    const [parent, other] = snapshot.agents;
    snapshot.subagentTrees = { [parent!.id]: tree('thread-parent') };

    await new AppStateStore(home).save(snapshot);

    const roster = await readRoster();
    expect(roster.data).not.toHaveProperty('subagents');
    // The prompt a subagent was started with is in its conversation; storing it again only grows the roster.
    const { prompt: _prompt, ...stored } = tree('thread-parent').nodes['thread-parent-child']!;
    expect(roster.data.agents.find(agent => agent.id === parent!.id)!.subagents).toStrictEqual({ rootConversationId: 'thread-parent', nodes: { 'thread-parent-child': stored } });
    expect(roster.data.agents.find(agent => agent.id === other!.id)).not.toHaveProperty('subagents');
    expect((await new AppStateStore(home).load()).subagentTrees).toStrictEqual({ [parent!.id]: { ...tree('thread-parent'), nodes: { 'thread-parent-child': stored } } });
  });

  it('reads the subagents of a roster that kept them beside the agents', async () => {
    const snapshot = createInitialSnapshot();
    const parent = snapshot.agents[0]!;
    await new AppStateStore(home).save(snapshot);
    const roster = await readRoster();
    roster.data.subagents = { [parent.id]: { rootConversationId: 'thread-parent', nodes: tree('thread-parent').nodes } };
    await writeFile(rosterPath(), JSON.stringify(roster));

    const { prompt: _prompt, ...stored } = tree('thread-parent').nodes['thread-parent-child']!;
    expect((await new AppStateStore(home).load()).subagentTrees).toStrictEqual({ [parent.id]: { ...tree('thread-parent'), nodes: { 'thread-parent-child': stored } } });
  });

  it('never stores a handoff: it only matters while it runs, and its note becomes the first prompt of the new conversation', async () => {
    const snapshot = createInitialSnapshot();
    snapshot.agents[0]!.handoff = { operationId: 'handoff-1', selection: { provider: 'codex', model: null, reasoningEffort: null, serviceTier: null },
      sourceAgentId: 'agent-source', sourceTitle: 'Source', sourceRef: { provider: 'codex', conversationId: 'thread-source' }, phase: 'starting', note: 'Carry on with the billing work.' };

    await new AppStateStore(home).save(snapshot);

    expect(JSON.stringify((await readRoster()).data)).not.toContain('handoff');
  });

  it('stores a plan review only while it waits for the user or for a revision', async () => {
    const snapshot = createInitialSnapshot();
    const review = (status: 'pending' | 'revise' | 'accept' | 'cancel') => ({ id: `review-${status}`, conversationId: 'thread', turnId: 'turn', markdown: '# Plan', status, history: [] });
    const statuses = ['pending', 'revise', 'accept', 'cancel'] as const;
    const agents = statuses.map((status, index) => ({ ...structuredClone(snapshot.agents[0]!), id: `agent-review-${index}`, planReview: review(status) as never }));
    snapshot.agents.push(...agents);
    snapshot.teams[0]!.agentIds.push(...agents.map(agent => agent.id));

    await new AppStateStore(home).save(snapshot);

    const stored = (await readRoster()).data.agents as Array<{ id: string; planReview?: { status: string } }>;
    expect(agents.map(agent => stored.find(candidate => candidate.id === agent.id)!.planReview?.status)).toStrictEqual(['pending', 'revise', undefined, undefined]);
  });

  it('never stores account rate limits: the provider reports current ones, and a saved copy can only be stale', async () => {
    const snapshot = createInitialSnapshot();
    snapshot.providerAccountRateLimits = { codex: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_800_000_000 } } as never };

    await new AppStateStore(home).save(snapshot);

    expect((await readRoster()).data).not.toHaveProperty('accountRateLimits');
    expect((await new AppStateStore(home).load()).providerAccountRateLimits).toBeUndefined();
  });
});
