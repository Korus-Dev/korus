import { closeAgentInSnapshot, createAgentInSnapshot } from '@workspace/core/agent-manager';
import { resolveAgentProvider } from '@workspace/core/agent-providers';
import { createEntityId } from '@workspace/core/ids';
import type { Agent, AppSnapshot } from '@workspace/core/contracts';
import { createMission, deleteMission, updateMission, type DeleteMissionInput, type Mission } from '@workspace/core/missions';
import { isMissionScreenshotAgent } from './mission-screenshot-fixture';
import type { CreateMissionInput, MissionRepository } from '@workspace/core/mission-types';
import { dropFinishedRunProposals } from '@workspace/core/mission-execution';

/** Serializes mission revisions and publishes them only after durable storage succeeds. */
export class MissionService {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly snapshot: AppSnapshot, private readonly persist: (snapshot: AppSnapshot) => Promise<void>) {}

  createHosted(input: Pick<CreateMissionInput, 'outcome' | 'teamId' | 'workflowType'>, catalog: MissionRepository[]): Promise<Mission> {
    return this.transaction(candidate => {
      const leadId = createEntityId('agent');
      const provider = resolveAgentProvider(candidate);
      if (!candidate.teams.some(team => team.id === input.teamId)) throw new Error('The Mission workspace is unavailable on this host.');
      createAgentInSnapshot(candidate, { name: `Mission lead · ${input.outcome}`, folder: '', teamId: input.teamId, selection: { provider } }, undefined, leadId, { select: false });
      const mission = createMission(candidate, { ...input, orchestratorMemberId: leadId });
      mission.execution!.memberIds = [leadId];
      mission.execution!.repositoryCatalog = catalog;
      return mission;
    }, true);
  }

  mutate(action: 'create' | 'update', input: unknown): Promise<void> {
    return this.transaction(candidate => {
      if (action === 'create') createMission(candidate, input);
      else updateMission(candidate, input);
    });
  }

  change(id: string, mutate: (mission: Mission) => void): Promise<void> {
    return this.changeAsync(id, mission => { mutate(mission); });
  }

  changeAsync<T>(id: string, mutate: (mission: Mission) => T | Promise<T>): Promise<T> {
    return this.transaction(async candidate => {
      const mission = candidate.missions?.find(m => m.id === id);
      if (!mission) throw new Error('Mission not found.');
      const result = await mutate(mission);
      mission.revision++;
      mission.updatedAt = new Date().toISOString();
      return result;
    }, id);
  }

  remove(input: DeleteMissionInput, cleanup: (mission: Mission, agents: Agent[]) => Promise<void>): Promise<void> {
    return this.transaction(async candidate => {
      const mission = deleteMission(candidate, input);
      const workerIds = new Set([...(mission.execution?.runs.flatMap(run => run.workerId ? [run.workerId] : []) ?? []), ...(mission.execution?.deliveries?.map(delivery => delivery.agentId) ?? [])]);
      const retainedWorkerIds = new Set((candidate.missions ?? []).flatMap(other => (
        [...(other.execution?.runs.flatMap(run => run.workerId ? [run.workerId] : []) ?? []), ...(other.execution?.deliveries?.map(delivery => delivery.agentId) ?? [])]
      )));
      const workers = candidate.agents.filter(agent => workerIds.has(agent.id) && !retainedWorkerIds.has(agent.id)
        && (!mission.execution?.debugFixture || isMissionScreenshotAgent(agent)));
      await cleanup(mission, workers);
      for (const worker of workers) closeAgentInSnapshot(candidate, worker.id);
    }, true);
  }

  /**
   * Runs `mutate` on a private copy and publishes it only once it is stored. The copy is the whole snapshot, every
   * mission, or the one mission named by `scope`: a change to one mission does not pay for copying the others.
   */
  private transaction<T>(mutate: (candidate: AppSnapshot) => T | Promise<T>, scope: boolean | string = false): Promise<T> {
    const operation = this.pending.then(async () => {
      const missions = this.snapshot.missions ?? [];
      const candidate = scope === true
        ? structuredClone(this.snapshot)
        : { ...this.snapshot, missions: typeof scope === 'string' ? missions.map(mission => mission.id === scope ? structuredClone(mission) : mission) : structuredClone(missions) };
      const result = await mutate(candidate);
      // What a finished run proposed is never read again; holding it would only grow every save and every snapshot.
      for (const mission of candidate.missions ?? []) if (typeof scope !== 'string' || mission.id === scope) dropFinishedRunProposals(mission);
      await this.persist(candidate);
      if (scope === true) Object.assign(this.snapshot, candidate);
      else this.snapshot.missions = candidate.missions;
      return result;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
