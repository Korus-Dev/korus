import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { AppBackendSocketClient } from '../backend-socket-client';

describe('AppBackendSocketClient', () => {
  it('rejects pending requests on close and bounds shutdown when the socket never acknowledges it', async () => {
    vi.useFakeTimers();
    try {
      const socket = createFakeSocket();
      socket.end.mockImplementation(() => socket);
      const connectSocket = vi.fn().mockReturnValue(socket);
      const client = new AppBackendSocketClient({ socketPath: '/test/daemon.sock', connectSocket });
      const starting = client.start();
      socket.emit('connect');
      await starting;
      await client.start();
      expect(connectSocket).toHaveBeenCalledOnce();
      const request = client.request('snapshot/get');
      const rejected = expect(request).rejects.toThrow('client closed');
      let closed = false;
      const closing = client.close().then(() => { closed = true; });
      await rejected;
      await vi.advanceTimersByTimeAsync(999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(socket.end).toHaveBeenCalledOnce();
      await expect(client.request('snapshot/get')).rejects.toThrow('not connected');
      await client.close();
      expect(socket.end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects failed connections and ignores late close events from a replaced socket', async () => {
    const first = createFakeSocket();
    const second = createFakeSocket();
    const client = new AppBackendSocketClient({
      socketPath: '/test/daemon.sock',
      connectSocket: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    });
    const listener = vi.fn();
    client.onConnectionState(listener);
    const starting = client.start();
    first.emit('error', new Error('connection refused'));
    await expect(starting).rejects.toThrow('connection refused');
    const reconnect = client.start();
    second.emit('connect');
    await reconnect;
    listener.mockClear();
    first.emit('close');
    expect(listener).not.toHaveBeenCalled();
    await client.close();
    expect(second.end).toHaveBeenCalledOnce();
  });

  it('sends backend health over the socket and resolves the response', async () => {
    const socket = createFakeSocket();
    const client = new AppBackendSocketClient({
      socketPath: '/tmp/daemon.sock',
      connectSocket: vi.fn().mockReturnValue(socket),
    });

    const startPromise = client.start();
    socket.emit('connect');
    await startPromise;
    const healthPromise = client.health();
    const request = JSON.parse(socket.writes[0]);
    socket.writeFromServer(`${JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        ok: true,
        name: 'daemon',
        version: '0.1.0',
        pid: 123,
      },
    })}\n`);

    await expect(healthPromise).resolves.toStrictEqual({
      ok: true,
      name: 'daemon',
      version: '0.1.0',
      pid: 123,
    });
  });

  it('emits backend event notifications from the socket', async () => {
    const socket = createFakeSocket();
    const client = new AppBackendSocketClient({
      socketPath: '/tmp/daemon.sock',
      connectSocket: vi.fn().mockReturnValue(socket),
    });
    const listener = vi.fn();

    const startPromise = client.start();
    socket.emit('connect');
    await startPromise;
    client.onEvent(listener);
    socket.writeFromServer(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'backend/event/notify',
      params: {
        seq: 1,
        provider: 'codex' as const, type: 'provider.statusChanged',
        payload: { provider: 'codex' as const, status: 'running' },
        occurredAt: '2026-06-14T00:00:00.000Z',
      },
    })}\n`);

    expect(listener).toHaveBeenCalledWith({
      seq: 1,
      provider: 'codex' as const, type: 'provider.statusChanged',
      payload: { provider: 'codex' as const, status: 'running' },
      occurredAt: '2026-06-14T00:00:00.000Z',
    });
  });

  it('keeps response text intact when socket reads split it inside multi-byte characters', async () => {
    const socket = createFakeSocket();
    const client = new AppBackendSocketClient({ socketPath: '/tmp/daemon.sock', connectSocket: vi.fn().mockReturnValue(socket) });
    const starting = client.start();
    socket.emit('connect');
    await starting;
    const result = { note: 'résumé — naïve façade 😀 '.repeat(12) };

    const response = client.request('snapshot/get');
    const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(socket.writes[0]).id, result })}\n`);
    // Seven-byte reads cut the two-, three- and four-byte characters at every possible position.
    for (let offset = 0; offset < frame.length; offset += 7) socket.writeFromServer(frame.subarray(offset, offset + 7));

    await expect(response).resolves.toStrictEqual(result);
  });

  it('delivers frames that share a read and finishes one left incomplete by it', async () => {
    const socket = createFakeSocket();
    const client = new AppBackendSocketClient({ socketPath: '/tmp/daemon.sock', connectSocket: vi.fn().mockReturnValue(socket) });
    const starting = client.start();
    socket.emit('connect');
    await starting;
    const events = vi.fn();
    client.onEvent(events);
    const event = (seq: number) => ({
      seq, provider: 'codex' as const, type: 'provider.statusChanged',
      payload: { provider: 'codex' as const, status: 'running' }, occurredAt: '2026-06-14T00:00:00.000Z',
    });
    const notification = (seq: number) => `${JSON.stringify({ jsonrpc: '2.0', method: 'backend/event/notify', params: event(seq) })}\n`;

    const response = client.request('snapshot/get');
    const reply = `${JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(socket.writes[0]).id, result: { ok: true } })}\n`;
    const unfinished = notification(3);
    socket.writeFromServer(`${notification(1)}${reply}${notification(2)}${unfinished.slice(0, 40)}`);

    await expect(response).resolves.toStrictEqual({ ok: true });
    expect(events.mock.calls).toStrictEqual([[event(1)], [event(2)]]);

    socket.writeFromServer(unfinished.slice(40));

    expect(events.mock.calls).toStrictEqual([[event(1)], [event(2)], [event(3)]]);
  });

  it('stops delivering the frames of a read once a listener closes the client', async () => {
    const socket = createFakeSocket();
    const client = new AppBackendSocketClient({ socketPath: '/tmp/daemon.sock', connectSocket: vi.fn().mockReturnValue(socket) });
    const starting = client.start();
    socket.emit('connect');
    await starting;
    const seen: number[] = [];
    client.onEvent((event) => {
      seen.push(event.seq);
      void client.close();
    });
    const notification = (seq: number) => `${JSON.stringify({
      jsonrpc: '2.0', method: 'backend/event/notify',
      params: { seq, provider: 'codex', type: 'provider.statusChanged', payload: { provider: 'codex', status: 'running' }, occurredAt: '2026-06-14T00:00:00.000Z' },
    })}\n`;

    socket.writeFromServer(`${notification(1)}${notification(2)}`);

    expect(seen).toStrictEqual([1]);
  });

  it('discards a frame cut short by a lost connection before reading the next connection', async () => {
    const firstSocket = createFakeSocket();
    const secondSocket = createFakeSocket();
    const client = new AppBackendSocketClient({
      socketPath: '/tmp/daemon.sock',
      connectSocket: vi.fn().mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket),
    });
    const firstStart = client.start();
    firstSocket.emit('connect');
    await firstStart;
    firstSocket.writeFromServer('{"jsonrpc":"2.0","method":"backend/event/notify","params":{"seq":1,');
    firstSocket.emit('close');
    const secondStart = client.start();
    secondSocket.emit('connect');
    await secondStart;

    const response = client.request('snapshot/get');
    secondSocket.writeFromServer(`${JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(secondSocket.writes[0]).id, result: { ok: true } })}\n`);

    await expect(response).resolves.toStrictEqual({ ok: true });
  });

  it('handles backend-initiated client requests over the socket', async () => {
    const socket = createFakeSocket();
    const openExternal = vi.fn().mockResolvedValue(true);
    const client = new AppBackendSocketClient({
      socketPath: '/tmp/daemon.sock',
      connectSocket: vi.fn().mockReturnValue(socket),
      requestHandlers: {
        'client/external/open': openExternal,
      },
    });

    const startPromise = client.start();
    socket.emit('connect');
    await startPromise;
    socket.writeFromServer(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 'client-1',
      method: 'client/external/open',
      params: { url: 'https://example.com' },
    })}\n`);
    await flushMicrotasks();

    expect(openExternal).toHaveBeenCalledWith({ url: 'https://example.com' });
    expect(JSON.parse(socket.writes[0])).toStrictEqual({
      jsonrpc: '2.0',
      id: 'client-1',
      result: true,
    });
  });

  it('reports disconnects and can reconnect using a fresh socket', async () => {
    const firstSocket = createFakeSocket();
    const secondSocket = createFakeSocket();
    const connectSocket = vi.fn()
      .mockReturnValueOnce(firstSocket)
      .mockReturnValueOnce(secondSocket);
    const client = new AppBackendSocketClient({ socketPath: '/tmp/daemon.sock', connectSocket });
    const connectionListener = vi.fn();
    client.onConnectionState(connectionListener);

    const firstStart = client.start();
    firstSocket.emit('connect');
    await firstStart;
    firstSocket.emit('close');

    expect(connectionListener).toHaveBeenNthCalledWith(1, 'connected', undefined);
    expect(connectionListener).toHaveBeenNthCalledWith(2, 'disconnected', expect.any(Error));

    const secondStart = client.start();
    secondSocket.emit('connect');
    await secondStart;
    expect(connectionListener).toHaveBeenNthCalledWith(3, 'connected', undefined);
    expect(connectSocket).toHaveBeenCalledTimes(2);
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

function createFakeSocket() {
  const stream = new PassThrough();
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const socket = Object.assign(stream, {
    destroyed: false,
    writes: [] as string[],
    destroy: vi.fn(() => {
      socket.destroyed = true;
      socket.emit('close');
      return socket;
    }),
    end: vi.fn(() => {
      socket.destroyed = true;
      socket.emit('close');
      return socket;
    }),
    write: vi.fn((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      socket.writes.push(chunk.toString());
      callback?.();
      return true;
    }),
    writeFromServer: (chunk: string | Uint8Array) => {
      stream.emit('data', Buffer.from(chunk));
    },
    once: (event: string, listener: (...args: unknown[]) => void) => {
      const onceListener = (...args: unknown[]) => {
        socket.off(event, onceListener);
        listener(...args);
      };
      socket.on(event, onceListener);
      return socket;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return socket;
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
      return socket;
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
      return true;
    },
  });
  return socket;
}
