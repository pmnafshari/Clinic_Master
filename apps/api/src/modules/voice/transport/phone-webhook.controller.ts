import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { validateRequest } from 'twilio';
import { VoiceTicketService } from '../session/voice-ticket.service';
import {
  VOICE_PHONE_CONFIG,
  VOICE_PHONE_FLAG,
  VoicePhoneFlag,
} from '../voice-phone.config';

/**
 * `CA` followed by 32 hex characters. Checked before the value is stored, so a
 * signed request is still not licence to write an arbitrary string into shared
 * storage.
 */
const CALL_SID_PATTERN = /^CA[0-9a-f]{32}$/;

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
const REJECT = `${XML_HEADER}<Response><Reject/></Response>`;

/**
 * Where Twilio should open the media stream.
 *
 * Derived from the configured webhook URL rather than from anything on the
 * request. The same reasoning that keeps `Host` out of signature validation
 * keeps it out of here: a URL an attacker can influence is a URL they can point
 * a call at.
 */
function streamUrlFrom(webhookUrl: string, ticket: string): string {
  const url = new URL(webhookUrl);
  return `wss://${url.host}/voice/phone?ticket=${ticket}`;
}

/**
 * Where a phone call enters the system.
 *
 * Twilio posts here when someone dials the clinic, and the reply tells it what
 * to do with the call. Everything downstream depends on this handler getting
 * two things right: proving the request is really from Twilio, and handing back
 * a stream URL that only a real call can use.
 *
 * **The body is read through `@Req()` and no DTO.** That is a security
 * requirement rather than a shortcut. Twilio signs the URL plus *every* posted
 * parameter, and this application's global `ValidationPipe` runs with
 * `whitelist: true`, which strips every property without a validation
 * decorator — it empties a Twilio body completely. A signature checked against
 * what survived that pipe could never match, so the body has to reach
 * validation exactly as it arrived. The global pipe is untouched; this route
 * simply never meets it.
 *
 * Nothing is read out of the body until the signature verifies. An unsigned
 * request is not a request with unusable fields — it is a request from someone
 * who is not Twilio, and nothing in it is worth looking at.
 */
@Controller('voice/phone')
export class PhoneWebhookController {
  private readonly logger = new Logger('VoicePhone');

  constructor(
    private readonly tickets: VoiceTicketService,
    @Optional()
    @Inject(VOICE_PHONE_FLAG)
    private readonly flag: VoicePhoneFlag = VOICE_PHONE_CONFIG
  ) {}

  /**
   * Rate limited like any other HTTP route, which is worth noticing: this one
   * has a real ExecutionContext, so ThrottlerGuard actually applies to it. The
   * OTP tools cannot be protected this way, because a tool call arrives inside
   * an agent turn rather than as a request.
   */
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('incoming')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async incoming(@Req() request: Request, @Res() response: Response): Promise<void> {
    if (!this.verifiedTwilioRequest(request)) {
      // No body, no reason, no echo of what was sent. A rejection that explains
      // itself is a rejection that helps someone iterate.
      response.status(HttpStatus.FORBIDDEN).type('text/xml').send(REJECT);
      return;
    }

    if (!this.flag.phoneEnabled) {
      response.type('text/xml').send(REJECT);
      return;
    }

    const body = request.body as Record<string, unknown>;
    const callSid = typeof body.CallSid === 'string' ? body.CallSid : '';
    if (!CALL_SID_PATTERN.test(callSid)) {
      response.status(HttpStatus.FORBIDDEN).type('text/xml').send(REJECT);
      return;
    }

    const webhookUrl = process.env.TWILIO_VOICE_WEBHOOK_URL ?? '';

    let ticket: string;
    try {
      /**
       * The subject stored here is Twilio's **CallSid**, not a `Patient.userId`.
       *
       * This is the same ticket service the browser uses, deliberately: one
       * primitive, one set of security properties, one place to get single-use
       * redemption right. The value simply means something different per
       * channel. If a phone ticket ever reached the browser's identity
       * resolver, it would look up a patient by a CallSid, find none, and
       * resolve to nothing — which is the correct, closed outcome.
       */
      ticket = await this.tickets.issue(callSid);
    } catch {
      // The store is unreachable. Without a ticket there is nothing safe to
      // point a media stream at, so the call is declined rather than connected
      // to an endpoint that will refuse it a moment later.
      this.logger.warn('phone.webhook could not issue a ticket');
      response.type('text/xml').send(REJECT);
      return;
    }

    response
      .type('text/xml')
      .send(
        `${XML_HEADER}<Response><Connect><Stream url="${streamUrlFrom(webhookUrl, ticket)}"/></Connect></Response>`
      );
  }

  /**
   * Proves the request came from Twilio.
   *
   * Validated against the configured `TWILIO_VOICE_WEBHOOK_URL` and never
   * against the request's own host. Behind a proxy, `Host` and `X-Forwarded-*`
   * are attacker-influenced, so validating against a header would let the
   * attacker choose the string the HMAC is computed over — and a signature they
   * can choose the input to is not a signature.
   *
   * Missing credentials fail closed here rather than at boot, matching the
   * other providers: a deployment without them refuses calls instead of
   * refusing to start.
   */
  private verifiedTwilioRequest(request: Request): boolean {
    const token = process.env.TWILIO_AUTH_TOKEN;
    const url = process.env.TWILIO_VOICE_WEBHOOK_URL;
    const signature = request.headers['x-twilio-signature'];

    if (!token || !url || typeof signature !== 'string' || signature.length === 0) {
      return false;
    }

    try {
      // The complete parsed body, exactly as posted. Anything less and the
      // hash covers a different message than the one Twilio signed.
      return validateRequest(token, signature, url, request.body as Record<string, string>);
    } catch {
      // A malformed signature makes the SDK throw rather than return false.
      // Both mean the same thing here.
      return false;
    }
  }
}
