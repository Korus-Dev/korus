import { computed, ref, watch } from 'vue';
import type { Agent } from '@workspace/core/contracts';
import { projectActivitySidebar, projectWorktreeSidebar, type WorkspaceSidebarGroup, type SidebarActivity } from '@workspace/core/workspace-sidebar';

export type DesktopSidebarActivity = SidebarActivity | 'pinned';
export type SidebarGroup = WorkspaceSidebarGroup & { activity?: DesktopSidebarActivity };

export function useAgentSidebarOrganization(options: {
  teamId: () => string | null | undefined;
  agents: () => Agent[];
  repositoryGroups: () => WorkspaceSidebarGroup[];
  featureLabels?: () => Readonly<Record<string, string>> | undefined;
  featureOrder?: () => readonly string[] | undefined;
  label: (activity: DesktopSidebarActivity) => string;
  activityOnly?: () => boolean;
}) {
  const mode = ref<'repository' | 'activity' | 'worktree'>('repository');
  const idleSort = ref<'activity' | 'repository'>('activity');
  const now = ref(Date.now());
  const collapsedGroups = ref<DesktopSidebarActivity[]>([]);
  const collapsedKey = () => `app:collapsedActivityGroups:${options.activityOnly?.() ? 'all' : options.teamId() ?? 'default'}`;
  const preferenceKey = () => options.teamId() ? `app:agentOrganization:${options.teamId()}` : null;
  const idleSortKey = () => options.teamId() ? `app:idleAgentSort:${options.teamId()}` : null;
  watch([options.teamId, () => options.activityOnly?.() ?? false], () => {
    try {
      const saved = JSON.parse(localStorage.getItem(collapsedKey()) ?? '[]');
      collapsedGroups.value = Array.isArray(saved) ? saved.filter((value): value is DesktopSidebarActivity => ['pinned', 'attention', 'recent', 'working', 'idle'].includes(value)) : [];
    } catch { collapsedGroups.value = []; }
    if (options.activityOnly?.()) { mode.value = 'activity'; idleSort.value = 'activity'; return; }
    try {
      const saved = localStorage.getItem(preferenceKey() ?? '');
      mode.value = saved === 'activity' || saved === 'worktree' ? saved : 'repository';
      idleSort.value = localStorage.getItem(idleSortKey() ?? '') === 'repository' ? 'repository' : 'activity';
    } catch { mode.value = 'repository'; idleSort.value = 'activity'; }
  }, { immediate: true });
  watch(mode, (value, _, cleanup) => {
    now.value = Date.now();
    if (value !== 'activity') return;
    const timer = setInterval(() => { now.value = Date.now(); }, 1_000);
    cleanup(() => clearInterval(timer));
  }, { immediate: true });

  function select(value: string): void {
    if (options.activityOnly?.() || (value !== 'repository' && value !== 'activity' && value !== 'worktree')) return;
    mode.value = value;
    const key = preferenceKey();
    try { if (key) localStorage.setItem(key, value); } catch { /* Keep the session choice if storage is unavailable. */ }
  }

  const groups = computed<SidebarGroup[]>(() => {
    const repositoryGroups = options.repositoryGroups();
    if (mode.value === 'repository') return repositoryGroups;
    if (mode.value === 'worktree') return projectWorktreeSidebar(repositoryGroups, options.featureLabels?.(), options.featureOrder?.());
    const agents = options.agents();
    const groups = projectActivitySidebar({ agents, repositoryGroups,
      now: Math.max(now.value, Date.now()), label: options.label, idleSort: idleSort.value });
    const pinnedIds = new Set(agents.filter(agent => agent.pinned).map(agent => agent.id));
    if (!pinnedIds.size) return groups;
    const pinned = repositoryGroups.flatMap(group => group.sessions.filter(session => pinnedIds.has(session.agentId)));
    return [
      { id: 'activity:pinned', kind: 'folder', activity: 'pinned', label: options.label('pinned'), sessions: pinned } satisfies SidebarGroup,
      ...groups.map(group => ({ ...group, sessions: group.sessions.filter(session => !pinnedIds.has(session.agentId)) })),
    ].filter(group => group.sessions.length);
  });
  function selectIdleSort(value: string): void {
    if (options.activityOnly?.() || (value !== 'repository' && value !== 'activity')) return;
    idleSort.value = value;
    const key = idleSortKey();
    try { if (key) localStorage.setItem(key, value); } catch { /* Keep the session choice if storage is unavailable. */ }
  }
  function isCollapsed(activity: DesktopSidebarActivity): boolean { return collapsedGroups.value.includes(activity); }
  function toggleGroup(activity: DesktopSidebarActivity): void {
    collapsedGroups.value = isCollapsed(activity) ? collapsedGroups.value.filter(value => value !== activity) : [...collapsedGroups.value, activity];
    try { localStorage.setItem(collapsedKey(), JSON.stringify(collapsedGroups.value)); } catch { /* Retain the session choice. */ }
  }
  return { mode, groups, select, now, idleSort, selectIdleSort, isCollapsed, toggleGroup };
}
