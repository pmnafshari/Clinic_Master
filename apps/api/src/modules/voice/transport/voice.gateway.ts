import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TEXT_TO_SPEECH, TextToSpeech } from '../speech/text-to-speech.interface';
import { createAnonymousSession } from '../session/voice-session';
import { Conversation, VoiceSessionStore } from '../session/voice-session.store';
import { AudioTransport } from './audio-transport.interface';
import { parseClientFrame } from './frames';
import {
  WS_MAX_TURNS_PER_MINUTE,
  WS_MAX_TURNS_PER_SESSION,
  WS_RATE_WINDOW_MS,
} from './transport-limits';
import { VoiceTurnRunner } from './voice-turn-runner';

/** Per-connection counters. Transport bookkeeping, never session state. */
interface ConnectionState {
  sessionId: string;
  turns: number;
  recentTurnsAt: number[];
}

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

  /**
   * Per-socket bookkeeping. Keyed by the transport so it disappears with the
   * connection. Holds no identity: which patient a session may act for lives in
   * the store and nowhere else.
   */
  private readonly connections = new WeakMap<AudioTransport, ConnectionState>();

  /**
   * The live socket holding each session, for one-socket-per-session.
   *
   * A plain Map because it must be enumerable by session id. Entries are
   * removed on teardown; the store's own session cap bounds how many can
   * accumulate if a socket dies without notifying us.
   */
  private readonly liveSockets = new Map<string, AudioTransport>();

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

      /**
       * One live socket per session. A second connection presenting the same
       * id is rejected rather than joined: joining would let a stolen id
       * eavesdrop on a live conversation.
       *
       * The FIRST socket is left untouched. Closing it instead would let
       * anyone holding a stolen id kick the legitimate caller off their call.
       *
       * This is only reachable by someone already presenting a live 256-bit
       * id, so it is not an enumeration path — an attacker who can produce one
       * has already learned everything the rejection would tell them.
       */
      if (this.liveSockets.has(sessionId)) {
        transport.close('session_conflict');
        return;
      }

      this.connections.set(transport, { sessionId, turns: 0, recentTurnsAt: [] });
      this.liveSockets.set(sessionId, transport);

      // Release the claim however the socket ends — clean close, dropped
      // client, duration cap. Guarded so a double fire cannot free a slot a
      // reconnected caller has since taken.
      transport.onTeardown(() => {
        const state = this.connections.get(transport);
        // Release only a claim this socket still holds. The identity check is
        // what makes a repeated teardown safe: a dropped client and a clean
        // close can both fire, and by then the session may belong to a
        // reconnected socket whose slot must not be freed underneath it.
        if (state && this.liveSockets.get(state.sessionId) === transport) {
          this.liveSockets.delete(state.sessionId);
        }
      });

      transport.send({ type: 'session.ready', sessionId });
      return;
    }

    if (frame.type === 'turn.text') {
      const state = this.connections.get(transport);
      const conversation = state ? this.sessions.get(state.sessionId) : undefined;

      if (!state || !conversation) {
        transport.send({ type: 'error', code: 'session_expired' });
        return;
      }

      if (!this.underTurnLimits(state, conversation.session.logId)) {
        transport.send({ type: 'error', code: 'rate_limited' });
        transport.close('rate_limited');
        return;
      }

      const outcome = await this.runner.runTurn(transport, conversation, frame.text);

      // Rotation re-keys the session, so the socket's claim moves with it.
      if (outcome.sessionId !== state.sessionId) {
        if (this.liveSockets.get(state.sessionId) === transport) {
          this.liveSockets.delete(state.sessionId);
        }
        state.sessionId = outcome.sessionId;
        this.liveSockets.set(outcome.sessionId, transport);
      }

      await this.deliverReply(transport, outcome.reply);
      transport.send({ type: 'turn.complete' });
    }
  }

  /**
   * Counts the turn and reports whether it may run.
   *
   * Both caps are enforced before the agent is called, so an over-limit turn
   * costs nothing. `logId` is used for the log line — never the sessionId,
   * which is a bearer credential.
   */
  private underTurnLimits(state: ConnectionState, logId: string): boolean {
    const now = Date.now();
    state.recentTurnsAt = state.recentTurnsAt.filter((t) => now - t < WS_RATE_WINDOW_MS);

    if (state.turns >= WS_MAX_TURNS_PER_SESSION) {
      this.logger.warn(`Session turn cap reached for ${logId}`);
      return false;
    }

    if (state.recentTurnsAt.length >= WS_MAX_TURNS_PER_MINUTE) {
      this.logger.warn(`Turn rate cap reached for ${logId}`);
      return false;
    }

    state.turns += 1;
    state.recentTurnsAt.push(now);
    return true;
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
