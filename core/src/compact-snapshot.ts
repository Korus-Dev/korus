import type { AppSnapshot } from './contracts';
import type { Mission, MissionRun } from './mission-types';

const finishedRunStatuses: ReadonlySet<MissionRun['status']> = new Set(['accepted', 'cancelled', 'failed']);

/**
 * The snapshot as a desktop reads it from one moment to the next: without the bodies it never reads.
 *
 * A finished Mission run loses its proposal. Only a run that is preparing, running or awaiting review has one that is
 * shown or accepted.
 *
 * Nothing is copied that does not change, and the snapshot it is given is left as it is: the daemon keeps every body.
 */
export function compactClientSnapshot(snapshot: AppSnapshot): AppSnapshot {
  const missions = snapshot.missions && mapChanged(snapshot.missions, compactMission);
  return missions === snapshot.missions ? snapshot : { ...snapshot, missions };
}

function compactMission(mission: Mission): Mission {
  const execution = mission.execution;
  if (!execution) return mission;
  const runs = mapChanged(execution.runs, (run) => {
    if (run.proposal === undefined || !finishedRunStatuses.has(run.status)) return run;
    const { proposal: _proposal, ...rest } = run;
    return rest;
  });
  return runs === execution.runs ? mission : { ...mission, execution: { ...execution, runs } };
}

/** Maps `items`, returning the same array when no item changed. */
function mapChanged<T>(items: T[], change: (item: T) => T): T[] {
  let changed: T[] | undefined;
  items.forEach((item, index) => {
    const next = change(item);
    if (next === item) return;
    changed ??= items.slice();
    changed[index] = next;
  });
  return changed ?? items;
}
