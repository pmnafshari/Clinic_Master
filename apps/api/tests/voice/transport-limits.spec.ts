import { readFileSync } from 'fs';
import { join } from 'path';
import {
  WS_MAX_FRAME_BYTES,
  WS_MAX_TURNS_PER_SESSION,
  WS_MAX_TURNS_PER_MINUTE,
  WS_MAX_UPLINK_BYTES_PER_TURN,
  WS_MAX_CONNECTION_MS,
  WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE,
} from '../../src/modules/voice/transport/transport-limits';
import { MAX_HISTORY_TURNS } from '../../src/modules/voice/voice.controller';
import { SESSION_TTL_MS } from '../../src/modules/voice/session/voice-session.store';

describe('websocket limits', () => {
  // Every value written out as a literal. Phase 0 shipped a test comparing
  // VOICE_CONFIG.maxTokens to itself, which passed while the value was wrong.
  it('pins each limit to a literal', () => {
    expect(WS_MAX_FRAME_BYTES).toBe(65536);
    expect(WS_MAX_TURNS_PER_SESSION).toBe(40);
    expect(WS_MAX_TURNS_PER_MINUTE).toBe(10);
    expect(WS_MAX_UPLINK_BYTES_PER_TURN).toBe(2097152);
    expect(WS_MAX_CONNECTION_MS).toBe(600000);
    expect(WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE).toBe(20);
  });

  // These are separate mechanisms and conflating them has been proposed once
  // already. MAX_HISTORY_TURNS trims what is resent to the model; the HTTP
  // throttle is per-IP on POST /voice/text; the WS limits are per-session on
  // the socket.
  it('keeps the socket turn cap independent of history trimming', () => {
    expect(MAX_HISTORY_TURNS).toBe(12);
    expect(WS_MAX_TURNS_PER_SESSION).not.toBe(MAX_HISTORY_TURNS);
    expect(WS_MAX_TURNS_PER_SESSION).toBeGreaterThan(MAX_HISTORY_TURNS);
  });

  it('closes a connection well before the session TTL expires', () => {
    // A socket must not outlive the session it is bound to.
    expect(SESSION_TTL_MS).toBe(1800000);
    expect(WS_MAX_CONNECTION_MS).toBeLessThan(SESSION_TTL_MS);
  });

  it('allows a whole session of turns within the per-minute budget', () => {
    // A lifetime cap below the rate cap would make the rate cap unreachable
    // and the lifetime cap the only real limit — a silent misconfiguration.
    expect(WS_MAX_TURNS_PER_SESSION).toBeGreaterThan(WS_MAX_TURNS_PER_MINUTE);
  });

  it('sizes one uplink turn well above a single frame', () => {
    expect(WS_MAX_UPLINK_BYTES_PER_TURN).toBeGreaterThan(WS_MAX_FRAME_BYTES);
  });

  // Declared and pinned, but deliberately not yet enforced: no frame carries
  // audio, so there is nothing to count. This test records that honestly
  // rather than letting the constant imply a control that does not exist.
  it('documents that the uplink cap is not enforced until an audio path exists', () => {
    const source = readFileSync(
      join(__dirname, '../../src/modules/voice/transport/transport-limits.ts'),
      'utf8'
    );
    expect(source).toMatch(/DECLARED BUT NOT YET ENFORCED/);

    const gateway = readFileSync(
      join(__dirname, '../../src/modules/voice/transport/voice.gateway.ts'),
      'utf8'
    );
    expect(gateway).not.toContain('WS_MAX_UPLINK_BYTES_PER_TURN');
  });
});
