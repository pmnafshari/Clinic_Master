import { Redis } from 'ioredis';
import { VOICE_REDIS } from '../../src/modules/voice/session/redis.provider';

const opened: Redis[] = [];

/**
 * A connection scoped to this Jest worker.
 *
 * Suites run in parallel workers, and several of them flush the database
 * between tests. Sharing one database would let one suite erase another's
 * state mid-run, which looks exactly like a real concurrency bug and is not
 * one. Redis ships sixteen numbered databases; one per worker keeps them
 * apart without any coordination.
 */
export function testRedis(): Redis {
  // REDIS_URL already carries this worker's database index — see
  // tests/jest.redis-setup.js. Using it here keeps the helper and any suite
  // that boots the real module on the same database.
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 2,
  });
  opened.push(connection);
  return connection;
}

/** A DI provider backed by this worker's connection. */
export function redisTestProvider() {
  return { provide: VOICE_REDIS, useValue: testRedis() };
}

afterAll(async () => {
  await Promise.all(opened.map((c) => c.quit().catch(() => undefined)));
  opened.length = 0;
});
