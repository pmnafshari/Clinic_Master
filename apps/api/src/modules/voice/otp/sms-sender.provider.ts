import { Provider } from '@nestjs/common';
import { LoggingSmsSender, SMS_SENDER, SmsSender } from './sms-sender.interface';
import { TwilioSmsSender } from './twilio-sms.sender';

/**
 * A sender that exists only to refuse.
 *
 * An unrecognised `SMS_PROVIDER` is a misconfiguration, and the two obvious
 * responses are both wrong: falling back to Twilio starts texting people from a
 * deployment that never asked to, and falling back to the logging sender hides
 * the mistake behind messages that appear to send and never arrive. Failing the
 * send surfaces it at the only moment anyone is watching.
 */
class UnconfiguredSmsSender implements SmsSender {
  constructor(private readonly provider: string) {}

  async send(): Promise<void> {
    throw new Error(`SMS_PROVIDER is not a supported value: ${this.provider || '(empty)'}`);
  }
}

/**
 * Picks a sender from configuration.
 *
 * Selection is by exact name. `twilio` and nothing else reaches the real
 * provider — no trimming, no case folding, no prefix matching — because every
 * one of those turns a typo into live message delivery.
 *
 * An absent variable selects the non-delivery sender. Absent configuration must
 * never mean "start texting people", and a deployment that wants real delivery
 * says so.
 */
export function selectSmsSender(): SmsSender {
  const provider = process.env.SMS_PROVIDER;

  if (provider === undefined) {
    return new LoggingSmsSender();
  }
  if (provider === 'twilio') {
    return new TwilioSmsSender();
  }
  if (provider === 'logging') {
    return new LoggingSmsSender();
  }
  return new UnconfiguredSmsSender(provider);
}

export const smsSenderProvider: Provider = {
  provide: SMS_SENDER,
  useFactory: selectSmsSender,
};
