import { backendMethods } from '@workspace/core/backend-protocol/methods';
import { appRpcErrorCodes, createAppRpcError, createAppRpcResult, isAppRpcRequest, type AppRpcId, type AppRpcMessage } from '@workspace/core/backend-protocol/rpc';
import type { StoreRecovery } from '@workspace/core/contracts';
import { StoreFormatError } from './persistence/store-format';
import { restoreStoreBackup, storeRecovery } from './persistence/store-recovery';

type Handler = (message: AppRpcMessage) => unknown;

/**
 * What the daemon answers while its home cannot be opened: every request learns why and which backup could replace
 * the file at fault. Restoring that backup starts the daemon; from then on its requests go to the daemon.
 */
export class StoreRecoveryServer {
  private started: Handler | null = null;

  private constructor(private readonly home: string, private recovery: StoreRecovery, private readonly start: () => Promise<Handler>) {}

  static async open(home: string, error: StoreFormatError, start: () => Promise<Handler>): Promise<StoreRecoveryServer> {
    return new StoreRecoveryServer(home, await storeRecovery(home, error), start);
  }

  async handle(message: AppRpcMessage): Promise<unknown> {
    if (this.started) return this.started(message);
    if (!isAppRpcRequest(message)) return null;
    if (message.method !== backendMethods.storeRestoreBackup) return this.unavailable(message.id);
    const params = message.params as { backup?: unknown } | undefined;
    try {
      await restoreStoreBackup(this.home, this.recovery, typeof params?.backup === 'string' ? params.backup : '');
      this.started = await this.start();
      return createAppRpcResult(message.id, { restored: true });
    } catch (error) {
      if (!(error instanceof StoreFormatError)) return createAppRpcError(message.id, appRpcErrorCodes.internalError, error instanceof Error ? error.message : String(error));
      this.recovery = await storeRecovery(this.home, error);
      return this.unavailable(message.id);
    }
  }

  private unavailable(id: AppRpcId) {
    return createAppRpcError(id, appRpcErrorCodes.storeUnavailable, this.recovery.message, this.recovery);
  }
}
