import type Anthropic from '@anthropic-ai/sdk';
import { Global, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'net';

import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { VoiceModule } from '../../src/modules/voice/voice.module';
import { WsOriginAdapter } from '../../src/modules/voice/transport/ws-origin.adapter';
import { ANTHROPIC_CLIENT, AnthropicLike } from '../../src/modules/voice/agent/claude.agent';
import { AuditService } from '../../src/modules/audit/audit.service';
import { VOICE_BROWSER_FLAG } from '../../src/modules/voice/voice-browser.config';
import { VoiceTicketService } from '../../src/modules/voice/session/voice-ticket.service';
import { VoiceSessionStore } from '../../src/modules/voice/session/voice-session.store';

const ORIGIN = 'http://localhost:3000';

/**
 * What a real patient lookup costs.
 *
 * The suite's other fakes resolve in a microtask, and a WebSocket message
 * needs at least a macrotask to arrive, so a microtask-fast lookup always wins
 * the race by accident. Production does a database round trip here, and this
 * delay is smaller than one.
 */
const LOOKUP_MS = 25;

function fakeAnthropic(client: AnthropicLike) {
  @Global()
  @Module({ providers: [{ provide: ANTHROPIC_CLIENT, useValue: client }], exports: [ANTHROPIC_CLIENT] })
  class M {}
  return M;
}

interface Frame { type: string; [k: string]: unknown }

class Browser {
  readonly frames: Frame[] = [];
  private socket!: WebSocket;
  async connect(url: string) {
    this.socket = new WebSocket(url, { headers: { Origin: ORIGIN } });
    this.socket.on('message', (d: Buffer, isBinary: boolean) => {
      if (!isBinary) this.frames.push(JSON.parse(d.toString()) as Frame);
    });
    await new Promise((res, rej) => { this.socket.once('open', res); this.socket.once('error', rej); });
  }
  send(f: unknown) { this.socket.send(JSON.stringify(f)); }
  async waitFor(type: string, ms = 8000): Promise<Frame> {
    const end = Date.now() + ms;
    for (;;) {
      const f = this.frames.find((x) => x.type === type);
      if (f) return f;
      if (Date.now() > end) throw new Error(`timeout waiting ${type}; saw ${this.frames.map((x) => x.type).join(',')}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  close() { this.socket.close(); }
}

/**
 * A socket must not lose its identity by being quick.
 *
 * Ticket redemption is started when the socket opens and the message listener
 * is live immediately, so a browser that sends `session.start` without waiting
 * races the lookup that decides who it is. Losing that race used to produce an
 * anonymous session for an authenticated caller — and permanently, because a
 * later `session.start` resumes the session that already exists rather than
 * rebuilding it. The caller held a valid ticket and was refused their own
 * records for the life of the connection.
 */
describe('a ticketed socket that sends immediately is still verified', () => {
  let app: INestApplication;
  let url: string;
  let tickets: VoiceTicketService;
  let store: VoiceSessionStore;

  beforeAll(async () => {
    const client: AnthropicLike = {
      messages: {
        create: async () =>
          ({ content: [{ type: 'text', text: 'Hello.' }], stop_reason: 'end_turn' }) as unknown as Anthropic.Message,
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, fakeAnthropic(client), VoiceModule],
    })
      .overrideProvider(AuditService).useValue({ log: async () => undefined })
      .overrideProvider(VOICE_BROWSER_FLAG).useValue({ browserEnabled: true })
      .overrideProvider(PrismaService).useValue({
        patient: {
          findUnique: async ({ where }: { where: { userId: string } }) => {
            await new Promise((r) => setTimeout(r, LOOKUP_MS));
            return where.userId === 'user-owner' ? { id: 'patient-owner' } : null;
          },
        },
        $connect: async () => undefined,
        $disconnect: async () => undefined,
        appointment: { findMany: async () => [], findUnique: async () => null },
        invoice: { findMany: async () => [] },
        payment: { findMany: async () => [] },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    app.useWebSocketAdapter(new WsOriginAdapter(app));
    await app.init();
    await app.listen(0);
    url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/voice`;
    tickets = moduleRef.get(VoiceTicketService);
    store = moduleRef.get(VoiceSessionStore);
  }, 30000);

  afterAll(async () => { await app.close(); });

  it('binds the ticketed identity even when session.start wins the race', async () => {
    const ticket = await tickets.issue('user-owner');
    const browser = new Browser();
    await browser.connect(`${url}?ticket=${ticket}`);

    // No pause. This is the ordering a real widget produces: the socket opens
    // and the first frame goes out in the same tick.
    browser.send({ type: 'session.start' });

    const ready = await browser.waitFor('session.ready');
    const session = (await store.get(ready.sessionId as string))!.session;

    expect(session.identityVerified).toBe(true);
    expect(session.patientId).toBe('patient-owner');
    expect(session.userId).toBe('user-owner');
    browser.close();
  }, 20000);

  it('still leaves an unticketed socket anonymous when it sends immediately', async () => {
    const browser = new Browser();
    await browser.connect(url);
    browser.send({ type: 'session.start' });

    const ready = await browser.waitFor('session.ready');
    const session = (await store.get(ready.sessionId as string))!.session;

    // The fix must not turn "no ticket" into "wait forever" or into a grant.
    expect(session.identityVerified).toBe(false);
    expect(session.patientId).toBeNull();
    expect(session.userId).toBeNull();
    browser.close();
  }, 20000);

  it('leaves a socket with an unknown ticket anonymous when it sends immediately', async () => {
    const browser = new Browser();
    await browser.connect(`${url}?ticket=${'z'.repeat(43)}`);
    browser.send({ type: 'session.start' });

    const ready = await browser.waitFor('session.ready');
    const session = (await store.get(ready.sessionId as string))!.session;

    expect(session.identityVerified).toBe(false);
    expect(session.patientId).toBeNull();
    browser.close();
  }, 20000);
});
