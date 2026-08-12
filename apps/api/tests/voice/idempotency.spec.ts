import { IdempotencyService } from '../../src/modules/voice/idempotency/idempotency.service';
import { createVerifiedSession } from '../../src/modules/voice/session/voice-session';
import { VoiceToolResult } from '../../src/modules/voice/tools/tool-definition.interface';

describe('IdempotencyService', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    service = new IdempotencyService();
  });

  it('builds a key from session, turn and tool name', () => {
    const session = createVerifiedSession('s1', 'u1', 'p1');
    session.turnIndex = 3;
    expect(service.keyFor(session, 'book_appointment')).toBe('s1:3:book_appointment');
  });

  it('runs the operation once and replays the result', async () => {
    const operation = jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValue({ status: 'confirmed', appointmentId: 'a1' });

    const first = await service.runOnce('k1', operation);
    const second = await service.runOnce('k1', operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(second.appointmentId).toBe('a1');
  });

  it('does not cache failures, so a retry can genuinely retry', async () => {
    const operation = jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValueOnce({ status: 'failed', error: 'transient' })
      .mockResolvedValueOnce({ status: 'confirmed', appointmentId: 'a2' });

    const first = await service.runOnce('k2', operation);
    const second = await service.runOnce('k2', operation);

    expect(first.status).toBe('failed');
    expect(second.status).toBe('confirmed');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('keys different tools in the same turn separately', async () => {
    const session = createVerifiedSession('s1', 'u1', 'p1');
    expect(service.keyFor(session, 'book_appointment')).not.toBe(
      service.keyFor(session, 'cancel_appointment')
    );
  });
});

/**
 * The sessionId becomes client-supplied once POST /voice/text exists. Plain
 * `${sessionId}:${turnIndex}:${toolName}` concatenation is then ambiguous: a
 * sessionId containing ':' can produce the same key as a different
 * session/turn/tool triple, and a cache hit on a colliding key replays one
 * operation's result for a completely different operation.
 */
describe('IdempotencyService.keyFor — collision resistance', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    service = new IdempotencyService();
  });

  /** The construction being replaced, kept here to show what it does wrong. */
  function naiveKey(sessionId: string, turnIndex: unknown, toolName: string): string {
    return `${sessionId}:${turnIndex}:${toolName}`;
  }

  it('keeps the three components separable, so a colon in the sessionId cannot split wrong', () => {
    const session = createVerifiedSession('s:1:book_appointment', 'u1', 'p1');
    session.turnIndex = 2;

    const key = service.keyFor(session, 'cancel_appointment');
    const parts = key.split(':');

    // Naive concatenation yields five segments here, and no reader of the key
    // can tell which of them belonged to the sessionId.
    expect(naiveKey('s:1:book_appointment', 2, 'cancel_appointment').split(':')).toHaveLength(5);

    expect(parts).toHaveLength(3);
    expect(parts.map(decodeURIComponent)).toEqual([
      's:1:book_appointment',
      '2',
      'cancel_appointment',
    ]);
  });

  it('does not collide with a different session, turn and tool combination', () => {
    // Two genuinely different triples that the naive construction flattens to
    // the same string.
    const a = createVerifiedSession('sess:9', 'u1', 'p1');
    a.turnIndex = 2;

    const b = createVerifiedSession('sess', 'u2', 'p2');
    // Untrusted request bodies do not always carry the declared type; this is
    // exactly the value the naive key cannot distinguish from a's.
    (b as unknown as { turnIndex: unknown }).turnIndex = '9:2';

    expect(naiveKey('sess:9', 2, 'book_appointment')).toBe(naiveKey('sess', '9:2', 'book_appointment'));

    expect(service.keyFor(a, 'book_appointment')).not.toBe(service.keyFor(b, 'book_appointment'));
  });

  it('does not replay one session’s confirmed result for another session', async () => {
    const a = createVerifiedSession('sess:9', 'u1', 'p1');
    a.turnIndex = 2;

    const b = createVerifiedSession('sess', 'u2', 'p2');
    (b as unknown as { turnIndex: unknown }).turnIndex = '9:2';

    const bookedForA: VoiceToolResult = { status: 'confirmed', appointmentId: 'appt-for-a' };
    const bookedForB: VoiceToolResult = { status: 'confirmed', appointmentId: 'appt-for-b' };

    await service.runOnce(service.keyFor(a, 'book_appointment'), async () => bookedForA);
    const forB = await service.runOnce(
      service.keyFor(b, 'book_appointment'),
      async () => bookedForB
    );

    expect(forB.appointmentId).toBe('appt-for-b');
  });

  it('percent signs in a sessionId stay unambiguous too', () => {
    const literal = createVerifiedSession('a%3Ab', 'u1', 'p1');
    const colon = createVerifiedSession('a:b', 'u1', 'p1');

    // Escaping that did not also escape '%' would map these two distinct
    // sessions onto the same key.
    expect(service.keyFor(literal, 'book_appointment')).not.toBe(
      service.keyFor(colon, 'book_appointment')
    );
  });
});
