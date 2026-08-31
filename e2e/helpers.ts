import { Page, TestInfo, expect } from '@playwright/test';

export const USERS = {
  admin:        { email: 'admin@smileflow.com',        password: 'password123' },
  dentist:      { email: 'dentist@smileflow.com',      password: 'password123' },
  receptionist: { email: 'receptionist@smileflow.com', password: 'password123' },
  patient:      { email: 'john.doe@example.com',       password: 'password123' },
};

/** Records everything the browser complains about, for the failure report. */
export function collectDiagnostics(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const badResponses: string[] = [];

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
  page.on('requestfailed', (r) =>
    failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText ?? 'failed'}`)
  );
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });

  return { consoleErrors, pageErrors, failedRequests, badResponses };
}

export function reportDiagnostics(
  label: string,
  d: ReturnType<typeof collectDiagnostics>
): string {
  const parts: string[] = [];
  if (d.pageErrors.length) parts.push(`pageErrors: ${JSON.stringify(d.pageErrors.slice(0, 3))}`);
  if (d.consoleErrors.length) parts.push(`consoleErrors: ${JSON.stringify(d.consoleErrors.slice(0, 3))}`);
  if (d.failedRequests.length) parts.push(`failedRequests: ${JSON.stringify(d.failedRequests.slice(0, 3))}`);
  if (d.badResponses.length) parts.push(`httpErrors: ${JSON.stringify(d.badResponses.slice(0, 5))}`);
  return parts.length ? `[${label}] ${parts.join(' | ')}` : `[${label}] clean`;
}

/** Logs in through the real UI. Throws with diagnostics if the form is not usable. */
/**
 * Login is rate limited to 5 attempts per minute per IP, so the suite paces
 * itself. Without this the later journeys receive 429s that look exactly like
 * broken authentication and are not.
 */
let lastLoginAt = 0;
const LOGIN_SPACING_MS = 14_000;

export async function login(page: Page, who: keyof typeof USERS) {
  const wait = LOGIN_SPACING_MS - (Date.now() - lastLoginAt);
  if (wait > 0) await page.waitForTimeout(wait);
  lastLoginAt = Date.now();

  const { email, password } = USERS[who];
  await page.goto('/login', { waitUntil: 'domcontentloaded' });

  const emailBox = page.locator(
    'input[type="email"], input[name="email"], input[id="email"], input[placeholder*="mail" i]'
  ).first();
  const passBox = page.locator(
    'input[type="password"], input[name="password"], input[id="password"]'
  ).first();

  await emailBox.waitFor({ state: 'visible', timeout: 15_000 });
  await emailBox.fill(email);
  await passBox.fill(password);

  await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in")').first().click();
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
}

export async function shot(page: Page, info: TestInfo, name: string) {
  const path = `e2e-artifacts/${info.project.name}-${name}.png`;
  await page.screenshot({ path, fullPage: true }).catch(() => undefined);
  return path;
}


/** Navigates the way a user does — by clicking the nav, not by typing a URL. */
export async function clickNav(page: Page, href: string): Promise<boolean> {
  // Scoped to the sidebar. The dashboard also renders quick-action cards
  // pointing at the same routes, and an unscoped selector picks one of those
  // instead — on a narrow viewport those cards sit below the fold and never
  // settle, which looks like broken navigation and is not.
  const nav = page.locator('aside, nav').first();
  const link = nav.locator(`a[href="${href}"]`).first();
  if ((await link.count()) === 0) return false;
  await link.scrollIntoViewIfNeeded().catch(() => undefined);
  await link.click();
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
  return true;
}
