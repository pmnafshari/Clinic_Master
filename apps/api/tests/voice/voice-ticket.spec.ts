import { VoiceTicketService, TICKET_TTL_MS, MAX_PENDING_TICKETS } from '../../src/modules/voice/session/voice-ticket.service';
import { VOICE_CLOCK } from '../../src/modules/voice/util/bounded-ttl-map';
import { Test } from '@nestjs/testing';

async function withClock(now: () => number) {
  const moduleRef = await Test.createTestingModule({
    providers: [VoiceTicketService, { provide: VOICE_CLOCK, useValue: now }],
  }).compile();
  return moduleRef.get(VoiceTicketService);
}

describe('voice auth tickets', () => {
  it('pins the lifetime and the cap to literals', () => {
    expect(TICKET_TTL_MS).toBe(60000);
    expect(MAX_PENDING_TICKETS).toBe(1000);
  });

  it('issues an opaque ticket with session-grade entropy', () => {
    const ticket = new VoiceTicketService().issue('user-1');
    expect(ticket).toHaveLength(43);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('carries no identity in the ticket itself', () => {
    const ticket = new VoiceTicketService().issue('user-1');
    // The ticket is a random key into a server-side map. Anything derivable
    // from it would be identity travelling to the browser.
    expect(ticket).not.toContain('user-1');
    expect(Buffer.from(ticket, 'base64url').toString('utf8')).not.toContain('user-1');
  });

  it('redeems once and never again', () => {
    const service = new VoiceTicketService();
    const ticket = service.issue('user-1');

    expect(service.consume(ticket)).toBe('user-1');
    // A replay, or a second socket racing the first, finds nothing.
    expect(service.consume(ticket)).toBeUndefined();
    expect(service.consume(ticket)).toBeUndefined();
    expect(service.pending).toBe(0);
  });

  it('fails closed on an unknown or malformed ticket', () => {
    const service = new VoiceTicketService();
    for (const bad of ['', 'not-a-ticket', 'x'.repeat(43), '../../etc/passwd']) {
      expect(service.consume(bad)).toBeUndefined();
    }
  });

  it('fails closed once the ticket has expired', async () => {
    let now = 1_000_000;
    const service = await withClock(() => now);
    const ticket = service.issue('user-1');

    now += TICKET_TTL_MS - 1;
    expect(service.consume(ticket)).toBe('user-1');

    const second = service.issue('user-2');
    now += TICKET_TTL_MS;
    expect(service.consume(second)).toBeUndefined();
  });

  it('keeps two users\' tickets separate', () => {
    const service = new VoiceTicketService();
    const a = service.issue('user-a');
    const b = service.issue('user-b');

    expect(service.consume(a)).toBe('user-a');
    expect(service.consume(b)).toBe('user-b');
  });
});
