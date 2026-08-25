import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

/** DI token for the shared Redis connection. */
export const VOICE_REDIS = Symbol('VOICE_REDIS');

/**
 * One connection, shared by the session store and the idempotency service.
 *
 * `lazyConnect` is deliberate: a deployment with voice switched off should not
 * open a socket it never uses.
 */
export function createVoiceRedis(url = process.env.REDIS_URL): Redis {
  return new Redis(url ?? 'redis://localhost:6379', {
    lazyConnect: true,
    // A voice turn cannot wait out a long retry ladder; failing fast lets the
    // caller hear the front-desk fallback rather than silence.
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });
}

export const voiceRedisProvider = {
  provide: VOICE_REDIS,
  useFactory: () => createVoiceRedis(),
};

/**
 * Closes the connection when the application stops.
 *
 * Without this the socket outlives the process's intent to exit: a deploy
 * leaves a connection open on the Redis side until it times out, and a test
 * run never finishes because the handle is still active.
 */
@Injectable()
export class VoiceRedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(VOICE_REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') {
      await this.redis.quit().catch(() => this.redis.disconnect());
    }
  }
}
