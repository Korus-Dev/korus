import type { MissionTicket } from '@workspace/core/missions';
import type { MissionRun } from '@workspace/core/mission-execution';

export type MissionImplementationTicketItem = { ticket: MissionTicket; index: number; run?: MissionRun };
export type MissionImplementationTicketStatus = 'queued' | 'blocked' | MissionRun['status'];

/**
 * Each ticket with its latest implementation run of the same revision. A run names its ticket by id or, when saved
 * without one, by position. The runs are read once, in order, so a later run replaces an earlier one however it matched.
 */
export function implementationTicketItems(tickets: readonly MissionTicket[], runs: readonly MissionRun[]): MissionImplementationTicketItem[] {
  const revisions: number[] = [];
  const positionsById = new Map<string, number[]>();
  tickets.forEach((ticket, index) => {
    revisions[index] = ticket.revision ?? 0;
    if (!ticket.id) return;
    const positions = positionsById.get(ticket.id);
    if (positions) positions.push(index); else positionsById.set(ticket.id, [index]);
  });
  const latest: (MissionRun | undefined)[] = [];
  runs.forEach((run) => {
    if (run.stage !== 'implementation') return;
    const positions = run.ticketId ? positionsById.get(run.ticketId) ?? [] : typeof run.ticketIndex === 'number' ? [run.ticketIndex] : [];
    for (const index of positions) if ((run.ticketRevision ?? 0) === revisions[index]) latest[index] = run;
  });
  return tickets.map((ticket, index) => ({ ticket, index, run: latest[index] }));
}

export function implementationTicketStatus(
  item: MissionImplementationTicketItem,
  tickets: readonly MissionTicket[],
): MissionImplementationTicketStatus {
  if (item.ticket.done) return 'accepted';
  if (item.run) return item.run.status;
  return (item.ticket.dependsOn ?? []).every(index => tickets[index]?.done) ? 'queued' : 'blocked';
}

export function missionTicketNumber(index: number): string {
  return String(index + 1).padStart(2, '0');
}

export function missionRepositoryName(repositoryPath: string): string {
  return repositoryPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? repositoryPath;
}

export function missionTicketPreview(ticket: MissionTicket, fallback: string): string {
  return ticket.body
    ?.replace(/```[\s\S]*?```/gu, ' ')
    .replace(/[*_~`>|#]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim() || fallback;
}
