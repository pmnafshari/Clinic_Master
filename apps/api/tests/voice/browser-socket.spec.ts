import type Anthropic from '@anthropic-ai/sdk';
import type { Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'net';

import { VoiceSocketGateway } from '../../src/modules/voice/transport/voice-socket.gateway';
import { BrowserWebSocketTransport } from '../../src/modules/voice/transport/browser-websocket.transport';
import { VoiceGateway } from '../../src/modules/voice/transport/voice.gateway';
import { VoiceTurnRunner } from '../../src/modules/voice/transport/voice-turn-runner';
import { TransportMetricsService } from '../../src/modules/voice/transport/transport-metrics.service';
import { WsOriginAdapter } from '../../src/modules/voice/transport/ws-origin.adapter';
import { VoiceSessionStore } from '../../src/modules/voice/session/voice-session.store';
import {
  SPEECH_TO_TEXT_FACTORY,
  SpeechToText,
  SttFinal,
} from '../../src/modules/voice/speech/speech-to-text.interface';
import { VoiceSession } from '../../src/modules/voice/session/voice-session';
import {
  ClaudeAgentService,
  ANTHROPIC_CLIENT,
  AnthropicLike,
} from '../../src/modules/voice/agent/claude.agent';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { IdempotencyService } from '../../src/modules/voice/idempotency/idempotency.service';
import { VOICE_BROWSER_FLAG } from '../../src/modules/voice/voice-browser.config';

const ORIGIN = 'http://localhost:3000';

/** Records what the recogniser was actually handed by the real socket. */
class RecordingStt implements SpeechToText {
  static instances: RecordingStt[] = [];
  readonly written: Buffer[] = [];
  started = 0;
  ended = 0;
  private finals: Array<(f: SttFinal) => void | Promise<void>> = [];

  constructor() {
    RecordingStt.instances.push(this);
  }
  async start(_s: VoiceSession): Promise<void> {
    this.started += 1;
  }
  write(chunk: Buffer): void {
    this.written.push(chunk);
  }
  async end(): Promise<void> {
    this.ended += 1;
  }
  onPartial(): void {}
  onFinal(h: (f: SttFinal) => void | Promise<void>): void {
    this.finals.push(h);
  }
}

async function startServer(enabled: boolean): Promise<{ app: INestApplication; url: string }> {
  RecordingStt.instances = [];
  process.env.FRONTEND_URL = ORIGIN;

  const client: AnthropicLike = {
    messages: {
      create: async () =>
        ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'We are open eight to six.', citations: null }],
        }) as unknown as Anthropic.Message,
    },
  };

  const providers: Provider[] = [
    VoiceSocketGateway,
    VoiceGateway,
    VoiceTurnRunner,
    VoiceSessionStore,
    TransportMetricsService,
    ToolRegistryService,
    ToolExecutorService,
    ClaudeAgentService,
    IdempotencyService,
    { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
    { provide: ANTHROPIC_CLIENT, useValue: client },
    { provide: SPEECH_TO_TEXT_FACTORY, useValue: () => new RecordingStt() },
    { provide: VOICE_BROWSER_FLAG, useValue: { browserEnabled: enabled } },
  ];

  const moduleRef = await Test.createTestingModule({ providers }).compile();
  const app = moduleRef.createNestApplication();
  app.useWebSocketAdapter(new WsOriginAdapter(app));
  await app.init();
  await app.listen(0);

  const address = app.getHttpServer().address() as AddressInfo;
  return { app, url: `ws://127.0.0.1:${address.port}/voice` };
}

function open(url: string, origin = ORIGIN): WebSocket {
  return new WebSocket(url, { headers: { Origin: origin } });
}

