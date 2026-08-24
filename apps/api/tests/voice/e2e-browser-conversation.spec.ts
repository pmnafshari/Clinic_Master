import type Anthropic from '@anthropic-ai/sdk';
import { Global, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'net';

import { PrismaModule } from '../../src/prisma/prisma.module';
import { VoiceModule } from '../../src/modules/voice/voice.module';
import { WsOriginAdapter } from '../../src/modules/voice/transport/ws-origin.adapter';
import { ANTHROPIC_CLIENT, AnthropicLike } from '../../src/modules/voice/agent/claude.agent';
import { AuditService } from '../../src/modules/audit/audit.service';
import { VOICE_BROWSER_FLAG } from '../../src/modules/voice/voice-browser.config';

const ORIGIN = 'http://localhost:3000';

/**
 * One end-to-end conversation over a real socket, through the real module.
 *
 * Everything below the browser is production wiring: the real VoiceModule with
 * all ten real tools, the real gateway, session store, turn runner, agent,
 * executor and audit path. Only the model itself is stood in for — there is no
 * way to assert on a real model's wording, and a test that pays a frontier
 * model per run is a test nobody runs.
 */
function fakeAnthropic(client: AnthropicLike) {
  @Global()
  @Module({
    providers: [{ provide: ANTHROPIC_CLIENT, useValue: client }],
    exports: [ANTHROPIC_CLIENT],
  })
  class FakeAnthropicModule {}
  return FakeAnthropicModule;
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

/** A tiny browser: opens a socket, sends frames, collects what comes back. */
class BrowserClient {
  readonly frames: Frame[] = [];
  readonly audio: Buffer[] = [];
  private socket!: WebSocket;

  async connect(url: string): Promise<void> {
    this.socket = new WebSocket(url, { headers: { Origin: ORIGIN } });
    this.socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.audio.push(data);
        return;
      }
      this.frames.push(JSON.parse(data.toString()) as Frame);
    });
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  sendAudio(chunk: Buffer): void {
    this.socket.send(chunk, { binary: true });
  }

  /** Waits for a frame type, so the test follows the conversation, not a clock. */
  async waitFor(type: string, timeoutMs = 5000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find((f) => f.type === type);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${type}; saw ${this.frames.map((f) => f.type).join(', ')}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  types(): string[] {
    return this.frames.map((f) => f.type);
  }

  close(): void {
    this.socket.close();
  }
}

describe('end to end: a browser holds an anonymous Tier 1 conversation', () => {
  let app: INestApplication;
  let url: string;
  let auditLog: jest.Mock;
  /** Which tools the model asked for, in order. */
  let requested: string[];

  beforeAll(async () => {
    process.env.FRONTEND_URL = ORIGIN;
    requested = [];
    auditLog = jest.fn().mockResolvedValue(undefined);

    /**
     * Stands in for the model. It asks for a public tool when the caller asks
     * about the clinic, and for a verified-tier tool when they ask about
     * money — which an anonymous caller must not be able to reach.
     */
    const client: AnthropicLike = {
      messages: {
        create: async (params) => {
          const last = params.messages[params.messages.length - 1];
          const said = typeof last?.content === 'string' ? last.content : '';
          const toolAlreadyRan =
            Array.isArray(last?.content) &&
            last.content.some((b) => b.type === 'tool_result');

          if (toolAlreadyRan) {
            return {
              stop_reason: 'end_turn',
              content: [
                { type: 'text', text: 'We are open eight to six, Monday to Friday.', citations: null },
              ],
            } as unknown as Anthropic.Message;
          }

          const tool = said.includes('owe') ? 'get_my_balance' : 'get_clinic_info';
          requested.push(tool);
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: `tu_${requested.length}`, name: tool, input: {} }],
          } as unknown as Anthropic.Message;
        },
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        fakeAnthropic(client),
        VoiceModule,
      ],
    })
      .overrideProvider(AuditService)
      .useValue({ log: auditLog })
      .overrideProvider(VOICE_BROWSER_FLAG)
      .useValue({ browserEnabled: true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsOriginAdapter(app));
    await app.init();
    await app.listen(0);
    url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/voice`;
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it('carries a whole conversation from browser to agent and back', async () => {
    const browser = new BrowserClient();
    await browser.connect(url);

    // 1. The session is the server's to issue.
    browser.send({ type: 'session.start' });
    const ready = await browser.waitFor('session.ready');
    const sessionId = ready.sessionId as string;
    expect(sessionId).toHaveLength(43);
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // 2. A real turn reaches the agent, which reaches a public tool through
    //    the executor, and the reply comes back down the same socket.
    browser.send({ type: 'turn.text', text: 'what are your opening hours?' });
    await browser.waitFor('turn.complete');

    expect(browser.types()).toContain('agent.thinking');
    expect(requested).toContain('get_clinic_info');

    const reply = browser.frames.find((f) => f.type === 'reply.text');
    expect(reply?.text).toBe('We are open eight to six, Monday to Friday.');

    // 3. Every tool call was audited — proof it went through the executor and
    //    not around it.
    expect(auditLog).toHaveBeenCalled();
    const publicCall = auditLog.mock.calls.find((c) => c[0].action === 'get_clinic_info');
    expect(publicCall).toBeDefined();

    // 4. Audio reaches the recogniser path without a credential configured,
    //    and degrades to a named code rather than a provider message.
    // Cleared first: the text turn above already produced a tts_unavailable,
    // since no speech credential is configured here either.
    browser.frames.length = 0;
    browser.sendAudio(Buffer.alloc(640));
    const sttError = await browser.waitFor('error');
    expect(sttError.code).toBe('stt_unavailable');
    expect(JSON.stringify(browser.frames)).not.toMatch(/Deepgram|401|api[_-]?key/i);

    // 5. Tier 2 stays out of reach for an anonymous caller.
    browser.frames.length = 0;
    browser.send({ type: 'turn.text', text: 'how much do I owe?' });
    await browser.waitFor('turn.complete');

    expect(requested).toContain('get_my_balance');
    const blocked = auditLog.mock.calls.find((c) => c[0].action === 'get_my_balance');
    expect(blocked?.[0].newValues).toMatchObject({ status: 'failed' });

    // 6. Nothing the browser received carries a credential or provider text.
    const seen = JSON.stringify(browser.frames);
    expect(seen).not.toContain(sessionId);
    expect(seen).not.toMatch(/verification_required|Deepgram|ElevenLabs|Prisma|ECONNREFUSED/i);

    browser.close();
  }, 30000);
});
