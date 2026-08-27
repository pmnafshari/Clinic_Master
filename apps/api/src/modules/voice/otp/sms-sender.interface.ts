import { Injectable, Logger } from '@nestjs/common';

export const SMS_SENDER = Symbol('SMS_SENDER');

/**
 * The seam between "a code needs to reach this phone" and whoever carries it.
 *
 * Deliberately narrow. Nothing about a provider — no status codes, no message
 * ids, no account identifiers — travels back through it, because everything on
 * the other side of this interface ends up in a tool result an agent reads out.
 */
export interface SmsSender {
  send(to: string, message: string): Promise<void>;
}

/**
 * The default sender: records that a message would have gone out, and nothing
 * about it.
 *
 * Not a development convenience — it deliberately does not log the code or the
 * recipient, because a log line is exactly where a one-time code must never be.
 * A deployment that wants codes actually delivered configures a real sender.
 */
@Injectable()
export class LoggingSmsSender implements SmsSender {
  private readonly logger = new Logger('VoiceOtp');

  async send(): Promise<void> {
    this.logger.log('sms.send requested');
  }
}
