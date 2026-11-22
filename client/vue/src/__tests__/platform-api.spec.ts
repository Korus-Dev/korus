import { product } from '@workspace/core/product';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElMessageBox } from 'element-plus';
import { desktopAppHostCapabilities, webAppHostCapabilities } from '@workspace/core/client';
import type { AppApi, MainToRendererEvent } from '@workspace/core/contracts';
import {
  CHATGPT_PLUGINS_URL,
  CODEX_APP_DEEP_LINK,
  appApi,
  appClientPlatform,
  appHostCapabilities,
  appPlatformActions,
  configureAppClient,
} from '../platform-api';

describe(`${product.name} renderer platform profiles`, () => {
  afterEach(() => {
    configureAppClient(undefined);
    vi.restoreAllMocks();
  });

  it('subscribes to host events once and hands each event to every listener of the app', () => {
    let deliver!: (event: MainToRendererEvent) => void;
    const unsubscribeHost = vi.fn();
    const hostOnEvent = vi.fn((listener: (event: MainToRendererEvent) => void) => { deliver = listener; return unsubscribeHost; });
    // The desktop exposes a frozen API; the app must share the subscription without changing it.
    const getSnapshotState = vi.fn();
    configureAppClient({ api: Object.freeze({ onEvent: hostOnEvent, getSnapshotState }) as unknown as AppApi, platform: 'desktop' });
    expect(appApi!.getSnapshotState).toBe(getSnapshotState);
    // A copy of the API, as a panel makes to add to it, keeps the host's methods and the shared subscription.
    expect({ ...appApi! }).toStrictEqual({ onEvent: appApi!.onEvent, getSnapshotState });
    expect('getSnapshotState' in appApi!).toBe(true);
    const first = vi.fn();
    const second = vi.fn();
    const event = { seq: 1, source: 'provider', type: 'agent.statusChanged', agentId: 'agent-1', payload: { type: 'working' }, occurredAt: '2026-11-02T00:00:00.000Z' } as MainToRendererEvent;

    const stopFirst = appApi!.onEvent(first);
    const stopSecond = appApi!.onEvent(second);
    deliver(event);

    // One host subscription, however many listeners: the host copies each event once per subscription.
    expect(hostOnEvent).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledExactlyOnceWith(event);
    expect(second).toHaveBeenCalledExactlyOnceWith(event);

    stopFirst();
    deliver(event);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    expect(unsubscribeHost).not.toHaveBeenCalled();

    stopSecond();
    expect(unsubscribeHost).toHaveBeenCalledOnce();
    appApi!.onEvent(first);
    expect(hostOnEvent).toHaveBeenCalledTimes(2);
  });

  it('treats every subscription as its own, even for the same listener', () => {
    let deliver!: (event: MainToRendererEvent) => void;
    configureAppClient({ api: Object.freeze({ onEvent: (listener: (event: MainToRendererEvent) => void) => { deliver = listener; return () => undefined; } }) as unknown as AppApi, platform: 'desktop' });
    const listener = vi.fn();
    const event = { seq: 1, source: 'provider', type: 'agent.statusChanged', agentId: 'agent-1', payload: { type: 'working' }, occurredAt: '' } as MainToRendererEvent;

    const stopFirst = appApi!.onEvent(listener);
    const stopSecond = appApi!.onEvent(listener);
    deliver(event);
    expect(listener).toHaveBeenCalledTimes(2);

    stopFirst();
    deliver(event);
    expect(listener).toHaveBeenCalledTimes(3);

    // Stopping a subscription again, after the same listener subscribed anew, leaves the new one alone.
    stopSecond();
    appApi!.onEvent(listener);
    stopFirst();
    stopSecond();
    deliver(event);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('still hands an event to the other listeners when one of them fails', () => {
    let deliver!: (event: MainToRendererEvent) => void;
    configureAppClient({ api: { onEvent: (listener: (event: MainToRendererEvent) => void) => { deliver = listener; return () => undefined; } } as unknown as AppApi, platform: 'desktop' });
    const later = vi.fn();
    appApi!.onEvent(() => { throw new Error('listener failed'); });
    appApi!.onEvent(later);

    expect(() => deliver({ seq: 1, source: 'provider', type: 'agent.statusChanged', agentId: 'agent-1', payload: { type: 'working' }, occurredAt: '' } as MainToRendererEvent)).toThrow('listener failed');

    expect(later).toHaveBeenCalledOnce();
  });

  it('owns the desktop profile and launches ChatGPT through the desktop API', async () => {
    const launchChatGptApp = vi.fn().mockResolvedValue({ status: 'launched' });
    configureAppClient({
      api: { launchChatGptApp } as unknown as AppApi,
      platform: 'desktop',
    });

    expect(appClientPlatform).toBe('desktop');
    expect(appHostCapabilities).toBe(desktopAppHostCapabilities);
    await appPlatformActions.launchChatGpt();
    await appPlatformActions.managePlugins();
    expect(launchChatGptApp).toHaveBeenCalledTimes(2);
  });

  it('asks before quitting and relaunching an existing ChatGPT instance', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never);
    const launchChatGptApp = vi.fn()
      .mockResolvedValueOnce({ status: 'alreadyRunning' })
      .mockResolvedValueOnce({ status: 'launched' });
    configureAppClient({
      api: { launchChatGptApp } as unknown as AppApi,
      platform: 'desktop',
    });

    await appPlatformActions.launchChatGpt();

    expect(confirm).toHaveBeenCalledWith(
      `ChatGPT is already open. ${product.name} needs to relaunch it with ${product.name}’s isolated Codex home.`,
      'Quit and relaunch ChatGPT?',
      expect.objectContaining({
        cancelButtonText: 'Cancel',
        confirmButtonText: 'Quit and relaunch',
        type: 'warning',
      }),
    );
    expect(launchChatGptApp).toHaveBeenNthCalledWith(1);
    expect(launchChatGptApp).toHaveBeenNthCalledWith(2, { quitRunning: true });
  });

  it('leaves an existing ChatGPT instance running when relaunch is canceled', async () => {
    vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue(new Error('cancel'));
    const launchChatGptApp = vi.fn().mockResolvedValue({ status: 'alreadyRunning' });
    configureAppClient({
      api: { launchChatGptApp } as unknown as AppApi,
      platform: 'desktop',
    });

    await appPlatformActions.launchChatGpt();

    expect(launchChatGptApp).toHaveBeenCalledOnce();
    expect(launchChatGptApp).toHaveBeenCalledWith();
  });

  it('owns the web profile and opens plugin management on ChatGPT web', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    configureAppClient({ api: {} as AppApi, platform: 'web' });

    expect(appClientPlatform).toBe('web');
    expect(appHostCapabilities).toBe(webAppHostCapabilities);
    expect(appPlatformActions.launchChatGpt).toBeTypeOf('function');
    expect(CODEX_APP_DEEP_LINK).toBe('codex://');
    await appPlatformActions.managePlugins();
    expect(open).toHaveBeenCalledWith(CHATGPT_PLUGINS_URL, '_blank', 'noopener,noreferrer');
  });
});
