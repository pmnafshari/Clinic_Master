import { test, expect } from '@playwright/test';
import { login, clickNav, collectDiagnostics, reportDiagnostics, shot } from './helpers';

const STAFF_NAV = ['/patients', '/appointments', '/treatment-plans', '/billing/invoices', '/reports', '/settings'];

for (const who of ['admin', 'dentist', 'receptionist'] as const) {
  test.describe(`${who} journey`, () => {
    test(`${who} logs in, then navigates by clicking the real nav`, async ({ page }, info) => {
      test.setTimeout(180_000);
      const d = collectDiagnostics(page);
      await login(page, who);
      await page.waitForTimeout(2000);

      expect(page.url(), 'should leave /login after a valid login').not.toContain('/login');
      await shot(page, info, `${who}-dashboard`);

      const results: string[] = [];
      for (const href of STAFF_NAV) {
        const clicked = await clickNav(page, href);
        if (!clicked) { results.push(`${href}: NO NAV LINK`); continue; }
        const body = (await page.locator('body').innerText().catch(() => '')) || '';
        const landed = page.url().replace('http://localhost:3000', '');
        results.push(`${href}: → ${landed} (${body.length}ch)`);
        await shot(page, info, `${who}-${href.replace(/\//g, '_')}`);
        await clickNav(page, '/dashboard');
      }
      results.forEach((r) => console.log(`   ${who} ${r}`));
      console.log(reportDiagnostics(`${who}`, d));
      expect(d.pageErrors).toEqual([]);
    });
  });
}

test.describe('deep links and reload', () => {
  test('a staff page survives a direct URL visit and a refresh', async ({ page }, info) => {
    test.setTimeout(180_000);
    const d = collectDiagnostics(page);
    await login(page, 'admin');
    await page.waitForTimeout(2000);

    // Reached by clicking — this is known to work.
    const clicked = await clickNav(page, '/patients');
    expect(clicked, 'nav link to /patients must exist').toBe(true);
    const viaClick = ((await page.locator('body').innerText()) || '').length;
    console.log(`   via nav click: ${page.url().replace('http://localhost:3000','')} (${viaClick}ch)`);

    // Now reload the very same page.
    await page.reload({ waitUntil: 'networkidle' }).catch(() => undefined);
    await page.waitForTimeout(2500);
    const afterReload = page.url().replace('http://localhost:3000', '');
    const reloadBody = ((await page.locator('body').innerText().catch(() => '')) || '').length;
    console.log(`   after reload : ${afterReload} (${reloadBody}ch)`);
    await shot(page, info, 'admin-patients-after-reload');

    // And a cold direct visit.
    await page.goto('/appointments', { waitUntil: 'networkidle' }).catch(() => undefined);
    await page.waitForTimeout(2500);
    const direct = page.url().replace('http://localhost:3000', '');
    console.log(`   direct visit /appointments: ${direct}`);
    await shot(page, info, 'admin-appointments-direct');
    console.log(reportDiagnostics('deep link', d));

    expect(afterReload, 'refreshing /patients must stay on /patients').toContain('/patients');
    expect(direct, 'a direct visit to /appointments must stay there').toContain('/appointments');
  });
});

test.describe('patient journey', () => {
  test('patient logs in and sees only their own portal', async ({ page }, info) => {
    test.setTimeout(180_000);
    const d = collectDiagnostics(page);
    await login(page, 'patient');
    // The portal renders after its own data fetches settle; clicking sooner
    // finds no nav and reports a failure that is only impatience.
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(5000);
    console.log(`   landed on: ${page.url()}`);
    await shot(page, info, 'patient-home');

    for (const href of ['/portal/appointments', '/portal/invoices', '/portal/treatments', '/portal/profile']) {
      const ok = await clickNav(page, href);
      const body = (await page.locator('body').innerText().catch(() => '')) || '';
      console.log(`   patient ${href}: ${ok ? page.url().replace('http://localhost:3000','') : 'NO NAV LINK'} (${body.length}ch)`);
      await shot(page, info, `patient-${href.replace(/\//g, '_')}`);
    }

    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    console.log(reportDiagnostics('patient', d));
    expect(/Sarah Williams|McTestface/i.test(body), 'patient must not see other patients').toBe(false);
  });
});
