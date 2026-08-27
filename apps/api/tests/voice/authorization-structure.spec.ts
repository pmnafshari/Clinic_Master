import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

function readsOf(pattern: RegExp): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of sourceFiles(SRC)) {
    readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
      // Comments describe the rule; they do not implement it.
      const code = text.replace(/^\s*(\*|\/\/).*$/, '');
      if (pattern.test(code)) {
        hits.push({ file: file.slice(SRC.length + 1), line: i + 1, text: text.trim() });
      }
    });
  }
  return hits;
}

/**
 * Authorization must not drift back to the raw flag.
 *
 * `identityVerified` on its own says a session was verified at some point. It
 * says nothing about whether that verification still stands, because a phone
 * grant carries a deadline and a browser grant does not. Every place that
 * decides what a session may *do* has to consult `isVerificationActive`, and
 * the cheapest way to keep that true is to make a new reader fail the suite.
 */
describe('the raw verification flag has no unguarded readers', () => {
  it('is read in exactly the known places', () => {
    const reads = readsOf(/\.identityVerified/);
    const located = reads.map((r) => `${r.file}:${r.line}`);

    expect(new Set(located)).toEqual(
      new Set([
        // The rule itself.
        'modules/voice/session/verification.ts:32',
        // Writes, not reads: the phone promotion helper.
        'modules/voice/session/voice-session.ts:136',
        // Audit only. Explicitly permitted: the record states raw *and*
        // effective, so it can be read against the decision it describes.
        'modules/voice/tools/tool-executor.service.ts:130',
      ])
    );
  });

  it('routes the Tier 2 gate through isVerificationActive', () => {
    const executor = readFileSync(
      join(SRC, 'modules/voice/tools/tool-executor.service.ts'),
      'utf8'
    );

    expect(executor).toContain("tool.tier === 'verified' && !isVerificationActive(session)");
    // The gate and the audit line live in the same file, so counting reads is
    // not enough on its own — this pins which of them is the decision.
    expect(executor).not.toMatch(/tier === 'verified' && !session\.identityVerified/);
  });

  it('keeps the deadline out of anything a client can name', () => {
    const frames = readFileSync(join(SRC, 'modules/voice/transport/frames.ts'), 'utf8');

    expect(frames).toContain("'verifiedUntil'");
    expect(frames).toContain("'verified_until'");
  });
});
