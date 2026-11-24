import { resolveRuntimeExecutable, resolveRuntimeLaunch, type RuntimeDiscoveryDependencies } from '@workspace/core/runtime-discovery';

/** Claude runs from the CLI on the user's PATH, or an explicit override; Korus ships none of its own. */
export function resolveClaudeLaunch(configuredPath?: string, overrides?: NodeJS.ProcessEnv, dependencies: RuntimeDiscoveryDependencies = {}) {
  const configured = configuredPath?.trim() || process.env.APP_CLAUDE_COMMAND?.trim();
  return resolveRuntimeLaunch(configured || 'claude', overrides, dependencies);
}
export function resolveClaudeExecutable() { return resolveRuntimeExecutable(resolveClaudeLaunch().command); }