/** Resolves with the frames received until `stop` returns true, or on close. */
function collect(
  socket: WebSocket,
  stop: (frames: Record<string, unknown>[]) => boolean
): Promise<Record<string, unknown>[]> {
  const frames: Record<string, unknown>[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(frames), 3000);
    socket.on('message', (data) => {
      try {
        frames.push(JSON.parse(String(data)));
      } catch {
        frames.push({ type: 'binary', bytes: (data as Buffer).length });
      }
      if (stop(frames)) {
        clearTimeout(timer);
        resolve(frames);
      }
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(frames);
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const hasType = (t: string) => (fs: Record<string, unknown>[]) => fs.some((f) => f.type === t);

describe('a real browser socket reaches the existing transport stack', () => {
  let app: INestApplication;
  let url: string;

  beforeEach(async () => {
    ({ app, url } = await startServer(true));
  });

  afterEach(async () => {
    await app.close();
  });

  it('routes a JSON text message into the validated frame path', async () => {
    const socket = open(url);
    await new Promise((r) => socket.on('open', r));

    const ready = collect(socket, hasType('session.ready'));
    socket.send(JSON.stringify({ type: 'session.start' }));
    const frames = await ready;

    const readyFrame = frames.find((f) => f.type === 'session.ready') as { sessionId: string };
    expect(readyFrame.sessionId).toHaveLength(43);
    socket.close();
  }, 15000);

  it('drives a complete turn over a real socket', async () => {
    const socket = open(url);
    await new Promise((r) => socket.on('open', r));
    socket.send(JSON.stringify({ type: 'session.start' }));
    await collect(socket, hasType('session.ready'));

    const done = collect(socket, hasType('turn.complete'));
    socket.send(JSON.stringify({ type: 'turn.text', text: 'what are your hours?' }));
    const frames = await done;

    expect(frames.map((f) => f.type)).toContain('agent.thinking');
    expect(frames.map((f) => f.type)).toContain('turn.complete');
    socket.close();
  }, 15000);

  it('rejects a malformed real message without touching session state', async () => {
    const socket = open(url);
    await new Promise((r) => socket.on('open', r));
    socket.send(JSON.stringify({ type: 'session.start' }));
    await collect(socket, hasType('session.ready'));

    const errored = collect(socket, hasType('error'));
    socket.send(JSON.stringify({ type: 'turn.text', text: 'hi', patientId: 'p1' }));
    const frames = await errored;

    expect(frames.find((f) => f.type === 'error')).toEqual({ type: 'error', code: 'bad_frame' });
    socket.close();
  }, 15000);

  it('routes a binary message into the audio path', async () => {
    const socket = open(url);
    await new Promise((r) => socket.on('open', r));
    socket.send(JSON.stringify({ type: 'session.start' }));
    await collect(socket, hasType('session.ready'));

    socket.send(Buffer.alloc(640));
    await new Promise((r) => setTimeout(r, 300));

    expect(RecordingStt.instances).toHaveLength(1);
    expect(RecordingStt.instances[0].started).toBe(1);
    expect(RecordingStt.instances[0].written).toHaveLength(1);
    expect(RecordingStt.instances[0].written[0]).toHaveLength(640);
    socket.close();
  }, 15000);

  it('runs teardown when the socket closes', async () => {
    const socket = open(url);
    await new Promise((r) => socket.on('open', r));
    socket.send(JSON.stringify({ type: 'session.start' }));
    await collect(socket, hasType('session.ready'));
    socket.send(Buffer.alloc(640));
    await new Promise((r) => setTimeout(r, 300));

    socket.close();
    await new Promise((r) => setTimeout(r, 400));

    // Teardown ends the recogniser — proof the close event reached the
    // existing path rather than a duplicate one.
    expect(RecordingStt.instances[0].ended).toBe(1);
  }, 15000);
});

describe('a real socket still obeys the existing T3 controls', () => {
  let app: INestApplication;
  let url: string;

  beforeEach(async () => {
    ({ app, url } = await startServer(true));
  });

  afterEach(async () => {
    await app.close();
  });

  it('refuses the upgrade for a disallowed origin', async () => {
    const socket = open(url, 'https://evil.example.com');
    const outcome = await new Promise<string>((resolve) => {
      socket.on('open', () => resolve('opened'));
      socket.on('error', () => resolve('refused'));
      socket.on('unexpected-response', () => resolve('refused'));
    });

    expect(outcome).toBe('refused');
  }, 15000);

  it('starts a fresh session for an unknown id, indistinguishably from first contact', async () => {
    const socket = open(url);
    await new Promise((r) => socket.on('open', r));

    const ready = collect(socket, hasType('session.ready'));
    socket.send(JSON.stringify({ type: 'session.start', sessionId: 'definitely-not-issued' }));
    const frames = await ready;

    const readyFrame = frames.find((f) => f.type === 'session.ready') as { sessionId: string };
    expect(readyFrame.sessionId).not.toBe('definitely-not-issued');
    expect(frames.some((f) => f.type === 'error')).toBe(false);
    socket.close();
  }, 15000);

  it('rejects a duplicate connection and leaves the first working', async () => {
    const first = open(url);
    await new Promise((r) => first.on('open', r));
    const firstFrames = collect(first, hasType('session.ready'));
    first.send(JSON.stringify({ type: 'session.start' }));
    const sessionId = (
      (await firstFrames).find((f) => f.type === 'session.ready') as { sessionId: string }
    ).sessionId;

    const second = open(url);
    await new Promise((r) => second.on('open', r));
    const secondFrames = collect(second, () => false);
    second.send(JSON.stringify({ type: 'session.start', sessionId }));
    await secondFrames;

    expect(second.readyState).toBe(WebSocket.CLOSED);

    // The first socket is untouched and still serves turns.
    const stillWorks = collect(first, hasType('turn.complete'));
    first.send(JSON.stringify({ type: 'turn.text', text: 'still there?' }));
    expect((await stillWorks).map((f) => f.type)).toContain('turn.complete');
    first.close();
  }, 15000);
});

describe('the transport runs cleanup once, however the socket ended', () => {
  /** A socket that raises both 'close' and 'error', as a dropped one does. */
  function fakeSocket() {
    return { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn() } as unknown as WebSocket;
  }

  it('runs each registered teardown exactly once across repeated fires', async () => {
    const transport = new BrowserWebSocketTransport(fakeSocket());
    const first = jest.fn();
    const second = jest.fn();
    transport.onTeardown(first);
    transport.onTeardown(second);

    // A dropped connection raises 'error' and then 'close'; a duration cap
    // closes from this side and the close event arrives afterwards. Running
    // the list twice would double-count anything registered on it.
    await transport.runTeardown();
    await transport.runTeardown();
    await transport.runTeardown();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('ends the recogniser once when a real socket errors and closes', async () => {
    const { app, url } = await startServer(true);
    const socket = open(url);
    await new Promise((r) => socket.on('open', r));
    socket.send(JSON.stringify({ type: 'session.start' }));
    await collect(socket, hasType('session.ready'));
    socket.send(Buffer.alloc(640));
    await new Promise((r) => setTimeout(r, 300));

    // terminate() drops the connection abruptly, which is the path that raises
    // both events rather than a clean close.
    socket.terminate();
    await new Promise((r) => setTimeout(r, 500));

    expect(RecordingStt.instances[0].ended).toBe(1);
    await app.close();
  }, 15000);
});
