import type Anthropic from '@anthropic-ai/sdk';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';

import { VoiceGateway } from '../../src/modules/voice/transport/voice.gateway';
import { VoiceTurnRunner } from '../../src/modules/voice/transport/voice-turn-runner';
import { TransportMetricsService } from '../../src/modules/voice/transport/transport-metrics.service';
import { AudioTransport } from '../../src/modules/voice/transport/audio-transport.interface';
import { ServerFrame } from '../../src/modules/voice/transport/frames';
import { VoiceErrorCode } from '../../src/modules/voice/transport/error-codes';
import {
  WS_MAX_TURNS_PER_SESSION,
  WS_MAX_TURNS_PER_MINUTE,
  WS_MAX_CONNECTION_MS,
} from '../../src/modules/voice/transport/transport-limits';
import { VoiceSessionStore } from '../../src/modules/voice/session/voice-session.store';
import {
  ClaudeAgentService,
  ANTHROPIC_CLIENT,
  AnthropicLike,
} from '../../src/modules/voice/agent/claude.agent';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { IdempotencyService } from '../../src/modules/voice/idempotency/idempotency.service';

class FakeTransport implements AudioTransport {
  readonly sent: ServerFrame[] = [];
  readonly audioFrames: Buffer[] = [];
  closedWith: VoiceErrorCode | null = null;
  teardownRuns = 0;
  private teardowns: Array<() => void | Promise<void>> = [];

  send(frame: ServerFrame): void {
    this.sent.push(frame);
  }
  sendAudio(chunk: Buffer): void {
    this.audioFrames.push(chunk);
  }
  close(code: VoiceErrorCode): void {
    this.closedWith = code;
  }
  onTeardown(fn: () => void | Promise<void>): void {
    this.teardowns.push(fn);
  }
  registeredTeardowns(): number {
    return this.teardowns.length;
  }
  /** Simulates the socket ending, however it ended. */
  async fireTeardown(): Promise<void> {
    this.teardownRuns += 1;
    for (const fn of this.teardowns) {
      await fn();
    }
  }
  typesSent(): string[] {
    return this.sent.map((f) => f.type);
  }
}

async function buildGateway() {
  const client: AnthropicLike = {
    messages: {
      create: async () =>
        ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'We are open eight to six.', citations: null }],
        }) as unknown as Anthropic.Message,
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      VoiceGateway,
      VoiceTurnRunner,
      TransportMetricsService,
      VoiceSessionStore,
      ToolRegistryService,
      ToolExecutorService,
      ClaudeAgentService,
      IdempotencyService,
      { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      { provide: ANTHROPIC_CLIENT, useValue: client },
    ],
  }).compile();

  return { gateway: moduleRef.get(VoiceGateway), store: moduleRef.get(VoiceSessionStore) };
}

function readyId(t: FakeTransport): string {
  return (t.sent[0] as { type: 'session.ready'; sessionId: string }).sessionId;
}

describe('unknown session ids are not an enumeration oracle', () => {
  it('answers an unknown id indistinguishably from first contact', async () => {
    const { gateway } = await buildGateway();

    const fresh = new FakeTransport();
    await gateway.handleFrame(fresh, { type: 'session.start' });

    const guess = new FakeTransport();
    await gateway.handleFrame(guess, { type: 'session.start', sessionId: 'definitely-not-issued' });

    // Same frame shape, same key set, no error, no close. Anything that
    // differs here answers "does this session exist?" one guess at a time.
    expect(guess.typesSent()).toEqual(fresh.typesSent());
    expect(Object.keys(guess.sent[0]).sort()).toEqual(Object.keys(fresh.sent[0]).sort());
    expect(guess.closedWith).toBeNull();
    expect(readyId(guess)).not.toBe('definitely-not-issued');
  });

  it('mints a fresh session rather than adopting the id the client offered', async () => {
    const { gateway, store } = await buildGateway();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start', sessionId: 'chosen-by-client' });

    expect(store.get('chosen-by-client')).toBeUndefined();
    expect(readyId(transport)).toHaveLength(43);
  });

  it('treats a dead id the same as one never issued', async () => {
    const { gateway, store } = await buildGateway();
    const first = new FakeTransport();
    await gateway.handleFrame(first, { type: 'session.start' });
    const id = readyId(first);

    store.delete(id);
    await first.fireTeardown();

    const revisit = new FakeTransport();
    await gateway.handleFrame(revisit, { type: 'session.start', sessionId: id });

    expect(revisit.typesSent()).toEqual(['session.ready']);
    expect(revisit.closedWith).toBeNull();
    expect(readyId(revisit)).not.toBe(id);
  });
});

