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

const VERIFIED_TOOLS = [
  'get_my_appointments', 'get_my_invoices', 'get_my_balance',
  'reschedule_appointment', 'cancel_appointment',
] as const;

describe('a ticketed browser session reaches Tier 2 through the real module', () => {
  let app: INestApplication;
  let url: string;
  let tickets: VoiceTicketService;
  let store: VoiceSessionStore;
  let auditLog: jest.Mock;
  let requested: string[];

  beforeAll(async () => {
    process.env.FRONTEND_URL = ORIGIN;
    requested = [];
    auditLog = jest.fn().mockResolvedValue(undefined);

    const client: AnthropicLike = {
      messages: {
        create: async (params) => {
          const last = params.messages[params.messages.length - 1];
          const said = typeof last?.content === 'string' ? last.content : '';
          const ran = Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result');
          if (ran) {
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.', citations: null }] } as unknown as Anthropic.Message;
          }
          const tool = VERIFIED_TOOLS.find((t) => said.includes(t)) ?? 'get_clinic_info';
          requested.push(tool);
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: `t${requested.length}`, name: tool, input: {} }],
          } as unknown as Anthropic.Message;
        },
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, fakeAnthropic(client), VoiceModule],
    })
      .overrideProvider(AuditService).useValue({ log: auditLog })
      .overrideProvider(VOICE_BROWSER_FLAG).useValue({ browserEnabled: true })
      .overrideProvider(PrismaService).useValue({
        // The one lookup identity binding performs.
        patient: { findUnique: async ({ where }: { where: { userId: string } }) =>
          where.userId === 'user-owner' ? { id: 'patient-owner' } : null },
        $connect: async () => undefined,
        $disconnect: async () => undefined,
        appointment: { findMany: async () => [], findUnique: async () => null },
        invoice: { findMany: async () => [] },
        payment: { findMany: async () => [] },
      })
      .compile();

    app = moduleRef.createNestApplication();
    // The real module owns a Redis connection; without shutdown hooks it stays
    // open after app.close() and the run never exits.
    app.enableShutdownHooks();
    app.useWebSocketAdapter(new WsOriginAdapter(app));
    await app.init();
    await app.listen(0);
    url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/voice`;
    tickets = moduleRef.get(VoiceTicketService);
    store = moduleRef.get(VoiceSessionStore);
  }, 30000);

  afterAll(async () => { await app.close(); });

  it('starts verified from a ticket and reaches a Tier 2 tool', async () => {
    const ticket = tickets.issue('user-owner');
    const browser = new Browser();
    await browser.connect(`${url}?ticket=${ticket}`);

    browser.send({ type: 'session.start' });
    const ready = await browser.waitFor('session.ready');
    const sessionId = ready.sessionId as string;

    // Verified, with a server-derived patient the browser never named.
    const session = (await store.get(sessionId))!.session;
    expect(session.identityVerified).toBe(true);
    expect(session.patientId).toBe('patient-owner');
    expect(session.userId).toBe('user-owner');

    browser.send({ type: 'turn.text', text: 'get_my_balance please' });
    await browser.waitFor('turn.complete');

    expect(requested).toContain('get_my_balance');
    const call = auditLog.mock.calls.find((c) => c[0].action === 'get_my_balance');
    expect(call?.[0].userId).toBe('user-owner');
    // Reached the tool rather than being refused.
    expect(call?.[0].newValues?.status).not.toBe('failed');

    // Nothing identifying went to the browser.
    const seen = JSON.stringify(browser.frames);
    expect(seen).not.toContain('user-owner');
    expect(seen).not.toContain('patient-owner');
    expect(seen).not.toContain(ticket);
    browser.close();
  }, 30000);

  it('leaves a socket with no ticket anonymous and Tier 2 blocked', async () => {
    const browser = new Browser();
    await browser.connect(url);
    browser.send({ type: 'session.start' });
    const ready = await browser.waitFor('session.ready');

    const session = (await store.get(ready.sessionId as string))!.session;
    expect(session.identityVerified).toBe(false);
    expect(session.patientId).toBeNull();

    browser.send({ type: 'turn.text', text: 'get_my_invoices please' });
    await browser.waitFor('turn.complete');

    const blocked = auditLog.mock.calls.find((c) => c[0].action === 'get_my_invoices');
    expect(blocked?.[0].newValues).toMatchObject({ status: 'failed' });
    browser.close();
  }, 30000);

  it('fails closed on a reused ticket', async () => {
    const ticket = tickets.issue('user-owner');
    const first = new Browser();
    await first.connect(`${url}?ticket=${ticket}`);
    first.send({ type: 'session.start' });
    await first.waitFor('session.ready');
    first.close();

    // The same ticket again: consumed, so this socket stays anonymous.
    const replay = new Browser();
    await replay.connect(`${url}?ticket=${ticket}`);
    replay.send({ type: 'session.start' });
    const ready = await replay.waitFor('session.ready');

    expect((await store.get(ready.sessionId as string))!.session.identityVerified).toBe(false);
    replay.close();
  }, 30000);

  it('does not verify a user with no linked patient', async () => {
    const ticket = tickets.issue('staff-no-patient');
    const browser = new Browser();
    await browser.connect(`${url}?ticket=${ticket}`);
    browser.send({ type: 'session.start' });
    const ready = await browser.waitFor('session.ready');

    expect((await store.get(ready.sessionId as string))!.session.identityVerified).toBe(false);
    browser.close();
  }, 30000);
});
