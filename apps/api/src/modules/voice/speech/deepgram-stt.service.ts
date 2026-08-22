import { Injectable, Logger } from '@nestjs/common';
// Named import, not default: this tsconfig sets allowSyntheticDefaultImports
// without esModuleInterop, so a default import compiles to `.default`, which
// `ws` does not set — WebSocket.OPEN would be undefined at runtime.
import { WebSocket, RawData } from 'ws';
import { VoiceSession } from '../session/voice-session';
import { SpeechToText, SttFinal } from './speech-to-text.interface';

/** Uplink audio format. The browser downsamples to this before sending. */
export const STT_ENCODING = 'linear16';
export const STT_SAMPLE_RATE = 16000;

/**
 * Silence, in milliseconds, before Deepgram calls an utterance finished.
 *
 * Server-side endpointing rather than client-side voice detection: the browser
 * should not be deciding when a caller has stopped speaking, and a threshold
 * this side is one place to tune rather than one per client.
 */
export const STT_ENDPOINTING_MS = 800;

const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';

/** What a Deepgram result message looks like once it has been believed. */
interface DeepgramAlternative {
  transcript?: unknown;
  confidence?: unknown;
}

/**
 * Turns one provider message into a transcript, or into nothing.
 *
 * Pure and exported so the provider's wire format is tested directly: this is
 * where a shape change or a partial-vs-final mix-up would otherwise slip
 * through untested behind a network call.
 *
 * Only `speech_final` produces a turn. `is_final` marks a settled fragment,
 * not a finished utterance, and dispatching on it cuts callers off mid
 * sentence.
 */
export function parseDeepgramMessage(
  raw: unknown
): { kind: 'partial'; text: string } | { kind: 'final'; result: SttFinal } | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const message = raw as Record<string, unknown>;
  const channel = message.channel as Record<string, unknown> | undefined;
  const alternatives = channel?.alternatives;

  if (!Array.isArray(alternatives) || alternatives.length === 0) {
    return null;
  }

  const best = alternatives[0] as DeepgramAlternative;
  const text = typeof best.transcript === 'string' ? best.transcript.trim() : '';

  if (text.length === 0) {
    return null;
  }

  if (message.speech_final === true) {
    const confidence = typeof best.confidence === 'number' ? best.confidence : 0;
    return { kind: 'final', result: { text, confidence } };
  }

  return { kind: 'partial', text };
}

/**
 * Deepgram behind the SpeechToText seam.
 *
 * The credential is read from the environment and never leaves this file: it
 * is not logged, not included in an error, and never sent to the browser. A
 * deployment without one fails closed — `start` throws, and the transport
 * reports `stt_unavailable` rather than silently transcribing nothing.
 */
@Injectable()
export class DeepgramSttService implements SpeechToText {
  private readonly logger = new Logger(DeepgramSttService.name);
  private socket?: WebSocket;
  private partialHandlers: Array<(text: string) => void> = [];
  private finalHandlers: Array<(result: SttFinal) => void | Promise<void>> = [];

  async start(session: VoiceSession): Promise<void> {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) {
      // Names the variable, never a value — there is nothing to leak here.
      throw new Error('DEEPGRAM_API_KEY is not configured');
    }

    const query = new URLSearchParams({
      encoding: STT_ENCODING,
      sample_rate: String(STT_SAMPLE_RATE),
      channels: '1',
      interim_results: 'true',
      endpointing: String(STT_ENDPOINTING_MS),
    });

    const socket = new WebSocket(`${DEEPGRAM_URL}?${query.toString()}`, {
      headers: { Authorization: `Token ${key}` },
    });

    this.socket = socket;

    socket.on('message', (data: RawData) => {
      this.dispatch(data, session.logId);
    });

    socket.on('error', () => {
      // Deliberately not logging the error: a provider error carries the
      // project identifier and sometimes the request headers.
      this.logger.warn(`Speech recognition stream failed for ${session.logId}`);
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', () => reject(new Error('speech recognition unavailable')));
    });
  }

  write(chunk: Buffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(chunk);
    }
  }

  async end(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) {
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      // Deepgram's documented way to flush and close a live stream.
      socket.send(JSON.stringify({ type: 'CloseStream' }));
    }
    socket.close();
  }

  onPartial(handler: (text: string) => void): void {
    this.partialHandlers.push(handler);
  }

  onFinal(handler: (result: SttFinal) => void | Promise<void>): void {
    this.finalHandlers.push(handler);
  }

  /** Separated so the message path is reachable without a live socket. */
  private dispatch(data: unknown, logId: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(String(data));
    } catch {
      this.logger.warn(`Unreadable speech recognition message for ${logId}`);
      return;
    }

    const parsed = parseDeepgramMessage(payload);
    if (!parsed) {
      return;
    }

    if (parsed.kind === 'partial') {
      for (const handler of this.partialHandlers) {
        handler(parsed.text);
      }
      return;
    }

    for (const handler of this.finalHandlers) {
      void handler(parsed.result);
    }
  }
}
