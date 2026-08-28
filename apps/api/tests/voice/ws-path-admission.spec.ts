import { WsOriginAdapter } from '../../src/modules/voice/transport/ws-origin.adapter';
import { WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE } from '../../src/modules/voice/transport/transport-limits';

const ALLOWED = 'http://localhost:3000';

function adapter(): WsOriginAdapter {
  return new WsOriginAdapter({ get: () => undefined } as never);
}

/** Captures the verifyClient the adapter hands to the ws server. */
function verifierFor(a: WsOriginAdapter): (info: unknown) => boolean {
  // Same seam the existing WS security suite uses: stub the WsAdapter base so
  // the options this adapter builds can be read without a real ws server.
  let verify: ((info: unknown) => boolean) | undefined;
  Object.getPrototypeOf(Object.getPrototypeOf(a)).create = (
    _port: number,
    options: Record<string, unknown>
  ) => {
    verify = options.verifyClient as (info: unknown) => boolean;
    return {};
  };
  a.create(0, {});
  return verify!;
}

function info(url: string, origin?: string, ip = '10.0.0.1') {
  return { origin, req: { url, socket: { remoteAddress: ip } } };
}

describe('browser and phone sockets are admitted by different rules', () => {
  beforeEach(() => {
    process.env.FRONTEND_URL = ALLOWED;
  });

  describe('the browser path is unchanged', () => {
    it('admits an allowed origin', () => {
      expect(verifierFor(adapter())(info('/voice', ALLOWED))).toBe(true);
    });

    it('still rejects an absent Origin', () => {
      // The single most important regression in this task: the phone path needs
      // Origin-less connections, and the browser path must not inherit that.
      expect(verifierFor(adapter())(info('/voice', undefined))).toBe(false);
    });

    it('still rejects a disallowed origin', () => {
      expect(verifierFor(adapter())(info('/voice', 'https://evil.example.com'))).toBe(false);
    });

    it('still rejects a look-alike origin', () => {
      expect(verifierFor(adapter())(info('/voice', `${ALLOWED}.attacker.test`))).toBe(false);
    });

    it('still enforces the per-IP connection cap', () => {
      const verify = verifierFor(adapter());
      for (let i = 0; i < WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE; i += 1) {
        expect(verify(info('/voice', ALLOWED))).toBe(true);
      }
      expect(verify(info('/voice', ALLOWED))).toBe(false);
    });
  });

  describe('the phone path', () => {
    it('admits a connection with no Origin, because Twilio sends none', () => {
      expect(verifierFor(adapter())(info('/voice/phone', undefined))).toBe(true);
    });

    it('is not subject to the browser per-IP cap', () => {
      const verify = verifierFor(adapter());
      // Every Twilio media stream arrives from a small set of egress addresses,
      // so a shared per-IP cap would start refusing a busy clinic's calls.
      for (let i = 0; i < WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE * 3; i += 1) {
        expect(verify(info('/voice/phone', undefined, '3.3.3.3'))).toBe(true);
      }
    });

    it('does not spend the browser IP budget', () => {
      const verify = verifierFor(adapter());
      for (let i = 0; i < WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE * 2; i += 1) {
        verify(info('/voice/phone', undefined, '4.4.4.4'));
      }

      // A flood of phone connections must not lock a browser out of the same IP.
      expect(verify(info('/voice', ALLOWED, '4.4.4.4'))).toBe(true);
    });
  });

  describe('the branch is by exact path, not by pattern', () => {
    it.each([
      '/voice/phoney',
      '/voice/phone/../',
      '/voicephone',
      '/voice/phone/extra',
      '/VOICE/PHONE',
    ])('treats %s as the browser path', (url) => {
      // Anything that is not exactly the phone path gets browser rules, so a
      // near-miss cannot become an Origin-free entry point.
      expect(verifierFor(adapter())(info(url, undefined))).toBe(false);
    });

    it('applies phone rules when the path carries the ticket query', () => {
      expect(verifierFor(adapter())(info('/voice/phone?ticket=abc', undefined))).toBe(true);
    });

    it('falls back to browser rules when there is no URL at all', () => {
      const verify = verifierFor(adapter());
      expect(verify({ origin: undefined, req: { socket: { remoteAddress: '1.1.1.1' } } })).toBe(false);
    });
  });
});
