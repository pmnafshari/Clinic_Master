import {
  createAnonymousSession,
  createVerifiedSession,
} from '../../src/modules/voice/session/voice-session';

describe('VoiceSession', () => {
  it('starts anonymous sessions unverified with no patient', () => {
    const session = createAnonymousSession('sess-1');
    expect(session.identityVerified).toBe(false);
    expect(session.userId).toBeNull();
    expect(session.patientId).toBeNull();
    expect(session.turnIndex).toBe(0);
  });

  it('starts verified sessions bound to a user and patient', () => {
    const session = createVerifiedSession('sess-2', 'user-1', 'patient-1');
    expect(session.identityVerified).toBe(true);
    expect(session.userId).toBe('user-1');
    expect(session.patientId).toBe('patient-1');
  });
});
