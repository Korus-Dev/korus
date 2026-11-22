import { compactClientSnapshot } from '../compact-snapshot';
import type { AppSnapshot } from '../contracts';
import { backendMethods } from './methods';
import { isAppRpcNotification, isAppRpcResponse, type AppRpcMessage, type ClientWireConfiguration } from './rpc';

type WireRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is WireRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Recognizes a snapshot by the parts every snapshot has, without walking it. */
function looksLikeSnapshot(value: unknown): value is AppSnapshot {
  return isRecord(value) && Array.isArray(value.teams) && Array.isArray(value.agents) && isRecord(value.turnGitDiffs);
}

export function readClientWireConfiguration(params: unknown): ClientWireConfiguration {
  return { snapshots: isRecord(params) && params.snapshots === 'compact' ? 'compact' : 'complete' };
}

/**
 * The message as a client that asked for compact snapshots receives it. Snapshots travel as results, inside results,
 * as the payload of `snapshot.updated` and beside other events. A message that carries none of these is returned as
 * it is.
 */
export function compactWireMessage(message: AppRpcMessage): AppRpcMessage {
  if (isAppRpcResponse(message)) {
    if (!('result' in message)) return message;
    const result = compactResult(message.result);
    return result === message.result ? message : { ...message, result };
  }
  if (!isAppRpcNotification(message) || message.method !== backendMethods.backendEventNotify || !isRecord(message.params)) return message;
  const event = compactEvent(message.params);
  return event === message.params ? message : { ...message, params: event };
}

function compactResult(result: unknown): unknown {
  if (looksLikeSnapshot(result)) return compactClientSnapshot(result);
  if (isRecord(result) && looksLikeSnapshot(result.snapshot)) {
    const snapshot = compactClientSnapshot(result.snapshot);
    return snapshot === result.snapshot ? result : { ...result, snapshot };
  }
  return result;
}

function compactEvent(event: WireRecord): WireRecord {
  let compact = event;
  if (event.type === 'snapshot.updated' && looksLikeSnapshot(event.payload)) {
    const payload = compactClientSnapshot(event.payload);
    if (payload !== event.payload) compact = { ...compact, payload };
  }
  if (looksLikeSnapshot(event.snapshot)) {
    const snapshot = compactClientSnapshot(event.snapshot);
    if (snapshot !== event.snapshot) compact = { ...compact, snapshot };
  }
  return compact;
}
