import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveClaudeLaunch } from '../claude-command';
import { createClaudeLifecycle } from '../provider-lifecycle';
import { createTestSnapshot } from '../../__tests__/server-test-fixtures';

const host = vi.hoisted(() => ({ files: new Set<string>() }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), existsSync: (file: string) => host.files.has(file) }));
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  execFileSync: () => '__APP_RUNTIME_PATH_START__/user/bin__APP_RUNTIME_PATH_END__',
}));

afterEach(() => { vi.unstubAllEnvs(); host.files.clear(); });

describe('Claude runtime selection', () => {
  // Missing PATH and stale overrides must not produce contradictory installed/launch
  // observations or select another installation.
  it.each([
    { name: 'prefers the installed CLI', files: ['/user/bin/claude'], configured: '', selected: '/user/bin/claude', installed: true },
    { name: 'reports missing without a CLI on PATH', files: [], configured: '', selected: 'claude', installed: false },
    { name: 'honors an explicit override', files: ['/custom/claude', '/user/bin/claude'], configured: '/custom/claude', selected: '/custom/claude', installed: true },
    { name: 'does not hide a broken override', files: ['/user/bin/claude'], configured: '/missing/claude', selected: '/missing/claude', installed: false },
  ])('$name', ({ files, configured, selected, installed }) => {
    host.files = new Set(files);
    vi.stubEnv('APP_CLAUDE_COMMAND', configured);
    vi.stubEnv('APP_ASSETS_PATH', '/app/resources');
    vi.stubEnv('PATH', '/user/bin');
    expect(createClaudeLifecycle().installed(createTestSnapshot())).toBe(installed);
    const launch = resolveClaudeLaunch();
    expect(launch.command).toBe(selected);
    expect(launch.env.PATH).toBe('/user/bin');
  });
});


it('prefers an explicit caller command over the Korus environment override', () => {
  vi.stubEnv('APP_CLAUDE_COMMAND', '/environment/claude');
  host.files = new Set(['/caller/claude', '/environment/claude']);
  expect(resolveClaudeLaunch('/caller/claude').command).toBe('/caller/claude');
});
