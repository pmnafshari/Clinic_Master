import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TEXT_TO_SPEECH, TextToSpeech } from '../speech/text-to-speech.interface';
import { createAnonymousSession } from '../session/voice-session';
import { Conversation, VoiceSessionStore } from '../session/voice-session.store';
import { AudioTransport } from './audio-transport.interface';
import { parseClientFrame } from './frames';
import { VoiceTurnRunner } from './voice-turn-runner';

/**
 * BrowserWebSocketTransport's frame handling.
 *
 * This class holds VoiceSessionStore, VoiceTurnRunner and — optionally — a
 * TextToSpeech implementation. It deliberately holds no reference to
 * ToolRegistryService or to any tool: the transport must not be able to call a
 * tool directly, because every authorization decision, every idempotency key
 * and every audit row is produced inside ToolExecutorService. A static
 * import-graph test in transport-isolation.spec.ts pins that.
 */
@Injectable()
export class VoiceGateway {
  private readonly logger = new Logger(VoiceGateway.name);

  /** Which session each live socket is bound to. */
  private readonly bound = new WeakMap<AudioTransport, string>();

  constructor(
    private readonly sessions: VoiceSessionStore,
    private readonly runner: VoiceTurnRunner,
    /**
     * Optional because nothing binds a speech provider yet, and a required
     * injection would leave the app unable to boot until one does. Optional is
     * not permission to fail silently: deliverReply reports which mode it used
     * and the absent case is tested.
     */
    @Optional() @Inject(TEXT_TO_SPEECH) private readonly tts?: TextToSpeech
  ) {}

  async handleFrame(transport: AudioTransport, raw: unknown): Promise<void> {
    const parsed = parseClientFrame(raw);

    if (!parsed.ok) {
      transport.send({ type: 'error', code: parsed.code });
      return;
    }

    const frame = parsed.frame;

    if (frame.type === 'session.start') {
      const sessionId = this.resume(frame.sessionId);
      this.bound.set(transport, sessionId);
      transport.send({ type: 'session.ready', sessionId });
      return;
    }

    if (frame.type === 'turn.text') {
      const sessionId = this.bound.get(transport);
      const conversation = sessionId ? this.sessions.get(sessionId) : undefined;

      if (!conversation) {
        transport.send({ type: 'error', code: 'session_expired' });
        return;
      }

      const outcome = await this.runner.runTurn(transport, conversation, frame.text);
      this.bound.set(transport, outcome.sessionId);

      await this.deliverReply(transport, outcome.reply);
      transport.send({ type: 'turn.complete' });
    }
  }

  /**
   * Delivers one reply and reports how.
   *
   * Returns 'audio' only when synthesis actually produced frames. A missing
   * provider, a provider that throws, and a provider that yields nothing all
   * return 'text' — absence is never reported as success, which is what stops
   * optional injection becoming a silent failure path in production.
   *
   * Binding a real implementation changes which implementation runs here; it
   * does not add a second path.
   */
  async deliverReply(transport: AudioTransport, text: string): Promise<'audio' | 'text'> {
    if (this.tts) {
      try {
        let frames = 0;
        for await (const chunk of this.tts.synthesise(text)) {
          transport.sendAudio?.(chunk);
          frames += 1;
        }
        if (frames > 0) {
          return 'audio';
        }
      } catch {
        // Provider detail is logged server-side, never sent to the client.
        this.logger.warn('Speech synthesis failed, delivering the reply as text');
      }
    }

    transport.send({ type: 'reply.text', text });
    transport.send({ type: 'error', code: 'tts_unavailable' });
    return 'text';
  }

  /**
   * An id the server does not hold is not adopted, and is not an error either:
   * it quietly starts a fresh conversation. Rejecting it would turn the
   * gateway into an oracle answering "does this session exist?" one guess at a
   * time — the enumeration attack the HTTP endpoint was written to avoid.
   */
  private resume(candidate?: string): string {
    const existing = candidate ? this.sessions.get(candidate) : undefined;
    if (existing) {
      return existing.session.sessionId;
    }

    const conversation: Conversation = { session: createAnonymousSession(), history: [] };
    this.sessions.set(conversation.session.sessionId, conversation);
    return conversation.session.sessionId;
  }
}
