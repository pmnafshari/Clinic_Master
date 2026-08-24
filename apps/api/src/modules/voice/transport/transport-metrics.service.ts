import { Injectable, Logger } from '@nestjs/common';

/** Which provider a failure came from. Never the provider's own message. */
export type VoiceProvider = 'stt' | 'tts' | 'agent';

/** Why a socket ended. A closed set, so a reason can never carry detail. */
export type CloseReason = 'client' | 'rate_limited' | 'duration_cap' | 'session_conflict';

/**
 * What the transport reports about itself.
 *
 * Every method takes `logId` first and takes nothing that could carry a
 * credential or a caller's words. That is deliberately a property of the
 * signatures rather than a rule someone has to remember: there is no parameter
 * here to pass a sessionId, a transcript, or an audio buffer into, so a future
 * edit cannot casually add one to a log line.
 *
 * `logId` is the non-secret per-conversation correlation id. The sessionId is
 * a bearer credential and a log line is exactly the wrong place for one.
 */
@Injectable()
export class TransportMetricsService {
  private readonly logger = new Logger('VoiceTransport');

  connectionOpened(logId: string): void {
    this.logger.log(`connection.opened ${logId}`);
  }

  connectionClosed(logId: string, reason: CloseReason): void {
    this.logger.log(`connection.closed ${logId} reason=${reason}`);
  }

  turnCompleted(logId: string, durationMs: number): void {
    this.logger.log(`turn.completed ${logId} ms=${Math.round(durationMs)}`);
  }

  /**
   * The score, never the words.
   *
   * Rounded to two places: the distribution is what tells you the recogniser
   * is degrading, and full precision would be a fingerprint of one utterance.
   */
  sttConfidence(logId: string, confidence: number): void {
    this.logger.log(`stt.confidence ${logId} value=${confidence.toFixed(2)}`);
  }

  ttsFirstFrame(logId: string, latencyMs: number): void {
    this.logger.log(`tts.first_frame ${logId} ms=${Math.round(latencyMs)}`);
  }

  providerError(logId: string, provider: VoiceProvider): void {
    this.logger.warn(`provider.error ${logId} provider=${provider}`);
  }

  sessionRotated(logId: string): void {
    this.logger.log(`session.rotated ${logId}`);
  }
}
