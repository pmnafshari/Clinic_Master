import { Injectable, Logger } from '@nestjs/common';
import twilio from 'twilio';
import { SmsSender } from './sms-sender.interface';

/**
 * The sliver of the Twilio SDK this file uses.
 *
 * Declared rather than imported so a test can supply a client without the SDK
 * being able to reach the network, and so the coupling to the provider is one
 * visible shape instead of a whole namespace.
 */
export interface TwilioLike {
  messages: {
    create(options: { to: string; from: string; body: string }): Promise<unknown>;
  };
}

export type TwilioClientFactory = (sid: string, token: string) => TwilioLike;

const realClient: TwilioClientFactory = (sid, token) => twilio(sid, token) as unknown as TwilioLike;

function required(variable: string): string {
  const value = process.env[variable];
  if (!value) {
    // Names the variable, never a value. Missing credentials fail the send
    // rather than being papered over, matching how the speech providers behave.
    throw new Error(`${variable} is not configured`);
  }
  return value;
}

/**
 * Delivers a message through Twilio, and says nothing about it afterwards.
 *
 * Read at use time rather than cached at construction, which is the pattern the
 * speech providers already follow: a deployment that has not configured
 * credentials fails the send instead of failing to boot.
 *
 * Nothing the provider says travels back out. A Twilio error names account
 * identifiers and sometimes the destination number, and everything raised here
 * ends up somewhere an agent might read it aloud, so failures are flattened to
 * a message with no detail in it. The OTP service turns that into
 * `unavailable`, which is what the caller hears.
 */
@Injectable()
export class TwilioSmsSender implements SmsSender {
  private readonly logger = new Logger('VoiceSms');

  constructor(private readonly createClient: TwilioClientFactory = realClient) {}

  async send(to: string, message: string): Promise<void> {
    const sid = required('TWILIO_ACCOUNT_SID');
    const token = required('TWILIO_AUTH_TOKEN');
    const from = required('TWILIO_PHONE_NUMBER');

    try {
      await this.createClient(sid, token).messages.create({ to, from, body: message });
    } catch (error) {
      // Swallowed on purpose, and not logged either: the provider's text is the
      // one place account identifiers and the destination number reliably
      // appear together.
      void error;
      this.logger.warn('sms.send failed');
      throw new Error('sms send failed');
    }

    // No recipient, no body, no message id. A delivery record that names who
    // was texted is a log line nobody needs.
    this.logger.log('sms.send ok');
  }
}
