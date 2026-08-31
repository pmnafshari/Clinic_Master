import { test, expect } from '@playwright/test';

const RUNS = 10;

/**
 * Ten independent new-patient bookings, driven through the real HTTP API from
 * inside a real browser.
 *
 * Turns are spaced because /voice/text allows ten requests a minute; without
 * that the later runs collect 429s that look like booking failures and are
 * only impatience.
 */
test('ten consecutive new-patient bookings all complete', async ({ page, request }, info) => {
  test.setTimeout(20 * 60 * 1000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const results = await page.evaluate(
    async ({ runs, tag }) => {
      const api = 'http://localhost:3001/api/voice/text';
      const out: Array<{
        run: number; surname: string; tools: string[][]; booked: boolean; final: string;
      }> = [];

      for (let run = 1; run <= runs; run += 1) {
        let sessionId: string | undefined;
        const tools: string[][] = [];
        let final = '';
        // Timestamped: leftover rows from an earlier execution must never be
        // mistaken for this one's, which silently inflated an earlier result.
        const surname = `Stab${tag}x${run}`;

        const say = async (message: string) => {
          const res = await fetch(api, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sessionId ? { sessionId, message } : { message }),
          });
          const d = await res.json();
          if (d.sessionId) sessionId = d.sessionId;
          tools.push(d.toolCalls ?? [`HTTP_${d.statusCode ?? '?'}`]);
          final = (d.reply ?? '').slice(0, 120);
          await new Promise((r) => setTimeout(r, 7000));
        };

        /**
         * A real caller keeps answering until they are booked or told no. A
         * fixed script does not: the assistant reads details back before any
         * write, so a conversation that needs an extra confirmation simply ran
         * out of turns and looked like a failure.
         */
        await say(`Hello, I'm a new patient. My name is Ada ${surname}, date of birth 1992-03-11, phone +15550009${String(run).padStart(3, '0')}.`);
        // A distinct hour per run, and a month derived from the run tag: earlier
        // executions of this test have already taken slots, and a clash is a
        // real booking refusal that would otherwise read as a failure of this fix.
        const hour = String(8 + (run % 9)).padStart(2, '0');
        await say(`Yes, those details are correct. Please book me a routine cleaning on 2026-11-${String(run + 9).padStart(2, '0')} at ${hour}:00.`);

        for (let turn = 0; turn < 5 && !tools.flat().includes('book_appointment'); turn += 1) {
          await say('Yes, that is correct. Please go ahead and book it.');
        }

        out.push({ run, surname, tools, booked: tools.flat().includes('book_appointment'), final });
      }
      return out;
    },
    { runs: RUNS, tag: `${info.project.name === 'mobile' ? 'M' : 'D'}${Date.now().toString().slice(-6)}` }
  );

  /**
   * The database is the only proof.
   *
   * An earlier version of this test asserted that `book_appointment` appeared
   * in the tool list, which counted a call that failed as a success — the
   * agent had invented nothing, but the test had. Two of ten "passing" runs
   * had created no patient and no appointment at all.
   */
  const login = await request.post('http://localhost:3001/api/auth/login', {
    data: { email: 'admin@smileflow.com', password: 'password123' },
  });
  expect(login.status(), 'admin login for verification').toBe(200);
  const token = (await login.json()).accessToken;

  const all = await request.get('http://localhost:3001/api/appointments', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const rows = await all.json();
  const list: unknown[] = Array.isArray(rows) ? rows : (rows.data ?? rows.items ?? []);
  const serialized = JSON.stringify(list);

  let confirmed = 0;
  for (const r of results) {
    const inDb = serialized.includes(r.surname);
    if (inDb) confirmed += 1;
    console.log(
      `   run ${String(r.run).padStart(2)} [${r.surname}] appointment_in_db=${inDb ? 'YES' : 'NO '} tools=${JSON.stringify(r.tools)}`
    );
    if (!inDb) console.log(`      final reply: ${JSON.stringify(r.final)}`);
  }
  console.log(`   ${info.project.name.toUpperCase()} STABILITY: ${confirmed}/${RUNS} appointments verified in the database`);

  expect(confirmed, `all ${RUNS} bookings must exist in the database`).toBe(RUNS);
});
