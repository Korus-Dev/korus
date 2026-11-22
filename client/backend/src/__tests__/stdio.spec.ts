import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { startStdioRpcServer, StdioRpcPeer } from '../stdio';
import { backendMethods } from '@workspace/core/backend-protocol/methods';
import { createMission } from '@workspace/core/missions';
import { createInitialSnapshot } from '@workspace/core/snapshot';

describe('stdio JSON-RPC transport', () => {
  it.each([undefined, '0', '1'])('emits conversation timing only for an explicit opt-in (%s)', async flag => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CODEX_APP_SDK_TRACE_CONVERSATION_LOAD', flag);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new StdioRpcPeer({ input, output, onMessage: message => ({ jsonrpc: '2.0', id: 'id' in message ? message.id! : 1, result: {} }) });
    peer.start();
    try {
      const response = once(output, 'data');
      input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: backendMethods.agentConversationLoad, params: { agentId: 'agent-1' } }) + '\n');
      expect(JSON.parse(String((await response)[0])).result).toStrictEqual({});
      const timings = warning.mock.calls.filter(([value]) => String(value).startsWith('[conversation-load]'));
      expect(timings.length > 0).toBe(flag === '1');
    } finally { peer.stop(); warning.mockRestore(); vi.unstubAllEnvs(); }
  });
  it('delivers an unbounded utility result over stdio and rejects pending work on disconnect', async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = new PassThrough();
    const writes: string[] = [];
    output.on('data', chunk => writes.push(chunk.toString()));
    const peer = new StdioRpcPeer({ input, output, onMessage: () => undefined });
    peer.start();
    try {
      const params = { prompt: 'Inspect', cwd: '/repo', timeoutMs: null };
      const result = peer.request(backendMethods.driverTextGenerate, params).then(value => ({ value }), error => ({ error }));
      const request = JSON.parse(writes[0]!);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { text: 'complete' } })}\n`);
      expect(await result).toEqual({ value: { text: 'complete' } });
      const interrupted = expect(peer.request(backendMethods.driverTextGenerate, params)).rejects.toThrow(/stopped|closed/i);
      peer.stop();
      await interrupted;
    } finally { peer.stop(); vi.useRealTimers(); }
  });

  it.each([
    ['client/external/open', undefined, 5000],
    ['client/debug/backend/restart', undefined, 10000],
    ['client/computerUse/execute', undefined, 35000],
    ['client/browser/open', undefined, 35000],
    ['client/mobileSimulator/execute', undefined, 240000],
    ['client/collaboration/call', undefined, 120000],
    ['client/computerUse/execute', 100, 100],
  ] as const)('keeps a bounded deadline for %s (%s)', async (method, requestTimeoutMs, deadline) => {
    vi.useFakeTimers();
    const peer = new StdioRpcPeer({ input: new PassThrough(), output: new PassThrough(), onMessage: () => undefined, requestTimeoutMs });
    peer.start();
    try {
      const result = peer.request(method);
      const assertion = expect(result).rejects.toThrow(`stdio request timed out: ${method}`);
      await vi.advanceTimersByTimeAsync(deadline);
      await assertion;
    } finally { peer.stop(); vi.useRealTimers(); }
  });

  it.each(['client/computerUse/execute', 'client/browser/open', 'client/collaboration/call'])('allows %s to finish beyond five seconds', async (method) => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = new PassThrough();
    const writes: string[] = [];
    output.on('data', (chunk) => writes.push(chunk.toString()));
    const peer = new StdioRpcPeer({ input, output, onMessage: () => undefined });
    peer.start();
    try {
      const settled = vi.fn();
      const result = peer.request(method);
      void result.then(settled, settled);
      await vi.advanceTimersByTimeAsync(16000);
      expect(settled).not.toHaveBeenCalled();
      const request = JSON.parse(writes[0]!);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stateRevision: 5 } })}\n`);
      await expect(result).resolves.toStrictEqual({ stateRevision: 5 });
    } finally {
      peer.stop();
      vi.useRealTimers();
    }
  });

  it('writes one JSON-RPC response per request line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: string[] = [];
    output.on('data', (chunk) => responses.push(chunk.toString()));

    const stop = startStdioRpcServer({
      input,
      output,
      onMessage: (message) => ({
        jsonrpc: '2.0',
        id: 'id' in message ? message.id : null,
        result: { method: 'method' in message ? message.method : 'none' },
      }),
    });

    input.write('{"jsonrpc":"2.0","id":"1","method":"backend/health/get"}\n');
    await Promise.resolve();
    stop();

    expect(responses.join('')).toBe('{"jsonrpc":"2.0","id":"1","result":{"method":"backend/health/get"}}\n');
  });

  it('keeps request text intact when input reads split it inside multi-byte characters', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: string[] = [];
    output.on('data', (chunk) => responses.push(chunk.toString()));
    const stop = startStdioRpcServer({
      input,
      output,
      onMessage: (message) => ({ jsonrpc: '2.0', id: 'id' in message ? message.id : null, result: 'params' in message ? message.params : null }),
    });
    const params = { note: 'résumé — naïve façade 😀 '.repeat(12) };

    try {
      const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'backend/health/get', params })}\n`);
      // Seven-byte reads cut the two-, three- and four-byte characters at every possible position.
      for (let offset = 0; offset < frame.length; offset += 7) input.write(frame.subarray(offset, offset + 7));

      await vi.waitFor(() => expect(responses).toHaveLength(1));
      expect(JSON.parse(responses[0])).toStrictEqual({ jsonrpc: '2.0', id: 1, result: params });
    } finally {
      stop();
    }
  });

  it('answers requests that share a read and finishes one left incomplete by it', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: string[] = [];
    output.on('data', (chunk) => responses.push(chunk.toString()));
    const stop = startStdioRpcServer({
      input,
      output,
      onMessage: (message) => ({ jsonrpc: '2.0', id: 'id' in message ? message.id : null, result: true }),
    });
    const request = (id: number) => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'backend/health/get' })}\n`;
    const answeredIds = () => responses.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).id);

    try {
      input.write(`${request(1)}\n${request(2)}${request(3).slice(0, 20)}`);
      await vi.waitFor(() => expect(answeredIds()).toStrictEqual([1, 2]));

      input.write(request(3).slice(20));
      await vi.waitFor(() => expect(answeredIds()).toStrictEqual([1, 2, 3]));
    } finally {
      stop();
    }
  });

  describe('compact snapshots', () => {
    function wireFixture() {
      const snapshot = createInitialSnapshot();
      const team = snapshot.teams[0]!;
      const lead = snapshot.agents.find(agent => agent.teamId === team.id)!;
      const mission = createMission(snapshot, { outcome: 'Ship checkout', workflowType: 'shapeAndShipFeature', teamId: team.id, orchestratorMemberId: lead.id });
      const run = (id: string, status: 'accepted' | 'awaitingReview') => ({
        id, stage: 'requirements' as const, memberId: lead.id, status, skills: [], feedback: '', startedAt: '2026-11-01T00:00:00.000Z', proposal: structuredClone(mission.artifacts),
      });
      mission.execution!.runs = [run('finished', 'accepted'), run('pending', 'awaitingReview')];
      snapshot.turnGitDiffs = {
        'turn-1': { agentId: lead.id, turnId: 'turn-1', addedLines: 3, removedLines: 1, diff: 'diff --git a/a b/a', updatedAt: '2026-11-01T00:00:00.000Z' },
        'turn-2': { agentId: lead.id, turnId: 'turn-2', addedLines: 1, removedLines: 0, diff: 'diff --git a/b b/b', updatedAt: '2026-11-01T00:00:01.000Z' },
      };
      const clientState = { sourceFolderPath: '/projects', shouldPreventDisplaySleep: false };
      const input = new PassThrough();
      const output = new PassThrough();
      const frames: Array<{ id?: number; result?: unknown; params?: unknown }> = [];
      let unfinished = '';
      output.on('data', (chunk) => {
        const lines = (unfinished + chunk.toString()).split('\n');
        unfinished = lines.pop()!;
        frames.push(...lines.filter(Boolean).map(line => JSON.parse(line)));
      });
      const peer = new StdioRpcPeer({
        input,
        output,
        onMessage: (message) => ({
          jsonrpc: '2.0',
          id: 'id' in message ? message.id! : 1,
          result: 'method' in message && message.method === backendMethods.snapshotGet ? { snapshot, lastEventSeq: 7, clientState } : snapshot,
        }),
      });
      peer.start();
      const request = async (id: number, method: string, params?: unknown) => {
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
        await vi.waitFor(() => expect(frames.some(frame => frame.id === id)).toBe(true));
        return frames.find(frame => frame.id === id)!.result;
      };
      const publish = (event: Record<string, unknown>) => {
        peer.notify(backendMethods.backendEventNotify, event);
        return frames.at(-1)!.params as { payload: unknown; snapshot?: unknown };
      };
      // The finished run loses its proposal; nothing else changes, the changes of turns included.
      const compact = structuredClone(snapshot);
      delete compact.missions![0]!.execution!.runs[0]!.proposal;
      return { peer, snapshot, compact, clientState, request, publish, turnDiff: { addedLines: 1, removedLines: 0, diff: 'diff --git a/b b/b' } };
    }

    it('sends a client that asked for compact snapshots every snapshot without the proposals of finished Mission runs', async () => {
      const { peer, snapshot, compact, clientState, request, publish, turnDiff } = wireFixture();
      try {
        expect(await request(1, backendMethods.clientWireConfigure, { snapshots: 'compact' })).toStrictEqual({ snapshots: 'compact' });

        expect(await request(2, backendMethods.agentUpdate)).toStrictEqual(compact);
        expect(await request(3, backendMethods.snapshotGet)).toStrictEqual({ snapshot: compact, lastEventSeq: 7, clientState });
        expect(publish({ seq: 8, type: 'snapshot.updated', payload: snapshot, occurredAt: '2026-11-01T00:00:02.000Z' }).payload).toStrictEqual(compact);
        expect(publish({ seq: 9, type: 'agent.updated', agentId: 'agent-1', payload: { id: 'agent-1' }, snapshot, occurredAt: '2026-11-01T00:00:03.000Z' }).snapshot).toStrictEqual(compact);
        expect(publish({ seq: 10, type: 'conversation.turnDiffUpdated', agentId: 'agent-1', turnId: 'turn-2', payload: turnDiff, occurredAt: '2026-11-01T00:00:04.000Z' }).payload).toStrictEqual(turnDiff);
      } finally {
        peer.stop();
      }
    });

    it('keeps sending complete snapshots to a client that never asked for compact ones', async () => {
      const { peer, snapshot, clientState, request, publish, turnDiff } = wireFixture();
      try {
        expect(await request(2, backendMethods.agentUpdate)).toStrictEqual(snapshot);
        expect(await request(3, backendMethods.snapshotGet)).toStrictEqual({ snapshot, lastEventSeq: 7, clientState });
        expect(publish({ seq: 8, type: 'snapshot.updated', payload: snapshot, occurredAt: '2026-11-01T00:00:02.000Z' }).payload).toStrictEqual(snapshot);
        expect(publish({ seq: 9, type: 'agent.updated', agentId: 'agent-1', payload: { id: 'agent-1' }, snapshot, occurredAt: '2026-11-01T00:00:03.000Z' }).snapshot).toStrictEqual(snapshot);
        expect(publish({ seq: 10, type: 'conversation.turnDiffUpdated', agentId: 'agent-1', turnId: 'turn-2', payload: turnDiff, occurredAt: '2026-11-01T00:00:04.000Z' }).payload).toStrictEqual(turnDiff);
      } finally {
        peer.stop();
      }
    });
  });

  it('returns parse errors for invalid JSON lines', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: string[] = [];
    output.on('data', (chunk) => responses.push(chunk.toString()));

    const stop = startStdioRpcServer({
      input,
      output,
      onMessage: () => undefined,
    });

    input.write('nope\n');
    await Promise.resolve();
    stop();

    expect(JSON.parse(responses.join(''))).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
      },
    });
  });

  it('keeps the request id when a handler throws', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: string[] = [];
    output.on('data', (chunk) => responses.push(chunk.toString()));

    const stop = startStdioRpcServer({
      input,
      output,
      onMessage: () => {
        throw new Error('handler failed');
      },
    });

    input.write('{"jsonrpc":"2.0","id":"select-1","method":"client/navigation/selectAgent"}\n');
    await Promise.resolve();
    stop();

    expect(JSON.parse(responses.join(''))).toStrictEqual({
      jsonrpc: '2.0',
      id: 'select-1',
      error: {
        code: -32603,
        message: 'handler failed',
      },
    });
  });

  it('sends backend-initiated requests and resolves Electron responses', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const writes: string[] = [];
    output.on('data', (chunk) => writes.push(chunk.toString()));
    const peer = new StdioRpcPeer({
      input,
      output,
      onMessage: () => undefined,
    });
    peer.start();

    const resultPromise = peer.request('client/external/open', { url: 'https://example.com' });
    const request = JSON.parse(writes.join('')) as { id: string; method: string };
    expect(request).toMatchObject({
      jsonrpc: '2.0',
      method: 'client/external/open',
      params: { url: 'https://example.com' },
    });

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true })}\n`);
    await expect(resultPromise).resolves.toBe(true);
    peer.stop();
  });

  it('rejects backend-initiated requests when Electron returns an error', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const writes: string[] = [];
    output.on('data', (chunk) => writes.push(chunk.toString()));
    const peer = new StdioRpcPeer({
      input,
      output,
      onMessage: () => undefined,
    });
    peer.start();

    const resultPromise = peer.request('client/external/open', { url: 'https://example.com' });
    const request = JSON.parse(writes.join('')) as { id: string };
    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32603, message: 'open failed' },
    })}\n`);

    await expect(resultPromise).rejects.toThrow('open failed');
    peer.stop();
  });

  it('reports output backpressure once and reports when the stream drains', () => {
    const input = new PassThrough();
    const output = new PassThrough({ highWaterMark: 1 });
    const onOutputBackpressure = vi.fn();
    const onOutputDrain = vi.fn();
    const peer = new StdioRpcPeer({
      input,
      output,
      onMessage: () => undefined,
      onOutputBackpressure,
      onOutputDrain,
    });
    peer.start();

    peer.notify('backend/event', { value: 'first' });
    peer.notify('backend/event', { value: 'second' });

    expect(onOutputBackpressure).toHaveBeenCalledOnce();
    expect(onOutputBackpressure).toHaveBeenCalledWith(expect.objectContaining({
      frameBytes: expect.any(Number),
      writableLength: expect.any(Number),
    }));
    output.emit('drain');
    expect(onOutputDrain).toHaveBeenCalledOnce();
    peer.stop();
  });

  it('keeps the transport alive while Node buffers complete frames', () => {
    const input = new PassThrough();
    const output = new PassThrough({ highWaterMark: 1 });
    const peer = new StdioRpcPeer({
      input,
      output,
      onMessage: () => undefined,
    });
    peer.start();

    peer.notify('backend/event', { value: 'first' });
    peer.notify('backend/event', { value: 'second' });

    expect(output.destroyed).toBe(false);
    expect(output.readableLength).toBeGreaterThan(0);
    peer.stop();
  });

  it('merges back-to-back queued snapshots without reordering events and marks the sequences the survivor covers', () => {
    const input = new PassThrough();
    const frames: string[] = [];
    let accepting = false;
    const output = Object.assign(new PassThrough(), {
      write: (chunk: string) => { frames.push(String(chunk)); return accepting; },
    }) as unknown as PassThrough;
    const peer = new StdioRpcPeer({
      input,
      output,
      onMessage: () => undefined,
    });
    peer.start();
    const snapshot = (seq: number) => ({ seq, type: 'snapshot.updated', payload: `state-${seq}` });

    try {
      // The first frame is written at once and leaves the stream backpressured; the rest queue.
      peer.notify('backend/event/notify', snapshot(1));
      peer.notify('backend/event/notify', snapshot(2));
      peer.notify('backend/event/notify', snapshot(3));
      peer.notify('backend/event/notify', { seq: 4, type: 'turn.completed' });
      peer.notify('backend/event/notify', snapshot(5));
      peer.notify('backend/event/notify', snapshot(6));
      peer.notify('backend/event/notify', snapshot(7));
      accepting = true;
      output.emit('drain');

      expect(frames.map(frame => JSON.parse(frame).params)).toStrictEqual([
        snapshot(1),
        { ...snapshot(3), coveredFromSeq: 2 },
        { seq: 4, type: 'turn.completed' },
        { ...snapshot(7), coveredFromSeq: 5 },
      ]);
    } finally {
      peer.stop();
    }
  });

  it('replaces a queued snapshot with a later one without claiming the sequences between them once an event was dropped', () => {
    const input = new PassThrough();
    const frames: string[] = [];
    let accepting = false;
    const output = Object.assign(new PassThrough(), {
      write: (chunk: string) => { frames.push(String(chunk)); return accepting; },
    }) as unknown as PassThrough;
    const snapshot = (seq: number) => ({ seq, type: 'snapshot.updated', payload: `state-${seq}` });
    const frameBytes = Buffer.byteLength(`${JSON.stringify({ jsonrpc: '2.0', method: 'backend/event/notify', params: snapshot(2) })}\n`);
    // Room for one queued snapshot: the patch that follows it overflows and is dropped.
    const peer = new StdioRpcPeer({ input, output, maxBufferedOutputBytes: frameBytes + 10, onMessage: () => undefined });
    peer.start();

    try {
      peer.notify('backend/event/notify', snapshot(1));
      peer.notify('backend/event/notify', snapshot(2));
      peer.notify('backend/event/notify', { seq: 3, type: 'conversation.sessionPatch', agentId: 'agent-1', payload: 'lost' });
      peer.notify('backend/event/notify', snapshot(4));
      accepting = true;
      output.emit('drain');

      // The latest state arrives, and nothing claims to cover the lost sequence 3: the receiver sees a gap.
      expect(frames.map(frame => JSON.parse(frame).params)).toStrictEqual([snapshot(1), snapshot(4)]);
    } finally {
      peer.stop();
    }
  });

  it('bounds queued notifications instead of allowing an unbounded writable buffer', () => {
    const input = new PassThrough();
    const output = new PassThrough({ highWaterMark: 1 });
    const onOutputOverflow = vi.fn();
    const peer = new StdioRpcPeer({
      input,
      output,
      maxBufferedOutputBytes: 1,
      onOutputOverflow,
      onMessage: () => undefined,
    });
    peer.start();

    peer.notify('backend/event/notify', { type: 'ordinary', value: 'first' });
    peer.notify('backend/event/notify', { type: 'ordinary', value: 'second' });

    expect(onOutputOverflow).toHaveBeenCalledWith(expect.objectContaining({
      bufferedBytes: 0,
      frameBytes: expect.any(Number),
    }));
    expect(output.destroyed).toBe(false);
    peer.stop();
  });

  it('delivers a large conversation snapshot after startup output backpressure', async () => {
    const input = new PassThrough();
    const output = new PassThrough({ highWaterMark: 1 });
    const peer = new StdioRpcPeer({ input, output, onMessage: () => undefined });
    let largestReceivedFrameBytes = 0;
    peer.start();

    try {
      peer.notify('backend/event/notify', { type: 'agent.statusChanged' });
      peer.notify('backend/event/notify', {
        type: 'conversation.sessionSnapshot',
        snapshot: 'x'.repeat(64 * 1024 * 1024),
      });

      output.on('data', (chunk: Buffer) => {
        largestReceivedFrameBytes = Math.max(largestReceivedFrameBytes, chunk.byteLength);
      });
      output.emit('drain');

      await vi.waitFor(() => expect(largestReceivedFrameBytes).toBeGreaterThan(64 * 1024 * 1024));
    } finally {
      peer.stop();
      output.destroy();
    }
  });

  it('identifies an oversized event without inspecting its payload', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const onOutputOverflow = vi.fn();
    const peer = new StdioRpcPeer({
      input,
      output,
      maxBufferedOutputBytes: 100,
      onOutputOverflow,
      onMessage: () => undefined,
    });
    peer.start();

    peer.notify('backend/event/notify', { type: 'conversation.sessionSnapshot', value: 'x'.repeat(200) });

    expect(onOutputOverflow).toHaveBeenCalledWith({
      bufferedBytes: 0,
      eventType: 'conversation.sessionSnapshot',
      frameBytes: expect.any(Number),
      kind: 'notification',
      method: 'backend/event/notify',
    });
    peer.stop();
  });

  it('waits for overloaded output to drain before compact conversation recovery emits its frame', async () => {
    const input = new PassThrough();
    const output = new PassThrough({ highWaterMark: 1 });
    const received: string[] = [];
    const onMessage = vi.fn(() => {
      peer.notify('backend/event/notify', { seq: 3, type: 'conversation.sessionSnapshot', payload: { transcript: 'retained' } });
      return { jsonrpc: '2.0' as const, id: 'repair', result: null };
    });
    const peer = new StdioRpcPeer({ input, output, maxBufferedOutputBytes: 100, onMessage });
    peer.start();
    peer.notify('backend/event/notify', { seq: 1, type: 'snapshot.updated', payload: 'x'.repeat(6_000_000) });
    peer.notify('backend/event/notify', { seq: 2, type: 'agent.statusChanged', payload: 'dropped'.repeat(100) });
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 'repair', method: 'agent/conversation/load', params: { agentId: 'lead', omitSnapshot: true } }) + '\n');
    await Promise.resolve();
    expect(onMessage).not.toHaveBeenCalled();
    output.on('data', chunk => received.push(chunk.toString()));
    await vi.waitFor(() => expect(received.join('')).toContain('"id":"repair"'));
    expect(received.join('')).toContain('"seq":3');
    expect(received.join('')).not.toContain('"seq":2');
    expect(onMessage).toHaveBeenCalledOnce();
    peer.stop();
    output.destroy();
  });

  it('identifies the request method for an oversized response', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const onOutputOverflow = vi.fn();
    const peer = new StdioRpcPeer({
      input,
      output,
      maxBufferedOutputBytes: 100,
      onOutputOverflow,
      onMessage: (message) => ({
        jsonrpc: '2.0',
        id: 'id' in message ? message.id : null,
        result: 'x'.repeat(200),
      }),
    });
    peer.start();

    input.write('{"jsonrpc":"2.0","id":"hydrate-1","method":"agent/conversation/load"}\n');
    await Promise.resolve();

    expect(onOutputOverflow).toHaveBeenCalledWith({
      bufferedBytes: 0,
      frameBytes: expect.any(Number),
      id: 'hydrate-1',
      kind: 'response',
      method: 'agent/conversation/load',
    });
    peer.stop();
  });
});
