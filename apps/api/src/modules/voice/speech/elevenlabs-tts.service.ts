import { Injectable, Logger } from '@nestjs/common';
import { TextToSpeech } from './text-to-speech.interface';

const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';

/** A clear, unhurried voice. Overridable per deployment. */
export const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

/** Low latency matters more than the last few points of quality on a call. */
export const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5';

/**
 * ElevenLabs behind the TextToSpeech seam.
 *
 * One instance per connection — it owns an abort signal, and a shared instance
 * would let one caller hanging up silence every other live call.
 *
 * The credential is read from the environment and never leaves this file: it
 * is not logged, not included in a thrown error, and never sent to the
 * browser. A deployment without one fails closed, and the transport falls back
 * to delivering the reply as text.
 */
@Injectable()
export class ElevenLabsTtsService implements TextToSpeech {
  private readonly logger = new Logger(ElevenLabsTtsService.name);
  private controller?: AbortController;
  private cancelled = false;

  async *synthesise(text: string): AsyncIterable<Buffer> {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) {
      // Names the variable, never a value — there is nothing to leak here.
      throw new Error('ELEVENLABS_API_KEY is not configured');
    }

    if (this.cancelled) {
      return;
    }

    const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
    const controller = new AbortController();
    this.controller = controller;

    const response = await fetch(`${API_BASE}/${voiceId}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: DEFAULT_MODEL_ID }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      // The provider's body names the account and sometimes the quota state.
      // The status is enough to act on and carries nothing identifying.
      throw new Error(`speech synthesis rejected the request (${response.status})`);
    }

    const reader = response.body.getReader();
    try {
      for (;;) {
        if (this.cancelled) {
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (value && value.length > 0) {
          yield Buffer.from(value);
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  }

  /**
   * Stops an in-flight synthesis.
   *
   * Teardown only: clean disconnect, dropped client, connection duration cap.
   * Nothing here listens for caller speech during playback — barge-in is a
   * later phase and reuses this contract unchanged.
   *
   * Safe to call more than once, and safe to call when nothing is in flight.
   */
  cancel(): void {
    this.cancelled = true;
    const controller = this.controller;
    this.controller = undefined;
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
  }
}
