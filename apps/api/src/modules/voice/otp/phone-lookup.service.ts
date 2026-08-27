import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Resolves a caller's number to the one patient it belongs to, or to nobody.
 *
 * The match is exact string equality against the stored value, and the caller's
 * number is used verbatim as the transport recorded it. Nothing is stripped,
 * padded, reformatted, or guessed at.
 *
 * That is stricter than it looks, and deliberately so. A phone match here is an
 * authentication decision: it is the whole basis on which a stranger is later
 * allowed to hear a patient's balance. Every widening — dropping punctuation,
 * assuming a country code, comparing trailing digits — increases the chance a
 * caller resolves to a patient who is not them, and a fuzzy authentication
 * check is not a lesser version of authentication.
 *
 * **Operational consequence, recorded rather than hidden:** stored numbers that
 * are not in E.164 cannot match a caller ID, because Twilio delivers E.164 and
 * nothing here converts between the two. A deployment whose patient records
 * hold `555-0101` or `(555) 123-4567` will find phone verification simply never
 * succeeds. Fixing that is a data migration — a normalized column, a controlled
 * backfill, and normalization on write — and it is deliberately not solved by
 * loosening this comparison.
 *
 * Ambiguity fails closed. Shared household numbers are ordinary in a dental
 * practice, and proving control of one must never open a different family
 * member's records. Zero matches and several matches are the same answer here,
 * and the caller cannot tell them apart.
 */
@Injectable()
export class PhoneLookupService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The patient this number uniquely identifies, or `undefined`.
   *
   * One return value for both refusals, rather than two the caller could tell
   * apart: "no patient has this number" and "several do" are different facts
   * about real people, and either one is worth learning if you are guessing.
   */
  async eligiblePatient(callerE164: string): Promise<string | undefined> {
    // Two is enough to know it is not one. Fetching every row would put an
    // unbounded result set behind a value a stranger chooses.
    const matches = await this.prisma.patient.findMany({
      where: { phone: callerE164 },
      select: { id: true },
      take: 2,
    });

    if (matches.length !== 1) {
      return undefined;
    }

    return matches[0].id;
  }
}