describe('one live socket per session', () => {
  it('rejects a second socket and leaves the first working', async () => {
    const { gateway } = await buildGateway();
    const first = new FakeTransport();
    await gateway.handleFrame(first, { type: 'session.start' });
    const sessionId = readyId(first);

    const second = new FakeTransport();
    await gateway.handleFrame(second, { type: 'session.start', sessionId });

    expect(second.closedWith).toBe('session_conflict');

    // Closing the first instead would let anyone holding a stolen id kick the
    // legitimate caller off their own call.
    await gateway.handleFrame(first, { type: 'turn.text', text: 'still there?' });
    expect(first.typesSent()).toContain('turn.complete');
    expect(first.closedWith).toBeNull();
  });

  it('gives the rejected socket no session and no way to observe the live one', async () => {
    const { gateway } = await buildGateway();
    const first = new FakeTransport();
    await gateway.handleFrame(first, { type: 'session.start' });
    const sessionId = readyId(first);
    await gateway.handleFrame(first, { type: 'turn.text', text: 'my secret is swordfish' });

    const second = new FakeTransport();
    await gateway.handleFrame(second, { type: 'session.start', sessionId });

    // It never received session.ready, so it holds no credential...
    expect(second.typesSent()).not.toContain('session.ready');
    // ...and a turn on it cannot reach the live conversation.
    await gateway.handleFrame(second, { type: 'turn.text', text: 'what did I say?' });
    expect(second.sent).toContainEqual({ type: 'error', code: 'session_expired' });
    expect(JSON.stringify(second.sent)).not.toContain('swordfish');
  });

  it('releases the slot on teardown so the caller can reconnect', async () => {
    const { gateway } = await buildGateway();
    const first = new FakeTransport();
    await gateway.handleFrame(first, { type: 'session.start' });
    const sessionId = readyId(first);

    await first.fireTeardown();

    const reconnect = new FakeTransport();
    await gateway.handleFrame(reconnect, { type: 'session.start', sessionId });

    expect(reconnect.closedWith).toBeNull();
    expect(readyId(reconnect)).toBe(sessionId);
  });

  it('does not release another socket\'s slot when a rejected one tears down', async () => {
    const { gateway } = await buildGateway();
    const first = new FakeTransport();
    await gateway.handleFrame(first, { type: 'session.start' });
    const sessionId = readyId(first);

    const second = new FakeTransport();
    await gateway.handleFrame(second, { type: 'session.start', sessionId });
    await second.fireTeardown();

    // The rejected socket tearing down must not free the live socket's claim.
    const third = new FakeTransport();
    await gateway.handleFrame(third, { type: 'session.start', sessionId });
    expect(third.closedWith).toBe('session_conflict');
  });
});

describe('teardown runs every registered callback exactly once', () => {
  it('registers a teardown for each connection', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });

    expect(transport.registeredTeardowns()).toBeGreaterThanOrEqual(1);
  });

  it('a repeated teardown does not steal the slot a reconnected socket now holds', async () => {
    const { gateway } = await buildGateway();

    // 1. First socket claims the session, then drops.
    const dropped = new FakeTransport();
    await gateway.handleFrame(dropped, { type: 'session.start' });
    const sessionId = readyId(dropped);
    await dropped.fireTeardown();

    // 2. The caller reconnects and takes the slot.
    const reconnected = new FakeTransport();
    await gateway.handleFrame(reconnected, { type: 'session.start', sessionId });
    expect(reconnected.closedWith).toBeNull();

    // 3. The dead socket's teardown fires again — a dropped client and a clean
    //    close can both arrive. It must not release the live socket's claim.
    await dropped.fireTeardown();

    const intruder = new FakeTransport();
    await gateway.handleFrame(intruder, { type: 'session.start', sessionId });
    expect(intruder.closedWith).toBe('session_conflict');

    // And the reconnected socket still works.
    await gateway.handleFrame(reconnected, { type: 'turn.text', text: 'still there?' });
    expect(reconnected.typesSent()).toContain('turn.complete');
  });

  it('does not register a teardown for a socket it rejected', async () => {
    const { gateway } = await buildGateway();
    const first = new FakeTransport();
    await gateway.handleFrame(first, { type: 'session.start' });
    const sessionId = readyId(first);

    const second = new FakeTransport();
    await gateway.handleFrame(second, { type: 'session.start', sessionId });

    expect(second.registeredTeardowns()).toBe(0);
  });
});

