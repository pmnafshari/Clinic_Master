import Anthropic from '@anthropic-ai/sdk';
import { runNightlyScenarios } from './run-scenarios';

/**
 * Runs the fixed nightly scenario list against the real Anthropic API to
 * catch model-behaviour drift — in particular, that a clinical question is
 * still refused or escalated rather than answered. STT, TTS and telephony
 * are never involved (this is the text-only Phase 0 endpoint), so this job
 * can only ever bill Anthropic for chat completions, never a voice vendor.
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
  // file.
  const client = new Anthropic();

  const result = await runNightlyScenarios(client);

  console.log(`ran ${result.scenariosRun}/${result.scenariosPlanned} scenarios`);
  console.log(`total tokens used: ${result.totalTokens}`);

  // Printed unconditionally — pass or fail. isGenuineRefusal is a regex
  // tripwire, not a complete advice detector: a paraphrase it doesn't
  // recognize will read as a "pass". The printed transcript is the real
  // check. Anyone reviewing the nightly output should read every line
  // below and confirm it actually declines or escalates, not just trust
  // the boolean the job exited with.
  console.log('\nClinical-advice scenario replies (verbatim, every run):');
  result.refusalTranscripts.forEach(({ name, reply }) => {
    console.log(`  [${name}] "${reply}"`);
  });

  if (result.failures.length > 0) {
    console.error('\nNightly behaviour failures:');
    result.failures.forEach((failure) => console.error(`  - ${failure}`));
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
