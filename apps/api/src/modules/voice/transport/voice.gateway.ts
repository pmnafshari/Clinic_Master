import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  isUsableFinal,
  LOW_CONFIDENCE_REPROMPT,
  SPEECH_TO_TEXT_FACTORY,
  SpeechToText,
  SpeechToTextFactory,
  STT_MIN_CONFIDENCE,
} from '../speech/speech-to-text.interface';
import {
  TEXT_TO_SPEECH_FACTORY,
  TextToSpeech,
  TextToSpeechFactory,
} from '../speech/text-to-speech.interface';
import { chunkSentences } from '../speech/sentence-chunker';
import { createAnonymousSession, createVerifiedSession, newOpaqueId } from '../session/voice-session';
import { VerifiedIdentity } from '../session/verified-identity.service';
import { Conversation, VoiceSessionStore } from '../session/voice-session.store';
import { AudioTransport } from './audio-transport.interface';
import { parseClientFrame } from './frames';
import { logRetry, logServerError, toClientError } from './error-mapper';
import { CloseReason, TransportMetricsService } from './transport-metrics.service';
import {
  WS_MAX_CONNECTION_MS,
  WS_MAX_UPLINK_BYTES_PER_TURN,
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
  /** Lazily started on the first audio chunk: a text-only session opens no provider stream. */
  stt?: SpeechToText;
  /** Lazily built on the first reply. One per connection, like the recogniser. */
  tts?: TextToSpeech;
  /** Set once when the connection ends, so no frame is emitted afterwards. */
  ttsCancelled: boolean;
  /**
   * Resolved from a one-time ticket at connect, before any frame is read.
   * Absent means the socket is anonymous, which is the Phase 1 behaviour.
   */
  identity?: VerifiedIdentity;
  /** Why the socket ended, for the close metric. */
  closeReason: CloseReason;
  sttFailed: boolean;
  /** Bytes accepted for the turn in progress. Reset when a turn is dispatched. */
  uplinkBytesThisTurn: number;
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

  /**
   * Identity resolved at connect, held until the session is created. Keyed by
   * transport so it disappears with the connection.
   */
  private readonly pendingIdentity = new WeakMap<AudioTransport, VerifiedIdentity>();

  constructor(
    private readonly sessions: VoiceSessionStore,
    private readonly runner: VoiceTurnRunner,
    private readonly metrics: TransportMetricsService,
    /**
     * Optional because nothing binds a speech provider yet, and a required
     * injection would leave the app unable to boot until one does. Optional is
     * not permission to fail silently: deliverReply reports which mode it used
     * and the absent case is tested.
     */
    @Optional()
    @Inject(TEXT_TO_SPEECH_FACTORY)
    private readonly ttsFactory?: TextToSpeechFactory,
    /**
     * A factory, so each connection gets its own recogniser. Optional for the
     * same reason as the speech synthesiser: a deployment with none configured
     * must still boot and still serve text turns. Audio arriving with no
     * factory bound reports stt_unavailable.
     */
    @Optional() @Inject(SPEECH_TO_TEXT_FACTORY) private readonly sttFactory?: SpeechToTextFactory
  ) {}

  /**
   * Records the identity a socket authenticated as, before any frame is read.
   *
   * Called by the socket gateway once, after it has consumed the ticket. The
   * identity never comes from a frame, so nothing the browser sends can reach
   * this.
   */
  bindIdentity(transport: AudioTransport, identity: VerifiedIdentity): void {
    this.pendingIdentity.set(transport, identity);
  }

  async handleFrame(transport: AudioTransport, raw: unknown): Promise<void> {
    try {
      await this.routeFrame(transport, raw);
    } catch (error) {
      // Nothing may escape this method. An unhandled rejection would take the
      // connection down without ever telling the caller anything, and the
      // provider's own words must not travel in its place.
      const logId = await this.logIdFor(transport);
      this.metrics.providerError(logId, 'agent');
      logServerError(this.logger, logId, error);
      transport.send(toClientError(error, 'agent_unavailable'));
      transport.send({ type: 'turn.complete' });
    }
  }

  private async routeFrame(transport: AudioTransport, raw: unknown): Promise<void> {
    const parsed = parseClientFrame(raw);

    if (!parsed.ok) {
      // Written as a literal rather than forwarding `parsed.code`: every
      // direct error send states a closed, server-defined code at the call
      // site, so a reader can see what the browser is told without following
      // a value. Anything derived from a caught exception goes through
      // toClientError instead.
      transport.send({ type: 'error', code: 'bad_frame' });
      return;
    }

    const frame = parsed.frame;

    if (frame.type === 'session.start') {
      const sessionId = await this.resume(frame.sessionId, this.pendingIdentity.get(transport));

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
        this.metrics.connectionClosed(await this.logIdForSession(sessionId), 'session_conflict');
        transport.close('session_conflict');
        return;
      }

      this.connections.set(transport, {
        sessionId,
        turns: 0,
        recentTurnsAt: [],
        sttFailed: false,
        uplinkBytesThisTurn: 0,
        ttsCancelled: false,
        closeReason: 'client',
      });
      this.liveSockets.set(sessionId, transport);

      /**
       * A connection does not live forever, independently of the session it
       * carries. The session survives its own TTL so the caller can reconnect
       * and resume; only the socket ends here.
       *
       * `rate_limited` rather than `session_expired`: the session is still
       * there, and telling the client it expired would make it discard a live
       * conversation and start over.
       */
      const logId = (await this.sessions.get(sessionId))?.session.logId ?? 'unknown';
      const durationCap = setTimeout(() => {
        const capped = this.connections.get(transport);
        if (capped) {
          capped.closeReason = 'duration_cap';
        }
        this.logger.warn(`Connection duration cap reached for ${logId}`);
        transport.close('rate_limited');
        this.releaseClaim(transport);
      }, WS_MAX_CONNECTION_MS);
      // Never hold the process open for a socket that may already be gone.
      durationCap.unref?.();

      // Release the claim however the socket ends — clean close, dropped
      // client, duration cap.
      transport.onTeardown(async () => {
        clearTimeout(durationCap);

        // Stop audio first, before anything that awaits. The close metric now
        // reads the log id from Redis, and a round trip's worth of frames
        // would otherwise keep arriving at a socket that is already gone.
        this.cancelSpeech(transport);
        this.releaseClaim(transport);

        await this.endRecogniser(transport);
        this.metrics.connectionClosed(
          await this.logIdFor(transport),
          this.connections.get(transport)?.closeReason ?? 'client'
        );
      });

      this.metrics.connectionOpened(await this.logIdFor(transport));
      transport.send({ type: 'session.ready', sessionId });
      return;
    }

    if (frame.type === 'audio.end') {
      await this.endRecogniser(transport);
      return;
    }

    if (frame.type === 'turn.text') {
      const state = this.connections.get(transport);
      const conversation = state ? await this.sessions.get(state.sessionId) : undefined;

      if (!state || !conversation) {
        transport.send({ type: 'error', code: 'session_expired' });
        return;
      }

      await this.dispatchTurn(transport, state, frame.text);
    }
  }

  /**
   * Caller audio. Binary, so it arrives outside the JSON frame protocol.
   *
   * The per-turn uplink cap is enforced here, at the boundary where bytes
   * actually enter: counting anywhere else would leave a path that skips it.
   */
  async handleAudio(transport: AudioTransport, chunk: Buffer): Promise<void> {
    const state = this.connections.get(transport);
    const conversation = state ? await this.sessions.get(state.sessionId) : undefined;

    if (!state || !conversation) {
      transport.send({ type: 'error', code: 'session_expired' });
      return;
    }

    if (state.sttFailed) {
      return;
    }

    state.uplinkBytesThisTurn += chunk.length;
    if (state.uplinkBytesThisTurn > WS_MAX_UPLINK_BYTES_PER_TURN) {
      this.logger.warn(`Uplink cap reached for ${conversation.session.logId}`);
      state.closeReason = 'rate_limited';
      transport.send({ type: 'error', code: 'rate_limited' });
      transport.close('rate_limited');
      return;
    }

    if (!state.stt) {
      // One recogniser per connection. Sharing one would mean this caller's
      // handlers also fire for every other caller's transcript.
      const recogniser = this.sttFactory?.();
      if (!recogniser) {
        state.sttFailed = true;
        transport.send({ type: 'error', code: 'stt_unavailable' });
        return;
      }

      try {
        await recogniser.start(conversation.session);
      } catch (error) {
        // The provider's message names the provider and often the project, so
        // it is logged here and never sent.
        state.sttFailed = true;
        this.metrics.providerError(conversation.session.logId, 'stt');
        logServerError(this.logger, conversation.session.logId, error);
        transport.send(toClientError(error, 'stt_unavailable'));
        return;
      }

      recogniser.onPartial((text) => {
        transport.send({ type: 'stt.partial', text });
      });
      recogniser.onFinal(async (result) => {
        await this.handleFinal(transport, result);
      });

      state.stt = recogniser;
    }

    state.stt.write(chunk);
  }

  /**
   * A completed utterance.
   *
   * Below the confidence threshold the transport answers on its own and the
   * agent is never called: asking the model whether it heard correctly would
   * put a low-confidence transcript into the context and give it something to
   * guess from, and would mean ClaudeAgentService has to know about
   * confidence, which it must not.
   */
  private async handleFinal(transport: AudioTransport, result: unknown): Promise<void> {
    const state = this.connections.get(transport);
    if (!state) {
      return;
    }

    // A provider event that does not match the contract is discarded, not
    // half-trusted. A missing confidence is not a confident transcript.
    if (!isUsableFinal(result)) {
      return;
    }

    state.uplinkBytesThisTurn = 0;
    this.metrics.sttConfidence(await this.logIdFor(transport), result.confidence);

    if (result.confidence < STT_MIN_CONFIDENCE) {
      // The same delivery path every other reply uses — not a second one.
      await this.deliverReply(transport, LOW_CONFIDENCE_REPROMPT);
      return;
    }

    await this.dispatchTurn(transport, state, result.text);
  }

  /** Ends the recogniser stream once, however the turn or connection ended. */
  private async endRecogniser(transport: AudioTransport): Promise<void> {
    const state = this.connections.get(transport);
    if (!state?.stt) {
      return;
    }
    const recogniser = state.stt;
    state.stt = undefined;
    await recogniser.end();
  }

  /**
   * The single path from this transport into the agent.
   *
   * Both a typed turn and a spoken one arrive here, so rate limiting, rotation
   * bookkeeping and reply delivery have exactly one implementation.
   */
  private async dispatchTurn(
    transport: AudioTransport,
    state: ConnectionState,
    text: string
  ): Promise<void> {
    const conversation = await this.sessions.get(state.sessionId);
    if (!conversation) {
      transport.send({ type: 'error', code: 'session_expired' });
      return;
    }

    if (!this.underTurnLimits(state, conversation.session.logId)) {
      state.closeReason = 'rate_limited';
      transport.send({ type: 'error', code: 'rate_limited' });
      transport.close('rate_limited');
      return;
    }

    const startedAt = Date.now();
    const outcome = await this.runner.runTurn(transport, conversation, text);

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
    this.metrics.turnCompleted(conversation.session.logId, Date.now() - startedAt);
  }

  /**
   * Gives up this socket's claim on its session, if it still holds one.
   *
   * The identity check is what makes a repeated call safe: a duration cap, a
   * dropped client and a clean close can all fire, and by then the session may
   * belong to a reconnected socket whose slot must not be freed underneath it.
   */
  private releaseClaim(transport: AudioTransport): void {
    const state = this.connections.get(transport);
    if (state && this.liveSockets.get(state.sessionId) === transport) {
      this.liveSockets.delete(state.sessionId);
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
    const state = this.connections.get(transport);
    const synth = this.resolveSynthesiser(state);

    if (synth && !state?.ttsCancelled) {
      try {
        let frames = 0;
        // Sentence at a time, so the first audio leaves while the rest is
        // still being generated.
        for (const sentence of chunkSentences(text)) {
          if (state?.ttsCancelled) {
            return 'text';
          }
          frames += await this.speakChunk(transport, synth, sentence, state);
        }

        if (frames > 0) {
          return 'audio';
        }
      } catch (error) {
        // Provider detail is logged server-side, never sent to the client.
        this.metrics.providerError(await this.logIdFor(transport), 'tts');
        logServerError(this.logger, await this.logIdFor(transport), error);
      }
    }

    // The connection ended mid-reply. Nothing more is emitted, and no fallback
    // either: there is nobody left to read it.
    if (state?.ttsCancelled) {
      return 'text';
    }

    transport.send({ type: 'reply.text', text });
    transport.send({ type: 'error', code: 'tts_unavailable' });
    return 'text';
  }

  /**
   * Speaks one sentence, retrying once.
   *
   * A single transient provider failure should not cost the caller the whole
   * reply; a second means the provider is not going to work this turn, and the
   * error propagates so the reply is delivered as text instead.
   */
  private async speakChunk(
    transport: AudioTransport,
    synth: TextToSpeech,
    sentence: string,
    state?: ConnectionState
  ): Promise<number> {
    let lastError: unknown;
    // Resolved once, not per frame: this is the audio path, and a Redis round
    // trip between chunks would show up as a gap the caller can hear.
    const logId = await this.logIdFor(transport);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        let frames = 0;
        const requestedAt = Date.now();
        for await (const chunk of synth.synthesise(sentence)) {
          if (state?.ttsCancelled) {
            return frames;
          }
          if (frames === 0) {
            this.metrics.ttsFirstFrame(logId, Date.now() - requestedAt);
          }
          transport.sendAudio?.(chunk);
          frames += 1;
        }
        return frames;
      } catch (error) {
        lastError = error;
        // Bounded and logged: a provider degrading should be visible before it
        // starts costing callers whole replies.
        logRetry(this.logger, logId, attempt + 1);
      }
    }

    throw lastError;
  }

  /**
   * The non-secret correlation id for whatever connection this is, or a
   * placeholder before a session exists. Never the sessionId.
   */
  private async logIdFor(transport: AudioTransport): Promise<string> {
    const state = this.connections.get(transport);
    if (!state) {
      return 'no-session';
    }
    return this.logIdForSession(state.sessionId);
  }

  private async logIdForSession(sessionId: string): Promise<string> {
    return (await this.sessions.get(sessionId))?.session.logId ?? 'no-session';
  }

  /** One synthesiser per connection, built on the first reply that needs one. */
  private resolveSynthesiser(state?: ConnectionState): TextToSpeech | undefined {
    if (!state) {
      return this.ttsFactory?.();
    }
    if (!state.tts) {
      state.tts = this.ttsFactory?.();
    }
    return state.tts;
  }

  /**
   * Stops this connection's synthesis. Teardown only — a disconnect, a dropped
   * client, or the connection duration cap. Never a caller-speech signal:
   * barge-in is a later phase and reuses this contract unchanged.
   *
   * Guarded so a repeated teardown calls cancel() exactly once, and scoped to
   * one connection so it cannot silence anybody else's call.
   */
  private cancelSpeech(transport: AudioTransport): void {
    const state = this.connections.get(transport);
    if (!state || state.ttsCancelled) {
      return;
    }
    state.ttsCancelled = true;
    state.tts?.cancel();
  }

  /**
   * An id the server does not hold is not adopted, and is not an error either:
   * it quietly starts a fresh conversation. Rejecting it would turn the
   * gateway into an oracle answering "does this session exist?" one guess at a
   * time — the enumeration attack the HTTP endpoint was written to avoid.
   */
  private async resume(candidate?: string, identity?: VerifiedIdentity): Promise<string> {
    const existing = candidate ? await this.sessions.get(candidate) : undefined;
    if (existing) {
      return existing.session.sessionId;
    }

    /**
     * A socket that authenticated at connect starts verified, acting for the
     * patient linked to that user and no other. Both ids were derived
     * server-side from a one-time ticket; neither can be named by the browser.
     */
    const session = identity
      ? createVerifiedSession(newOpaqueId(), identity.userId, identity.patientId)
      : createAnonymousSession();

    const conversation: Conversation = { session, history: [] };
    await this.sessions.set(session.sessionId, conversation);
    return session.sessionId;
  }
}
