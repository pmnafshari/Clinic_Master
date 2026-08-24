import { parseClientFrame } from '../../src/modules/voice/transport/frames';

describe('client frame validation', () => {
  it('accepts a session.start with no session id', () => {
    const result = parseClientFrame({ type: 'session.start' });
    expect(result.ok).toBe(true);
  });

  it('accepts a session.start resuming a known id', () => {
    const result = parseClientFrame({ type: 'session.start', sessionId: 'abc' });
    expect(result.ok).toBe(true);
  });

  it('accepts a turn.text frame', () => {
    const result = parseClientFrame({ type: 'turn.text', text: 'what are your hours?' });
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown frame type', () => {
    const result = parseClientFrame({ type: 'admin.escalate' });
    expect(result).toEqual({ ok: false, code: 'bad_frame' });
  });

  it('rejects a frame that is not an object', () => {
    expect(parseClientFrame('turn.text')).toEqual({ ok: false, code: 'bad_frame' });
    expect(parseClientFrame(null)).toEqual({ ok: false, code: 'bad_frame' });
    expect(parseClientFrame([{ type: 'turn.text', text: 'hi' }])).toEqual({
      ok: false,
      code: 'bad_frame',
    });
  });

  // The wire protocol mirrors the HTTP endpoint's forbidNonWhitelisted: an
  // unexpected field is a refused frame, not a stripped one. Stripping hides
  // the fact that a client tried.
  it('rejects an unknown field rather than ignoring it', () => {
    const result = parseClientFrame({ type: 'turn.text', text: 'hi', locale: 'en' });
    expect(result).toEqual({ ok: false, code: 'bad_frame' });
  });

  it.each([
    'patientId',
    'patient_id',
    'userId',
    'user_id',
    'identityVerified',
    'identity_verified',
    'turnIndex',
    'turn_index',
    'idempotencyNonce',
    'idempotency_nonce',
    'logId',
    'log_id',
    'tier',
  ])('rejects a frame carrying the identity field %s', (field) => {
    const result = parseClientFrame({ type: 'turn.text', text: 'hi', [field]: 'x' });
    expect(result).toEqual({ ok: false, code: 'bad_frame' });
  });

  it('rejects an identity field on session.start too, not just on turns', () => {
    expect(parseClientFrame({ type: 'session.start', patientId: 'p1' })).toEqual({
      ok: false,
      code: 'bad_frame',
    });
  });

  it('rejects a non-string text on turn.text', () => {
    expect(parseClientFrame({ type: 'turn.text', text: 42 })).toEqual({
      ok: false,
      code: 'bad_frame',
    });
  });

  it('rejects an empty text', () => {
    expect(parseClientFrame({ type: 'turn.text', text: '' })).toEqual({
      ok: false,
      code: 'bad_frame',
    });
  });

  it('rejects text beyond the length cap', () => {
    const result = parseClientFrame({ type: 'turn.text', text: 'a'.repeat(4001) });
    expect(result).toEqual({ ok: false, code: 'bad_frame' });
  });

  it('pins the text cap to a literal', () => {
    expect(parseClientFrame({ type: 'turn.text', text: 'a'.repeat(4000) }).ok).toBe(true);
    expect(parseClientFrame({ type: 'turn.text', text: 'a'.repeat(4001) }).ok).toBe(false);
  });

  it('rejects a non-string sessionId', () => {
    expect(parseClientFrame({ type: 'session.start', sessionId: 99 })).toEqual({
      ok: false,
      code: 'bad_frame',
    });
  });
});
