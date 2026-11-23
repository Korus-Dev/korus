import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backendMethods } from '@workspace/core/backend-protocol/methods';
import { appRpcErrorCodes, createAppRpcResult, type AppRpcMessage } from '@workspace/core/backend-protocol/rpc';
import { StoreFormatError } from '../persistence/store-format';
import { StoreRecoveryServer } from '../store-recovery-server';

let home = '';
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'store-recovery-server-'));
  await mkdir(path.join(home, 'backups'));
  await writeFile(path.join(home, 'roster.json'), '{ "schemaVersion": 99, "data": {} }');
  await writeFile(path.join(home, 'backups', 'roster-v8-2026-11-22T10-00-00.000Z.json'), '{ "schemaVersion": 8, "data": {} }');
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const request = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0' as const, id, method, ...(params === undefined ? {} : { params }) });
const newer = () => new StoreFormatError('roster.json uses schema 99; update', 'roster.json', true);

describe('StoreRecoveryServer', () => {
  it('answers every request with what the user can do, restores the offered backup, then hands over to the started daemon', async () => {
    const started = vi.fn(async () => (message: AppRpcMessage) => createAppRpcResult((message as { id: number }).id, 'running'));
    const server = await StoreRecoveryServer.open(home, newer(), started);
    const recovery = { file: 'roster.json', reason: 'newer', message: 'roster.json uses schema 99; update', backup: { name: 'roster-v8-2026-11-22T10-00-00.000Z.json', createdAt: '2026-11-22T10:00:00.000Z' } };

    expect(await server.handle(request(1, backendMethods.backendHealthGet))).toStrictEqual({
      jsonrpc: '2.0', id: 1, error: { code: appRpcErrorCodes.storeUnavailable, message: recovery.message, data: recovery },
    });
    expect(await server.handle(request(2, backendMethods.snapshotGet))).toMatchObject({ error: { code: appRpcErrorCodes.storeUnavailable } });

    expect(await server.handle(request(3, backendMethods.storeRestoreBackup, { backup: recovery.backup.name }))).toStrictEqual(createAppRpcResult(3, { restored: true }));
    expect(await readFile(path.join(home, 'roster.json'), 'utf8')).toBe('{ "schemaVersion": 8, "data": {} }');
    expect(started).toHaveBeenCalledOnce();
    expect(await server.handle(request(4, backendMethods.backendHealthGet))).toStrictEqual(createAppRpcResult(4, 'running'));
  });

  it('keeps offering recovery when the restored home still cannot be opened', async () => {
    const started = vi.fn(async () => { throw new StoreFormatError('settings.json is not valid JSON', 'settings.json'); });
    const server = await StoreRecoveryServer.open(home, newer(), started);

    expect(await server.handle(request(1, backendMethods.storeRestoreBackup, { backup: 'roster-v8-2026-11-22T10-00-00.000Z.json' }))).toMatchObject({
      error: { code: appRpcErrorCodes.storeUnavailable, data: { file: 'settings.json', message: 'settings.json is not valid JSON', backup: null } },
    });
    expect(await server.handle(request(2, backendMethods.backendHealthGet))).toMatchObject({ error: { data: { file: 'settings.json' } } });
  });
});
