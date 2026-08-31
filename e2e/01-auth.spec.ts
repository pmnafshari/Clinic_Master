import { test, expect } from '@playwright/test';
import { USERS, login, collectDiagnostics, reportDiagnostics, shot } from './helpers';

test.describe('authentication', () => {
  test('login page renders and has no console errors', async ({ page }, info) => {
    const d = collectDiagnostics(page);
    await page.goto('/login', { waitUntil: 'networkidle' });

    await expect(page.locator('input#email')).toBeVisible();
    await expect(page.locator('input#password')).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();

    await shot(page, info, 'login');
    console.log(reportDiagnostics('login page', d));
    expect(d.pageErrors, 'uncaught page errors').toEqual([]);
  });

  test('rejects a wrong password and stays on /login', async ({ page }, info) => {
    const d = collectDiagnostics(page);
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.locator('input#email').fill(USERS.admin.email);
    await page.locator('input#password').fill('definitely-wrong');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForTimeout(3000);

    console.log(reportDiagnostics('wrong password', d));
    expect(page.url(), 'must not reach an authenticated page').toContain('/login');
    await shot(page, info, 'login-wrong-password');
  });

  test('unauthenticated visit to /dashboard does not expose data', async ({ page }, info) => {
    const d = collectDiagnostics(page);
    await page.goto('/dashboard', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);

    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    console.log(reportDiagnostics('unauth dashboard', d));
    console.log(`   landed on: ${page.url()}`);
    await shot(page, info, 'unauth-dashboard');

    // Either redirected away, or rendered with no real data.
    const leaked = /john\.doe@example\.com|Sarah Williams|McTestface/i.test(body);
    expect(leaked, 'unauthenticated page must not render patient data').toBe(false);
  });
});
