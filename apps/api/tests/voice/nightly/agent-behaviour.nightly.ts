import Anthropic from '@anthropic-ai/sdk';
import { runNightlyScenarios } from './run-scenarios';
import { runJudgeCalibration } from './judge-calibration';

/**
 * Runs the fixed nightly scenario list against the real Anthropic API to
 * catch model-behaviour drift — in particular, that a clinical question is
 * still refused or escalated rather than answered. STT, TTS and telephony
 * are never involved (this is the text-only Phase 0 endpoint), so this job
 * can only ever bill Anthropic for chat completions, never a voice vendor.
 *
 * The clinical-refusal check is gated by an LLM judge (clinical-judge.ts),
 * not a regex — see that file and scenarios.ts for why. This is a
 * VERIFICATION MECHANISM FOR THIS NIGHTLY TEST ONLY. It is never wired into
 * the production request path (apps/api/src/modules/voice/**); production
 * safety comes from ToolExecutorService's tier gate (clinical/administrative
 * tools simply aren't callable) and the system prompt's refusal instruction.
 * The judge exists purely so a CI job can catch drift in that production
 * behaviour, not to authorize anything.
 *
 * Not named *.spec.ts on purpose: the default Jest testRegex
 * (`tests/.*\.spec\.ts$`) excludes this file, so it cannot run inside the
 * PR/CI suite by accident and cannot spend money outside its own scheduled
 * or manually dispatched workflow run. All of the logic this file calls is
 * unit-tested offline, with a fake client, in nightly-harness.spec.ts.
 */
async function main(): Promise<void> {
  // `new Anthropic()` reads ANTHROPIC_API_KEY from the environment itself.
  // The key is never read, logged, or interpolated into a string by this
  // file. The same client is used for both the agent's own model
  // (claude-opus-5, via VOICE_CONFIG) and the judge's model
  // (claude-haiku-4-5, explicitly configured in clinical-judge.ts) — the two
  // are wrapped by separate UsageTrackingClient instances with separate
  // budgets (NIGHTLY_TOKEN_BUDGET and JUDGE_CALIBRATION_TOKEN_BUDGET), but
  // within a single scenario run the judge call is tracked by the exact
  // same tracker as the agent's own calls — see run-scenarios.ts.
  const client = new Anthropic();

  const result = await runNightlyScenarios(client);

  console.log(`ran ${result.scenariosRun}/${result.scenariosPlanned} scenarios`);
  console.log(`total tokens used: ${result.totalTokens}`);

  // Printed unconditionally — pass or fail, whether the judge (or the
  // advisory isGenuineRefusal signal) agreed or not. The judge is the real
  // pass/fail gate for these scenarios (see run-scenarios.ts), but an LLM
  // judge can still be wrong, and the judge is verifying a safety property
  // — so this transcript is an additional automated signal on top of human
  // review, never a replacement for it. A human must still read it.
  console.log('\n=== CLINICAL REPLY — HUMAN REVIEW REQUIRED ===');
  console.log(
    'Each clinical scenario below was gated by an LLM judge (clinical-judge.ts), not just a\n' +
      'regex. The judge can still be wrong. Read each reply and judge for yourself whether it\n' +
      "declines or escalates rather than answers — do not rely on this job's exit code alone."
  );
  result.refusalTranscripts.forEach(({ name, reply, judge, advisoryRegexSignal }) => {
    console.log(`  [${name}]`);
    console.log(`    reply: "${reply}"`);
    console.log(
      `    judge: ${judge.passed ? 'PASS' : 'FAIL'} (${judge.outcome}) — ${judge.detail}`
    );
    console.log(
      `    advisory regex signal (isGenuineRefusal, not the gate): ${advisoryRegexSignal}`
    );
  });
  console.log('=== END CLINICAL REPLY REVIEW ===');

  // The judge calibration set: a fixed set of (message, reply) pairs whose
  // correct classification is known in advance, run directly against the
  // real judge model. This is what actually proves the judge model itself
  // is still classifying correctly — the scenario transcripts above prove
  // the *agent's* behaviour, this proves the *judge's*.
  const calibration = await runJudgeCalibration(client);
  console.log(`\njudge calibration: ${calibration.results.length} cases, ${calibration.totalTokens} tokens`);
  calibration.results.forEach(({ name, verdict, expectAdviceGiven }) => {
    const actual = verdict.outcome === 'advice_given';
    const agree = verdict.outcome !== 'advice_given' && verdict.outcome !== 'no_advice' ? 'INCONCLUSIVE' : actual === expectAdviceGiven ? 'MATCH' : 'MISMATCH';
    console.log(`  [${name}] expected advice_given=${expectAdviceGiven}, judge outcome=${verdict.outcome} — ${agree}`);
  });

  const failures = [...result.failures, ...calibration.failures];

  if (failures.length > 0) {
    console.error('\nNightly behaviour failures:');
    failures.forEach((failure) => console.error(`  - ${failure}`));
    process.exit(1);
  }

  console.log('\nAll scenarios passed.');
}

main().catch((error: unknown) => {
  // Never log the raw error object here: an SDK error can carry the request
  // that produced it, and that request's Authorization header holds the API
  // key. Only a plain message is safe to print.
  const message = error instanceof Error ? error.message : 'nightly run crashed';
  console.error(`Nightly run crashed: ${message}`);
  process.exit(1);
});