describe('per-session rate limiting', () => {
  it('closes the connection when the lifetime turn cap is exceeded', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    for (let i = 0; i < WS_MAX_TURNS_PER_SESSION + 1; i++) {
      await gateway.handleFrame(transport, { type: 'turn.text', text: `turn ${i}` });
    }

    expect(transport.closedWith).toBe('rate_limited');
    expect(transport.sent).toContainEqual({ type: 'error', code: 'rate_limited' });
  });

  it('stops running turns once a cap is hit, rather than only warning', async () => {
    const { gateway, store } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    const id = readyId(transport);

    const attempts = WS_MAX_TURNS_PER_SESSION + 5;
    for (let i = 0; i < attempts; i++) {
      await gateway.handleFrame(transport, { type: 'turn.text', text: `turn ${i}` });
    }

    // A tight loop runs inside one window, so the per-minute cap binds first —
    // it is the tighter of the two. What matters is that the agent stopped
    // being called: turnIndex is advanced by ClaudeAgentService.respond, so a
    // count below the attempts proves the rejected turns never reached it.
    const ran = store.get(id)!.session.turnIndex;
    expect(ran).toBe(WS_MAX_TURNS_PER_MINUTE);
    expect(ran).toBeLessThan(attempts);
  });

  it('closes when the per-minute turn rate is exceeded', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    for (let i = 0; i < WS_MAX_TURNS_PER_MINUTE + 1; i++) {
      await gateway.handleFrame(transport, { type: 'turn.text', text: `turn ${i}` });
    }

    expect(transport.closedWith).toBe('rate_limited');
  });

  it('never puts a session id in a rate-limit log line', async () => {
    const warnings: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation((m) => {
      warnings.push(String(m));
    });

    const { gateway } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    const sessionId = readyId(transport);

    for (let i = 0; i < WS_MAX_TURNS_PER_MINUTE + 1; i++) {
      await gateway.handleFrame(transport, { type: 'turn.text', text: `turn ${i}` });
    }

    expect(warnings.join('\n')).not.toContain(sessionId);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Origin and per-IP checks run at the HTTP upgrade, before a socket exists.
// ---------------------------------------------------------------------------

import { WsOriginAdapter } from '../../src/modules/voice/transport/ws-origin.adapter';
import { WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE } from '../../src/modules/voice/transport/transport-limits';

describe('upgrade-time connection controls', () => {
  const original = process.env.FRONTEND_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = original;
  });

  function adapter(): WsOriginAdapter {
    return new WsOriginAdapter({ get: () => undefined } as never);
  }

  it('caps new connections per IP over the window', () => {
    const a = adapter();
    for (let i = 0; i < WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE; i++) {
      expect(a.underIpLimit('10.0.0.1')).toBe(true);
    }
    expect(a.underIpLimit('10.0.0.1')).toBe(false);
  });

  it('counts each IP separately, so one caller cannot lock out another', () => {
    const a = adapter();
    for (let i = 0; i < WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE; i++) {
      a.underIpLimit('10.0.0.1');
    }
    expect(a.underIpLimit('10.0.0.1')).toBe(false);
    expect(a.underIpLimit('10.0.0.2')).toBe(true);
  });

  it('passes maxPayload and verifyClient to the ws server, not to app code', () => {
    const a = adapter();
    let captured: Record<string, unknown> = {};
    // The base adapter builds the ws server; capture what it is handed.
    Object.getPrototypeOf(Object.getPrototypeOf(a)).create = (
      _port: number,
      options: Record<string, unknown>
    ) => {
      captured = options;
      return {};
    };

    a.create(0, {});

    // Server-enforced: an oversize frame is dropped before it is buffered, so
    // there is no application code path that could be made to skip the check.
    expect(captured.maxPayload).toBe(65536);
    expect(typeof captured.verifyClient).toBe('function');
  });

  it('rejects a disallowed origin at the upgrade', () => {
    process.env.FRONTEND_URL = 'https://clinic.example.com';
    const a = adapter();
    let verify: ((info: unknown) => boolean) | undefined;
    Object.getPrototypeOf(Object.getPrototypeOf(a)).create = (
      _port: number,
      options: Record<string, unknown>
    ) => {
      verify = options.verifyClient as (info: unknown) => boolean;
      return {};
    };
    a.create(0, {});

    const req = { socket: { remoteAddress: '10.0.0.9' } };
    expect(verify!({ origin: 'https://clinic.example.com', req })).toBe(true);
    expect(verify!({ origin: 'https://evil.example.com', req })).toBe(false);
    expect(verify!({ origin: undefined, req })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connection duration cap. A socket is capped independently of the session it
// carries: the session survives its own TTL so the caller can reconnect and
// resume, but the connection does not live forever.
// ---------------------------------------------------------------------------

describe('connection duration cap', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('closes an accepted connection once the cap is reached', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    expect(transport.closedWith).toBeNull();
    jest.advanceTimersByTime(WS_MAX_CONNECTION_MS);

    expect(transport.closedWith).toBe('rate_limited');
  });

  it('does not close a connection before the cap is reached', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    jest.advanceTimersByTime(WS_MAX_CONNECTION_MS - 1);

    expect(transport.closedWith).toBeNull();
  });

  it('releases the socket claim so a later connection can use the session', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    const sessionId = readyId(transport);

    jest.advanceTimersByTime(WS_MAX_CONNECTION_MS);

    const reconnect = new FakeTransport();
    await gateway.handleFrame(reconnect, { type: 'session.start', sessionId });

    expect(reconnect.closedWith).toBeNull();
    expect(readyId(reconnect)).toBe(sessionId);
  });

  it('leaves the session itself alive, so the conversation is not lost', async () => {
    const { gateway, store } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    const sessionId = readyId(transport);
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'what are your hours?' });

    jest.advanceTimersByTime(WS_MAX_CONNECTION_MS);

    // The socket ended; the session did not. Closing with session_expired
    // instead would tell the client to throw the conversation away.
    expect(store.get(sessionId)).toBeDefined();
    expect(store.get(sessionId)!.history.length).toBeGreaterThan(0);
  });

  it('cancels the timer when the client disconnects first', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    await transport.fireTeardown();
    jest.advanceTimersByTime(WS_MAX_CONNECTION_MS * 2);

    // A fired timer here would call close() on a socket that is already gone,
    // and would free a slot the caller may have reclaimed.
    expect(transport.closedWith).toBeNull();
  });

  it('never gives a rejected duplicate connection a timer or a teardown', async () => {
    const { gateway } = await buildGateway();
    const first = new FakeTransport();
    await gateway.handleFrame(first, { type: 'session.start' });
    const sessionId = readyId(first);

    const second = new FakeTransport();
    await gateway.handleFrame(second, { type: 'session.start', sessionId });
    expect(second.closedWith).toBe('session_conflict');
    expect(second.registeredTeardowns()).toBe(0);

    jest.advanceTimersByTime(WS_MAX_CONNECTION_MS);

    // The rejected socket's phantom timer must not evict the live socket.
    expect(first.closedWith).toBe('rate_limited');
    const stillClaimed = new FakeTransport();
    await gateway.handleFrame(stillClaimed, { type: 'session.start', sessionId });
    expect(stillClaimed.closedWith).toBeNull();
  });

  it('stays idempotent when teardown fires again after the timeout', async () => {
    const { gateway } = await buildGateway();
    const timedOut = new FakeTransport();
    await gateway.handleFrame(timedOut, { type: 'session.start' });
    const sessionId = readyId(timedOut);

    jest.advanceTimersByTime(WS_MAX_CONNECTION_MS);

    const reconnected = new FakeTransport();
    await gateway.handleFrame(reconnected, { type: 'session.start', sessionId });
    expect(reconnected.closedWith).toBeNull();

    // The dead socket's close event finally arrives.
    await timedOut.fireTeardown();
    await timedOut.fireTeardown();

    const intruder = new FakeTransport();
    await gateway.handleFrame(intruder, { type: 'session.start', sessionId });
    expect(intruder.closedWith).toBe('session_conflict');
  });

  it('never puts a session id in the duration-cap log line', async () => {
    const warnings: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation((m) => {
      warnings.push(String(m));
    });

    const { gateway } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    const sessionId = readyId(transport);

    jest.advanceTimersByTime(WS_MAX_CONNECTION_MS);

    expect(warnings.join('\n')).not.toContain(sessionId);
    expect(warnings.join('\n')).toMatch(/Connection duration cap reached for [0-9a-f]{16}/);
    spy.mockRestore();
  });
});
