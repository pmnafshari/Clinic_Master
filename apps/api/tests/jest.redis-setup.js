/**
 * Points every Redis connection in this worker at its own numbered database.
 *
 * Jest runs suites in parallel workers, and several of them flush between
 * tests. Suites that boot the real VoiceModule build their connection from
 * REDIS_URL, so without this they would all share database 0 and erase each
 * other's state mid-run — a failure that looks exactly like a concurrency bug
 * and is not one.
 *
 * Test-only. Production reads REDIS_URL unchanged.
 */
const worker = Number(process.env.JEST_WORKER_ID || '1') % 16;
const base = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.REDIS_URL = `${base.replace(/\/\d+$/, '')}/${worker}`;
