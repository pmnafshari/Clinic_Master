import { AuditService } from '../../src/modules/audit/audit.service';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { VoiceTool } from '../../src/modules/voice/tools/tool-definition.interface';
import {
  createAnonymousSession,
  createVerifiedSession,
  promoteToPhoneVerified,
  VoiceSession,
} from '../../src/modules/voice/session/voice-session';
import { isVerificationActive } from '../../src/modules/voice/session/verification';
import {
  privilegeChanged,
  snapshotPrivilege,
} from '../../src/modules/voice/session/privilege-change';
import { VoiceSessionStore } from '../../src/modules/voice/session/voice-session.store';
import { testRedis } from './redis-test-util';

const NOW = 1_700_000_000_000;
const TEN_MINUTES = 10 * 60 * 1000;

function verifiedTool(): VoiceTool {
  return {
    name: 'private_thing',
    tier: 'verified',
    description: 'stub',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ status: 'ok', ran: true }),
  };
}

/** A phone-verified session with an explicit deadline. */
function phoneSession(verifiedUntil: number): VoiceSession {
  const session = createAnonymousSession('s-phone');
  promoteToPhoneVerified(session, {
    userId: 'u1',
    patientId: 'p1',
    now: verifiedUntil - TEN_MINUTES,
    ttlMs: TEN_MINUTES,
  });
  return session;
}

describe('isVerificationActive', () => {
  it('is false for an anonymous session', () => {
    expect(isVerificationActive(createAnonymousSession('s1'), NOW)).toBe(false);
  });

  it('is true for a browser session, which has no deadline', () => {
    const session = createVerifiedSession('s1', 'u1', 'p1');

    expect(session.verifiedUntil).toBeNull();
    expect(isVerificationActive(session, NOW)).toBe(true);
    // The JWT was checked at connect and the connection is the grant, so this
    // stays true for as long as the session itself lives.
    expect(isVerificationActive(session, NOW + 100 * TEN_MINUTES)).toBe(true);
  });

  it('is true for a phone session before its deadline', () => {
    expect(isVerificationActive(phoneSession(NOW + 1000), NOW)).toBe(true);
  });

  it('is false for a phone session after its deadline', () => {
    expect(isVerificationActive(phoneSession(NOW - 1), NOW)).toBe(false);
  });

  it('is false exactly at the deadline', () => {
    // Strictly greater than, not greater-or-equal: at the deadline the grant
    // has run out.
    expect(isVerificationActive(phoneSession(NOW), NOW)).toBe(false);
  });

  it('ignores a deadline when the session was never verified', () => {
    const session = createAnonymousSession('s1');
    session.verifiedUntil = NOW + TEN_MINUTES;

    // A deadline is meaningless without the flag; it must never grant on its own.
    expect(isVerificationActive(session, NOW)).toBe(false);
  });

  it('treats a legacy record with no deadline key as unbounded', () => {
    // Written before the deploy: JSON.parse yields undefined for the new key.
    // Nothing but createVerifiedSession could set the flag then, so every such
    // record is a browser session and null is its correct value.
    const legacy = { identityVerified: true } as unknown as VoiceSession;

    expect(isVerificationActive(legacy, NOW)).toBe(true);
  });
});

describe('the Tier 2 gate authorizes on effective verification', () => {
  let registry: ToolRegistryService;
  let executor: ToolExecutorService;
  let auditLog: jest.Mock;

  beforeEach(() => {
    registry = new ToolRegistryService();
    auditLog = jest.fn().mockResolvedValue(undefined);
    executor = new ToolExecutorService(registry, { log: auditLog } as unknown as AuditService);
    registry.register(verifiedTool());
  });

  it('runs a verified tool for a browser session', async () => {
    const result = await executor.execute('private_thing', {}, createVerifiedSession('s1', 'u1', 'p1'));
    expect(result.status).toBe('ok');
  });

  it('runs a verified tool for a live phone session', async () => {
    const result = await executor.execute('private_thing', {}, phoneSession(Date.now() + TEN_MINUTES));
    expect(result.status).toBe('ok');
  });

  it('refuses a verified tool once the phone deadline has passed', async () => {
    const result = await executor.execute('private_thing', {}, phoneSession(Date.now() - 1));

    expect(result.status).toBe('failed');
    expect(result.error).toBe('verification_required');
    expect(result.ran).toBeUndefined();
  });

  it('refuses an expired session with the same error as one never verified', async () => {
    const expired = await executor.execute('private_thing', {}, phoneSession(Date.now() - 1));
    const never = await executor.execute('private_thing', {}, createAnonymousSession('s2'));

    // "Expired" and "never verified" must be indistinguishable: telling them
    // apart says something about a session the caller may not own.
    expect(expired).toEqual(never);
  });

  describe('the audit record', () => {
    it('cannot contradict a refusal', async () => {
      const session = phoneSession(Date.now() - 1);
      await executor.execute('private_thing', {}, session);

      const payload = auditLog.mock.calls[0][0].newValues;
      expect(payload.status).toBe('failed');
      // Raw says it was verified once; effective says it was not verified when
      // the call was refused. Recording only the raw flag would make the
      // forensic record disagree with the decision it describes.
      expect(payload.identityVerified).toBe(true);
      expect(payload.verificationActive).toBe(false);
      expect(payload.verifiedUntil).toBe(session.verifiedUntil);
    });

    it('agrees with an allowed call', async () => {
      const session = phoneSession(Date.now() + TEN_MINUTES);
      await executor.execute('private_thing', {}, session);

      const payload = auditLog.mock.calls[0][0].newValues;
      expect(payload.status).toBe('ok');
      expect(payload.identityVerified).toBe(true);
      expect(payload.verificationActive).toBe(true);
      expect(payload.verifiedUntil).toBe(session.verifiedUntil);
    });

    it('records a browser session as verified with no deadline', async () => {
      await executor.execute('private_thing', {}, createVerifiedSession('s1', 'u1', 'p1'));

      const payload = auditLog.mock.calls[0][0].newValues;
      expect(payload.identityVerified).toBe(true);
      expect(payload.verificationActive).toBe(true);
      expect(payload.verifiedUntil).toBeNull();
    });
  });
});

