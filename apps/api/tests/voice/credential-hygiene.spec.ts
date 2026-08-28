import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../../..');
const API_SRC = join(__dirname, '../../src');
const WEB = join(REPO, 'apps/web');

function filesUnder(dir: string, exts: string[]): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(filesUnder(full, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

/** Every secret the phone channel introduces. None may reach a browser. */
const SERVER_ONLY = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'TWILIO_VOICE_WEBHOOK_URL',
  'OTP_HMAC_SECRET',
];

describe('phone credentials stay on the server', () => {
  it('never appears in the web application', () => {
    const web = filesUnder(WEB, ['.ts', '.tsx', '.js', '.jsx', '.json']);
    expect(web.length).toBeGreaterThan(0);

    for (const file of web) {
      const source = readFileSync(file, 'utf8');
      for (const name of SERVER_ONLY) {
        expect(`${file.slice(REPO.length + 1)}:${source.includes(name)}`).toBe(
          `${file.slice(REPO.length + 1)}:false`
        );
      }
    }
  });

  it('has no NEXT_PUBLIC_ variant anywhere in the repository', () => {
    const sources = [
      ...filesUnder(API_SRC, ['.ts']),
      ...filesUnder(WEB, ['.ts', '.tsx']),
      join(REPO, '.env.example'),
      join(REPO, 'docker/docker-compose.yml'),
      join(REPO, '.github/workflows/ci.yml'),
    ];

    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      // A browser-readable Twilio credential is one an attacker can bill.
      expect(source).not.toMatch(/NEXT_PUBLIC_[A-Z_]*TWILIO/);
      expect(source).not.toMatch(/NEXT_PUBLIC_[A-Z_]*OTP/);
    }
  });

  it('carries no credential literal in API source', () => {
    for (const file of filesUnder(API_SRC, ['.ts'])) {
      const source = readFileSync(file, 'utf8');
      // Live Twilio identifiers, and anything that looks like a stored token.
      expect(source).not.toMatch(/\bAC[0-9a-f]{32}\b/);
      expect(source).not.toMatch(/\bSK[0-9a-f]{32}\b/);
    }
  });

  it('keeps CI free of Twilio credentials', () => {
    const ci = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');

    // CI never places a call and never sends an SMS. A credential here is one
    // an attacker with repository access could bill.
    expect(ci).not.toMatch(/TWILIO_ACCOUNT_SID/);
    expect(ci).not.toMatch(/TWILIO_AUTH_TOKEN/);
    expect(ci).not.toMatch(/TWILIO_PHONE_NUMBER/);
    expect(ci).toMatch(/SMS_PROVIDER:\s*logging/);
    expect(ci).toMatch(/VOICE_PHONE_ENABLED:\s*'false'/);
  });

  it('ships an .env.example that configures nothing dangerous by default', () => {
    const env = readFileSync(join(REPO, '.env.example'), 'utf8');

    expect(env).toMatch(/^VOICE_PHONE_ENABLED=false$/m);
    // `mock` was never implemented and now fails closed; advertising it would
    // hand operators a config that looks right and silently sends nothing.
    expect(env).not.toMatch(/^SMS_PROVIDER=mock$/m);
    expect(env).toMatch(/^SMS_PROVIDER=logging$/m);
    // Credentials are declared but empty: nothing real is committed.
    for (const name of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'OTP_HMAC_SECRET']) {
      expect(env).toMatch(new RegExp(`^${name}=$`, 'm'));
    }
  });

  it('no longer tells operators that voice state is in-process', () => {
    const env = readFileSync(join(REPO, '.env.example'), 'utf8');

    // Stale since the Redis migration, and it advised the opposite of what the
    // shared ticket store enables.
    expect(env).not.toMatch(/state is in-process/);
    expect(env).not.toMatch(/needs sticky routing/);
  });
});
