import type Anthropic from '@anthropic-ai/sdk';
import { Test, TestingModule } from '@nestjs/testing';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { execSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { PrismaModule } from '../../src/prisma/prisma.module';
import { VoiceModule } from '../../src/modules/voice/voice.module';
import { VoiceGateway } from '../../src/modules/voice/transport/voice.gateway';
import { AudioTransport } from '../../src/modules/voice/transport/audio-transport.interface';
import { ServerFrame } from '../../src/modules/voice/transport/frames';
import { VoiceErrorCode } from '../../src/modules/voice/transport/error-codes';
import { VoiceSessionStore } from '../../src/modules/voice/session/voice-session.store';
import { VoiceTicketService } from '../../src/modules/voice/session/voice-ticket.service';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { ANTHROPIC_CLIENT, AnthropicLike } from '../../src/modules/voice/agent/claude.agent';
import { AuditService } from '../../src/modules/audit/audit.service';
import { VoiceToolResult } from '../../src/modules/voice/tools/tool-definition.interface';

const REPO_ROOT = join(__dirname, '../../../..');

/** The five tools the tier gate must keep out of an anonymous session's reach. */
const VERIFIED_TOOLS = [
  'get_my_appointments',
  'get_my_invoices',
  'get_my_balance',
  'reschedule_appointment',
  'cancel_appointment',
] as const;

class FakeTransport implements AudioTransport {
  readonly sent: ServerFrame[] = [];
  closedWith: VoiceErrorCode | null = null;
  send(f: ServerFrame): void {
    this.sent.push(f);
  }
  sendAudio(): void {}
  close(c: VoiceErrorCode): void {
    this.closedWith = c;
  }
  onTeardown(): void {}
}

/**
 * ANTHROPIC_CLIENT is injected `@Optional()` and is not a registered provider,
 * so overrideProvider cannot reach it — without this the agent constructs a
 * real SDK client, throws for want of an API key, and every turn comes back as
 * the front-desk fallback with no tool ever dispatched.
 *
 * A @Global module makes the fake visible inside VoiceModule's own scope.
 */
function fakeAnthropicModule(client: AnthropicLike) {
  @Global()
  @Module({
    providers: [{ provide: ANTHROPIC_CLIENT, useValue: client }],
    exports: [ANTHROPIC_CLIENT],
  })
  class FakeAnthropicModule {}
  return FakeAnthropicModule;
}

/**
 * Boots the REAL VoiceModule, so the tier gate is exercised against the ten
 * tools actually registered in production — not a stub that could be wrong in
 * the same direction as the code it is checking.
 *
 * Only the Anthropic client is replaced, so no test makes a model call.
 */
async function bootRealModule(toolName: string) {
  const client: AnthropicLike = {
    messages: {
      create: async (params) => {
        const alreadyRan = params.messages.some(
          (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
        );
        if (alreadyRan) {
          return {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Let me put you through.', citations: null }],
          } as unknown as Anthropic.Message;
        }
        return {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_1', name: toolName, input: {} }],
        } as unknown as Anthropic.Message;
      },
    },
  };

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      fakeAnthropicModule(client),
      VoiceModule,
    ],
  })
    .overrideProvider(AuditService)
    .useValue({ log: jest.fn().mockResolvedValue(undefined) })
    .compile();

  await moduleRef.init();
  return moduleRef;
}

function readyId(t: FakeTransport): string {
  return (t.sent[0] as { type: 'session.ready'; sessionId: string }).sessionId;
}

describe('tier 2 is unreachable through the gateway', () => {
  it.each(VERIFIED_TOOLS)('%s returns verification_required', async (toolName) => {
    const moduleRef = await bootRealModule(toolName);
    const gateway = moduleRef.get(VoiceGateway);
    const executor = moduleRef.get(ToolExecutorService);

    const results: VoiceToolResult[] = [];
    const realExecute = executor.execute.bind(executor);
    jest.spyOn(executor, 'execute').mockImplementation(async (...args) => {
      const result = await realExecute(...args);
      results.push(result);
      return result;
    });

    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    await gateway.handleFrame(t, { type: 'turn.text', text: `please ${toolName}` });

    expect(results).toEqual([{ status: 'failed', error: 'verification_required' }]);

    await moduleRef.close();
  }, 20000);

  it('registers every real tool, so the sweep above is not checking an empty registry', async () => {
    const moduleRef = await bootRealModule('get_clinic_info');
    const registry = moduleRef.get(ToolRegistryService);

    const names = registry.all().map((t) => t.name);
    for (const verified of VERIFIED_TOOLS) {
      expect(names).toContain(verified);
    }
    expect(names.length).toBeGreaterThanOrEqual(10);

    await moduleRef.close();
  }, 20000);

  it('leaves identityVerified false for the life of the session', async () => {
    const moduleRef = await bootRealModule('get_clinic_info');
    const gateway = moduleRef.get(VoiceGateway);
    const store = moduleRef.get(VoiceSessionStore);

    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    const id = readyId(t);
    await gateway.handleFrame(t, { type: 'turn.text', text: 'what are your hours?' });

    const session = store.get(id)?.session ?? store.get(readyId(t))?.session;
    expect(session?.identityVerified).toBe(false);

    await moduleRef.close();
  }, 20000);
});

describe('nothing in the transport can grant verification', () => {
  const TRANSPORT_DIR = join(__dirname, '../../src/modules/voice/transport');
  const files = readdirSync(TRANSPORT_DIR).filter((f) => f.endsWith('.ts'));

  it('has transport files to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files)('%s never assigns identityVerified', (file) => {
    const source = readFileSync(join(TRANSPORT_DIR, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(source).not.toMatch(/identityVerified\s*=[^=]/);
  });

  it('has no production caller of createVerifiedSession', () => {
    const hits = execSync("grep -rl 'createVerifiedSession' apps/api/src || true", {
      cwd: REPO_ROOT,
    })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);

    // Phase 2 gave it exactly one production caller: the identity path, which
    // builds a verified session only from a redeemed one-time ticket. Pinned
    // to that single file so a second call site anywhere else fails here.
    expect(hits.sort()).toEqual([
      'apps/api/src/modules/voice/session/voice-session.ts',
      'apps/api/src/modules/voice/transport/voice.gateway.ts',
    ]);
  });

  it('writes no identity verification flow anywhere in the voice module', () => {
    const hits = execSync(
      "grep -rniE 'verifyIdentity|identity_verification|verifyPatient|proveIdentity' apps/api/src/modules/voice || true",
      { cwd: REPO_ROOT }
    )
      .toString()
      .trim();

    // Verification is a later phase. Its absence is the security property.
    expect(hits).toBe('');
  });
});
