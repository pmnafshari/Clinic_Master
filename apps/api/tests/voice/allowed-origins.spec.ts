import { allowedOrigins, isOriginAllowed } from '../../src/common/config/allowed-origins';

describe('allowed origins', () => {
  const original = process.env.FRONTEND_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = original;
  });

  it('falls back to the local dev origin when FRONTEND_URL is unset', () => {
    delete process.env.FRONTEND_URL;
    expect(allowedOrigins()).toEqual(['http://localhost:3000']);
  });

  it('falls back when FRONTEND_URL is present but empty', () => {
    process.env.FRONTEND_URL = '   ';
    expect(allowedOrigins()).toEqual(['http://localhost:3000']);
  });

  it('parses a comma separated list and trims whitespace', () => {
    process.env.FRONTEND_URL = 'https://a.example.com, https://b.example.com';
    expect(allowedOrigins()).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('accepts an origin on the list and rejects one that is not', () => {
    process.env.FRONTEND_URL = 'https://a.example.com';
    expect(isOriginAllowed('https://a.example.com')).toBe(true);
    expect(isOriginAllowed('https://evil.example.com')).toBe(false);
  });

  it('rejects a missing or empty origin', () => {
    process.env.FRONTEND_URL = 'https://a.example.com';
    expect(isOriginAllowed(undefined)).toBe(false);
    expect(isOriginAllowed('')).toBe(false);
  });

  // Exact match only. Prefix, suffix and substring matching are how origin
  // checks get bypassed: attacker registers a.example.com.evil.test.
  it('does not treat a prefix, suffix or substring as a match', () => {
    process.env.FRONTEND_URL = 'https://a.example.com';
    expect(isOriginAllowed('https://a.example.com.evil.test')).toBe(false);
    expect(isOriginAllowed('https://evil.test/https://a.example.com')).toBe(false);
    expect(isOriginAllowed('https://a.example.co')).toBe(false);
    expect(isOriginAllowed('a.example.com')).toBe(false);
  });

  it('is case sensitive on the host, so a lookalike does not slip through', () => {
    process.env.FRONTEND_URL = 'https://a.example.com';
    expect(isOriginAllowed('https://A.EXAMPLE.COM')).toBe(false);
  });

  it('reads the environment on every call, so config changes are not cached', () => {
    process.env.FRONTEND_URL = 'https://first.example.com';
    expect(isOriginAllowed('https://first.example.com')).toBe(true);
    process.env.FRONTEND_URL = 'https://second.example.com';
    expect(isOriginAllowed('https://first.example.com')).toBe(false);
    expect(isOriginAllowed('https://second.example.com')).toBe(true);
  });
});
