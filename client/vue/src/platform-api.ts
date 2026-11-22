
import { translate } from './i18n';
import {
  desktopAppHostCapabilities,
  webAppHostCapabilities,
  type AppClient,
  type AppHostCapabilities,
} from '@workspace/core/client';
import type { AppApi, MainToRendererEvent } from '@workspace/core/contracts';
import { appMessageBox } from './shared/dialog/message-box';

export const CODEX_APP_DEEP_LINK = 'codex://' as const;
export const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins' as const;

export type AppPlatformActions = {
  launchChatGpt(): void | Promise<void>;
  managePlugins(): void | Promise<void>;
  openExternal?: (url: string) => void | Promise<void>;
};

export let appApi: AppApi | undefined;
export let traceConversationLoad = false;
export let appHostCapabilities: Readonly<AppHostCapabilities> = webAppHostCapabilities;
export let appClientPlatform: AppClient['platform'] = 'web';
export let appPlatformActions: Readonly<AppPlatformActions> = webPlatformActions();

export function configureAppClient(client?: AppClient): void {
  appApi = client?.api && withSharedEventSubscription(client.api);
  traceConversationLoad = client?.traceConversationLoad === true;
  appClientPlatform = client?.platform ?? 'web';
  if (client?.platform === 'desktop') {
    appHostCapabilities = desktopAppHostCapabilities;
    appPlatformActions = desktopPlatformActions(client.api);
    return;
  }
  appHostCapabilities = webAppHostCapabilities;
  appPlatformActions = webPlatformActions();
}

/**
 * The host copies an event into the page once for every subscription it holds, whatever the listener reads of it.
 * The app therefore subscribes once and hands that one event to each of its own listeners. They all receive the
 * same object: the app state, which subscribes first, adopts the snapshot an event carries, and the others read
 * the event without changing it. Everything else on the API goes to the host as it is.
 */
function withSharedEventSubscription(api: AppApi): AppApi {
  if (typeof api.onEvent !== 'function') return api;
  // One entry per subscription, as the host keeps them: the same listener may subscribe more than once.
  const subscriptions = new Set<{ listener: (event: MainToRendererEvent) => void }>();
  let unsubscribeHost: (() => void) | undefined;
  const deliver = (event: MainToRendererEvent) => {
    let failure: { error: unknown } | undefined;
    // A listener that fails must not keep the event from the others; the first failure is still reported.
    for (const subscription of [...subscriptions]) {
      try { subscription.listener(event); } catch (error) { failure ??= { error }; }
    }
    if (failure) throw failure.error;
  };
  const onEvent: AppApi['onEvent'] = (listener) => {
    const subscription = { listener };
    subscriptions.add(subscription);
    unsubscribeHost ??= api.onEvent(deliver);
    return () => {
      if (!subscriptions.delete(subscription) || subscriptions.size > 0) return;
      unsubscribeHost?.();
      unsubscribeHost = undefined;
    };
  };
  // The host API is frozen, so it can be neither changed nor proxied directly: a proxy may not answer differently
  // from a frozen target. This one stands in front of an empty object and reads everything but `onEvent` from
  // the host API, including when it is listed or copied.
  return new Proxy({} as AppApi, {
    get: (_target, property) => property === 'onEvent' ? onEvent : Reflect.get(api, property) as unknown,
    has: (_target, property) => Reflect.has(api, property),
    ownKeys: () => Reflect.ownKeys(api),
    getOwnPropertyDescriptor: (_target, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(api, property);
      return descriptor && { ...descriptor, configurable: true, ...(property === 'onEvent' ? { value: onEvent } : {}) };
    },
  });
}

function desktopPlatformActions(api: AppApi | undefined): Readonly<AppPlatformActions> {
  const launchChatGpt = async () => {
    if (typeof api?.launchChatGptApp !== 'function') {
      throw new Error(translate('surface.platform-api.chatGPTCouldNotBeLaunchedFromThisWindow'));
    }
    const result = await api.launchChatGptApp();
    if (result.status !== 'alreadyRunning') return;
    if (!await confirmChatGptRelaunch()) return;
    await api.launchChatGptApp({ quitRunning: true });
  };
  return {
    launchChatGpt,
    managePlugins: launchChatGpt,
    openExternal,
  };
}

async function confirmChatGptRelaunch(): Promise<boolean> {
  try {
    await appMessageBox.confirm(
      translate('surface.platform-api.chatGPTIsAlreadyOpenAppNeedsToRelaunchItWithAppSI'),
      translate('surface.platform-api.quitAndRelaunchChatGPT'),
      {
        cancelButtonText: translate('common.cancel'),
        confirmButtonText: translate('dynamic.misc.quitAndRelaunch'),
        type: 'warning',
      },
    );
    return true;
  } catch {
    return false;
  }
}

function webPlatformActions(): Readonly<AppPlatformActions> {
  return {
    launchChatGpt: () => {
      window.location.assign(CODEX_APP_DEEP_LINK);
    },
    managePlugins: () => openExternal(CHATGPT_PLUGINS_URL),
    openExternal,
  };
}

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}
