import type Anthropic from '@anthropic-ai/sdk';
import type { Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'net';

import {
  VOICE_BROWSER_CONFIG,
  VOICE_BROWSER_FLAG,
} from '../../src/modules/voice/voice-browser.config';
import { VoiceSocketGateway } from '../../src/modules/voice/transport/voice-socket.gateway';
import { VoiceGateway } from '../../src/modules/voice/transport/voice.gateway';
import { VoiceTurnRunner } from '../../src/modules/voice/transport/voice-turn-runner';
import { TransportMetricsService } from '../../src/modules/voice/transport/transport-metrics.service';
import { WsOriginAdapter } from '../../src/modules/voice/transport/ws-origin.adapter';
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

const ORIGIN = 'http://localhost:3000';

describe('the flag itself is default-deny', () => {
  const original = process.env.VOICE_BROWSER_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.VOICE_BROWSER_ENABLED;
    else process.env.VOICE_BROWSER_ENABLED = original;
  });

  it('is false when the variable is absent', () => {
    delete process.env.VOICE_BROWSER_ENABLED;
    expect(VOICE_BROWSER_CONFIG.browserEnabled).toBe(false);
  });

  it('is false for every value that is not exactly "true"', () => {
    for (const value of ['false', 'FALSE', 'True', 'TRUE', '1', 'yes', 'on', '', ' true']) {
      process.env.VOICE_BROWSER_ENABLED = value;
      expect(VOICE_BROWSER_CONFIG.browserEnabled).toBe(false);
    }
  });

  it('is true only for exactly "true"', () => {
    process.env.VOICE_BROWSER_ENABLED = 'true';
    expect(VOICE_BROWSER_CONFIG.browserEnabled).toBe(true);
  });

  it('reads the environment on every access, so it is not frozen at import', () => {
    delete process.env.VOICE_BROWSER_ENABLED;
    expect(VOICE_BROWSER_CONFIG.browserEnabled).toBe(false);
    process.env.VOICE_BROWSER_ENABLED = 'true';
    expect(VOICE_BROWSER_CONFIG.browserEnabled).toBe(true);
  });
});

async function startServer(flag?: { browserEnabled: boolean }) {
  process.env.FRONTEND_URL = ORIGIN;
  const client: AnthropicLike = {
    messages: {
      create: async () =>
        ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok', citations: null }],
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
  ];
  if (flag) providers.push({ provide: VOICE_BROWSER_FLAG, useValue: flag });

  const moduleRef = await Test.createTestingModule({ providers }).compile();
  const app = moduleRef.createNestApplication();
  app.useWebSocketAdapter(new WsOriginAdapter(app));
  await app.init();
  await app.listen(0);
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, url: `ws://127.0.0.1:${address.port}/voice` };
}

/** Opens a socket and reports whether the server served it or shut it down. */
function probe(url: string): Promise<{ served: boolean; frames: unknown[] }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: { Origin: ORIGIN } });
    const frames: unknown[] = [];
    let settled = false;

    const finish = (served: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ served, frames });
      socket.close();
    };

    socket.on('open', () => socket.send(JSON.stringify({ type: 'session.start' })));
    socket.on('message', (d) => {
      frames.push(JSON.parse(String(d)));
      finish(true);
    });
    socket.on('close', () => finish(frames.length > 0));
    socket.on('error', () => finish(false));
    setTimeout(() => finish(frames.length > 0), 2500);
  });
}

describe('the browser voice endpoint is gated by the flag', () => {
  const original = process.env.VOICE_BROWSER_ENABLED;
  let app: INestApplication | undefined;

  afterEach(async () => {
    if (original === undefined) delete process.env.VOICE_BROWSER_ENABLED;
    else process.env.VOICE_BROWSER_ENABLED = original;
    await app?.close();
    app = undefined;
  });

  it('is inert when the variable is absent', async () => {
    delete process.env.VOICE_BROWSER_ENABLED;
    const started = await startServer();
    app = started.app;

    const { served, frames } = await probe(started.url);

    expect(served).toBe(false);
    expect(frames).toEqual([]);
  }, 15000);

  it('is inert when the flag is false', async () => {
    const started = await startServer({ browserEnabled: false });
    app = started.app;

    const { served, frames } = await probe(started.url);

    // No session is issued, so nothing is reachable behind it either.
    expect(served).toBe(false);
    expect(frames).toEqual([]);
  }, 15000);

  it('serves the endpoint only when explicitly enabled', async () => {
    const started = await startServer({ browserEnabled: true });
    app = started.app;

    const { served, frames } = await probe(started.url);

    expect(served).toBe(true);
    expect((frames[0] as { type: string }).type).toBe('session.ready');
  }, 15000);

  it('issues no session at all while disabled', async () => {
    const started = await startServer({ browserEnabled: false });
    app = started.app;
    const store = started.app.get(VoiceSessionStore);

    await probe(started.url);

    // A disabled deployment must not accumulate sessions from probing.
    expect(store.size).toBe(0);
  }, 15000);
});
