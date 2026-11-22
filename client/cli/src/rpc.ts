import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { LineFramer } from '@workspace/core/backend-protocol/line-framer';
import { CliError, record, type CliOptions } from './context';

const maxReplyBytes = 32 * 1024 * 1024;

/** A bounded one-shot connection; diagnostics never start or repair the daemon. */
export function request(options: Pick<CliOptions, 'socket' | 'timeout' | 'signal'>, method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason); return; }
    const id = randomUUID(); const framer = new LineFramer(); let settled = false;
    const socket = net.createConnection(options.socket);
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new CliError(`Daemon request timed out (${method}).`)), options.timeout);
    const abort = () => finish(options.signal?.reason ?? new CliError('Cancelled.', 130));
    options.signal?.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`));
    socket.once('error', () => finish(new CliError(`Daemon socket unavailable at ${options.socket}.`)));
    socket.once('close', () => finish(new CliError('Daemon closed the connection before replying.')));
    socket.on('data', (chunk: Buffer) => {
      if (framer.pendingBytes + chunk.length > maxReplyBytes) { finish(new CliError('Daemon response exceeded the CLI size limit.')); return; }
      for (const line of framer.push(chunk)) {
        let reply: unknown;
        try { reply = JSON.parse(line); } catch { finish(new CliError('Daemon returned malformed JSON.')); return; }
        if (!record(reply)) continue;
        if ('method' in reply && 'id' in reply) {
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: reply.id, error: { code: -32601, message: 'This CLI cannot handle desktop requests.' } })}\n`); continue;
        }
        if (reply.id !== id) continue;
        if (record(reply.error)) { finish(new CliError(typeof reply.error.message === 'string' ? reply.error.message : 'Daemon rejected the request.')); return; }
        if (!('result' in reply)) { finish(new CliError('Daemon returned an invalid response.')); return; }
        finish(undefined, reply.result); return;
      }
    });
  });
}
