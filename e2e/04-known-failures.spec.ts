import { test, expect } from '@playwright/test';

/** Retest of the reports validation defect found in the API-level sweep. */
test.describe('RETEST — reports date validation', () => {
  const cases = [
    { label: 'no date params', qs: '' },
    { label: 'invalid startDate', qs: '?startDate=banana&endDate=2026-12-31' },
    { label: 'valid dates (control)', qs: '?startDate=2026-01-01&endDate=2026-12-31' },
  ];

  for (const c of cases) {
    test(`GET /reports/revenue with ${c.label}`, async ({ page, request }) => {
      const login = await request.post('http://localhost:3001/api/auth/login', {
        data: { email: 'admin@smileflow.com', password: 'password123' },
      });
      if (login.status() === 429) test.skip(true, 'login throttled (5/min) — infrastructure, not a product failure');
      const token = (await login.json()).accessToken;

      const res = await request.get(`http://localhost:3001/api/reports/revenue${c.qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.text();
      console.log(`   ${c.label}: HTTP ${res.status()} — ${body.slice(0, 110)}`);

      if (c.label.startsWith('valid')) {
        expect(res.status()).toBe(200);
      } else {
        // A client-side mistake must be a 4xx, not a 500.
        expect(res.status(), 'missing/invalid query params should be 400, not 500').toBeLessThan(500);
      }
    });
  }
});