describe('privilege rotation compares effective verification', () => {
  it('treats anonymous to phone-verified as a gain', () => {
    const session = createAnonymousSession('s1');
    const before = snapshotPrivilege(session, NOW);

    promoteToPhoneVerified(session, { userId: 'u1', patientId: 'p1', now: NOW, ttlMs: TEN_MINUTES });

    expect(privilegeChanged(before, session, NOW)).toBe(true);
  });

  it('treats re-verification after expiry as a new gain', () => {
    const session = phoneSession(NOW - 1);
    // Snapshotted while expired: effectively unverified, even though the raw
    // flag is still true.
    const before = snapshotPrivilege(session, NOW);
    expect(before.verificationActive).toBe(false);

    promoteToPhoneVerified(session, { userId: 'u1', patientId: 'p1', now: NOW, ttlMs: TEN_MINUTES });

    // The raw boolean is true on both sides, so a raw comparison sees no change
    // and never rotates — leaving a bearer id that existed at lower privilege.
    expect(session.identityVerified).toBe(true);
    expect(privilegeChanged(before, session, NOW)).toBe(true);
  });

  it('does not rotate when verification merely expires', () => {
    const session = phoneSession(NOW + 1000);
    const before = snapshotPrivilege(session, NOW);

    // Same session, later clock: the deadline has passed.
    const after = NOW + 2000;

    // Expiry is a privilege *loss*. Rotation exists to retire a credential that
    // was exposed at lower privilege, and losing access does not create that.
    expect(privilegeChanged(before, session, after)).toBe(false);
  });

  it('sees no change across a browser session that was born verified', () => {
    const session = createVerifiedSession('s1', 'u1', 'p1');
    const before = snapshotPrivilege(session, NOW);

    expect(privilegeChanged(before, session, NOW)).toBe(false);
  });

  it('still treats gaining a patient as a gain', () => {
    const session = createAnonymousSession('s1');
    const before = snapshotPrivilege(session, NOW);
    session.patientId = 'p1';

    expect(privilegeChanged(before, session, NOW)).toBe(true);
  });
});

describe('the deadline survives storage and rotation', () => {
  let store: VoiceSessionStore;

  beforeAll(() => {
    store = new VoiceSessionStore(testRedis());
  });

  it('round-trips a deadline through Redis unchanged', async () => {
    const session = phoneSession(NOW + TEN_MINUTES);
    await store.set(session.sessionId, { session, history: [] });

    const loaded = await store.get(session.sessionId);
    expect(loaded!.session.verifiedUntil).toBe(session.verifiedUntil);
  });

  it('normalizes a legacy record with no deadline key to null', async () => {
    const legacy = createVerifiedSession('s-legacy', 'u1', 'p1');
    const raw = JSON.parse(JSON.stringify({ session: legacy, history: [] }));
    delete raw.session.verifiedUntil;
    await testRedis().set(`voice:session:${legacy.sessionId}`, JSON.stringify(raw), 'EX', 60);

    const loaded = await store.get(legacy.sessionId);

    // Not undefined: authorization must see the same shape whatever wrote the
    // record, and an in-flight caller must not be logged out by the deploy.
    expect(loaded!.session.verifiedUntil).toBeNull();
    expect(isVerificationActive(loaded!.session, NOW)).toBe(true);
  });

  it('carries an unexpired deadline across rotation without extending it', async () => {
    const session = phoneSession(Date.now() + TEN_MINUTES);
    await store.set(session.sessionId, { session, history: [] });

    const rotated = await store.rotate(session.sessionId);

    const loaded = await store.get(rotated!);
    expect(loaded!.session.verifiedUntil).toBe(session.verifiedUntil);
    expect(loaded!.session.sessionId).toBe(rotated);
  });

  it('never resurrects an expired verification by rotating', async () => {
    const session = phoneSession(Date.now() - 1);
    await store.set(session.sessionId, { session, history: [] });

    const rotated = await store.rotate(session.sessionId);
    const loaded = await store.get(rotated!);

    // Rotation copies the deadline verbatim rather than recomputing it from the
    // rotation time, so a new credential grants nothing the old one had lost.
    expect(loaded!.session.verifiedUntil).toBe(session.verifiedUntil);
    expect(isVerificationActive(loaded!.session)).toBe(false);
  });
});
