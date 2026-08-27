import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { VoiceTicketService } from './voice-ticket.service';

/** What a redeemed ticket resolves to. Both values are server-derived. */
export interface VerifiedIdentity {
  userId: string;
  patientId: string;
}

/**
 * Turns a one-time ticket into the patient a voice session may act for.
 *
 * The chain is ticket → userId → Patient.userId → patientId, entirely
 * server-side. The browser's only contribution is the opaque ticket; there is
 * deliberately no parameter here that could carry a userId or a patientId,
 * so no amount of client input can select whose records a session reaches.
 *
 * A staff account with no linked patient record resolves to nothing rather
 * than to a partial identity — a session is either fully verified against one
 * patient or it stays anonymous.
 */
@Injectable()
export class VerifiedIdentityService {
  constructor(
    private readonly tickets: VoiceTicketService,
    private readonly prisma: PrismaService
  ) {}

  async resolve(ticket: string): Promise<VerifiedIdentity | null> {
    const userId = await this.tickets.consume(ticket);
    if (!userId) {
      return null;
    }

    const patient = await this.prisma.patient.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!patient) {
      return null;
    }

    return { userId, patientId: patient.id };
  }
}
