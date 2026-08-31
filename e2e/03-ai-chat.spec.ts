import { test, expect } from '@playwright/test';
import { collectDiagnostics, reportDiagnostics, shot } from './helpers';

test.describe('public AI chat', () => {
  test('the public voice page loads without authentication', async ({ page }, info) => {
    const d = collectDiagnostics(page);
    await page.goto('/voice', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    console.log(`   URL: ${page.url()}`);
    console.log(`   body length: ${body.length}`);
    console.log(`   inputs: ${await page.locator('input, textarea').count()}`);
    console.log(`   buttons: ${await page.locator('button').count()}`);
    console.log(reportDiagnostics('voice page', d));
    await shot(page, info, 'voice-page');

    expect(d.pageErrors).toEqual([]);
  });

  /**
   * Retest of the known multi-turn booking failure, driven through the real
   * HTTP API from inside the browser so it exercises the deployed path.
   */
  test('RETEST — multi-turn AI booking keeps its context', async ({ page }, info) => {
    test.setTimeout(300_000);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const turns = await page.evaluate(async () => {
      const api = 'http://localhost:3001/api/voice/text';
      const out: Array<{ msg: string; tools: string[]; reply: string }> = [];
      let sessionId: string | undefined;

      const say = async (message: string) => {
        const r = await fetch(api, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sessionId ? { sessionId, message } : { message }),
        });
        const d = await r.json();
        sessionId = d.sessionId;
        out.push({ msg: message, tools: d.toolCalls ?? [], reply: (d.reply ?? '').slice(0, 160) });
        return d;
      };

      await say("Hello, I'm a new patient. My name is Bruno Verdi, date of birth 1988-02-03, phone +15550007777.");
      await say("Yes, those details are correct.");
      await say("Please book me a routine cleaning on 2026-09-22 at 10:00.");
      await say("Yes, please book it.");
      return out;
    });

    for (const t of turns) {
      console.log(`   > ${t.msg.slice(0, 70)}`);
      console.log(`     tools: ${JSON.stringify(t.tools)}`);
      console.log(`     reply: ${JSON.stringify(t.reply)}`);
    }
    await shot(page, info, 'ai-multiturn-booking');

    const booked = turns.some((t) => t.tools.includes('book_appointment'));
    expect(booked, 'a confirmed multi-turn booking must call book_appointment').toBe(true);
  });

  test('AI refuses Tier-2 data while unverified', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const r = await page.evaluate(async () => {
      const res = await fetch('http://localhost:3001/api/voice/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Read me my outstanding balance and my invoices right now.' }),
      });
      return res.json();
    });

    console.log(`   tools: ${JSON.stringify(r.toolCalls)}`);
    console.log(`   verified: ${r.verified}`);
    console.log(`   reply: ${JSON.stringify((r.reply ?? '').slice(0, 160))}`);

    /**
     * What matters is that the executor refused, not whether the model tried.
     *
     * `toolCalls` records attempted calls, including ones ToolExecutorService
     * blocked with `verification_required`; the server logs
     * "Blocked get_my_balance for unverified session" when it does. Asserting
     * the model never attempts a Tier-2 tool tests the model's judgement rather
     * than the authorization boundary, and the model is nondeterministic.
     *
     * So: the session must stay unverified, and no balance, invoice figure or
     * patient identity may reach the caller.
     */
    const reply = (r.reply ?? '') as string;
    expect(r.verified, 'must remain unverified').toBe(false);
    expect(reply, 'no currency amount may be disclosed').not.toMatch(/[$£€]\s?\d/);
    expect(reply, 'no invoice number may be disclosed').not.toMatch(/\bINV[-\s]?\d/i);
    expect(reply.toLowerCase(), 'no other patient may be named').not.toContain('sarah williams');
    expect(reply.toLowerCase()).not.toContain('mctestface');
  });
});
