import { describe, expect, it } from 'vitest';
import { compactClientSnapshot } from '../compact-snapshot';
import { createInitialSnapshot } from '../snapshot';
import { createMission } from '../missions';
import type { MissionArtifacts, MissionRun } from '../mission-types';

function missionSnapshot() {
  const snapshot = createInitialSnapshot();
  const team = snapshot.teams[0]!;
  const lead = snapshot.agents.find(agent => agent.teamId === team.id)!;
  const mission = createMission(snapshot, { outcome: 'Ship checkout', workflowType: 'shapeAndShipFeature', teamId: team.id, orchestratorMemberId: lead.id });
  const proposal: MissionArtifacts = { ...structuredClone(mission.artifacts), requirements: { problem: 'As submitted', acceptance: 'Then' } };
  const run = (id: string, status: MissionRun['status']): MissionRun => ({
    id, stage: 'requirements', memberId: lead.id, status, skills: [], feedback: '', startedAt: '2026-11-01T00:00:00.000Z', proposal: structuredClone(proposal),
  });
  mission.execution!.runs = [run('accepted', 'accepted'), run('cancelled', 'cancelled'), run('failed', 'failed'), run('awaiting', 'awaitingReview'), run('running', 'running'), run('preparing', 'preparing')];
  return { snapshot, mission, lead, proposal };
}

describe('compactClientSnapshot', () => {
  it('keeps the proposal of runs still in progress or awaiting review and drops it from finished runs', () => {
    const { snapshot, proposal } = missionSnapshot();

    const runs = compactClientSnapshot(snapshot).missions![0]!.execution!.runs;

    expect(runs.map(run => [run.id, run.proposal])).toStrictEqual([
      ['accepted', undefined], ['cancelled', undefined], ['failed', undefined],
      ['awaiting', proposal], ['running', proposal], ['preparing', proposal],
    ]);
    expect(runs[0]).not.toHaveProperty('proposal');
  });

  it('leaves the snapshot it was given untouched and shares everything it did not change', () => {
    const { snapshot, mission } = missionSnapshot();
    const other = createMission(snapshot, { outcome: 'Untouched', workflowType: 'shapeAndShipFeature', teamId: mission.teamId, orchestratorMemberId: snapshot.agents[0]!.id });
    const before = structuredClone(snapshot);

    const compact = compactClientSnapshot(snapshot);

    expect(snapshot).toStrictEqual(before);
    expect(compact.agents).toBe(snapshot.agents);
    expect(compact.turnGitDiffs).toBe(snapshot.turnGitDiffs);
    expect(compact.missions![1]).toBe(other);
    expect(compactClientSnapshot(createInitialSnapshot())).toStrictEqual(createInitialSnapshot());
  });
});
