import { Test } from '@nestjs/testing';
import { readFileSync } from 'fs';
import { join } from 'path';
import { VerifiedIdentityService } from '../../src/modules/voice/session/verified-identity.service';
import { VoiceTicketService } from '../../src/modules/voice/session/voice-ticket.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { redisTestProvider } from './redis-test-util';

async function build(patientForUser: Record<string, string | null>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      VerifiedIdentityService,
      VoiceTicketService,
      redisTestProvider(),
      {
        provide: PrismaService,
        useValue: {
          patient: {
            findUnique: jest.fn(async ({ where }: { where: { userId: string } }) => {
              const id = patientForUser[where.userId];
              return id ? { id } : null;
            }),
          },
        },
      },
    ],
  }).compile();

  return {
    identity: moduleRef.get(VerifiedIdentityService),
    tickets: moduleRef.get(VoiceTicketService),
  };
}

describe('server-side identity binding', () => {
  it('resolves a ticket to the patient linked to that user', async () => {
    const { identity, tickets } = await build({ 'user-1': 'patient-1' });
    const ticket = await tickets.issue('user-1');

    expect(await identity.resolve(ticket)).toEqual({ userId: 'user-1', patientId: 'patient-1' });
  });

  it('refuses a user with no linked patient rather than half-verifying', async () => {
    const { identity, tickets } = await build({ 'staff-1': null });
    const ticket = await tickets.issue('staff-1');

    // A staff account has a User but no Patient. Returning a userId with no
    // patientId would leave a session verified with nothing to act on.
    expect(await identity.resolve(ticket)).toBeNull();
  });

  it('fails closed on an unknown, malformed or already-used ticket', async () => {
    const { identity, tickets } = await build({ 'user-1': 'patient-1' });
    const used = await tickets.issue('user-1');
    await identity.resolve(used);

    expect(await identity.resolve(used)).toBeNull();
    expect(await identity.resolve('not-a-ticket')).toBeNull();
    expect(await identity.resolve('')).toBeNull();
  });

  it('takes only a ticket, so no caller can name the identity it wants', () => {
    // The signature is the guarantee: there is no parameter here to pass a
    // userId or patientId into, so no client input can select whose records a
    // session reaches.
    expect(VerifiedIdentityService.prototype.resolve).toHaveLength(1);

    const source = readFileSync(
      join(__dirname, '../../src/modules/voice/session/verified-identity.service.ts'),
      'utf8'
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/resolve\(ticket: string\)/);
    expect(code).not.toMatch(/resolve\([^)]*patientId/);
    expect(code).not.toMatch(/resolve\([^)]*userId/);
  });

  it('two users resolve to their own patients only', async () => {
    const { identity, tickets } = await build({ 'user-a': 'patient-a', 'user-b': 'patient-b' });

    expect(await identity.resolve(await tickets.issue('user-a'))).toEqual({
      userId: 'user-a', patientId: 'patient-a',
    });
    expect(await identity.resolve(await tickets.issue('user-b'))).toEqual({
      userId: 'user-b', patientId: 'patient-b',
    });
  });
});
