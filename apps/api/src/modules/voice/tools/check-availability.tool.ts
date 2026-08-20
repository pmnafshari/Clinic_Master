import { Injectable } from '@nestjs/common';
import { VoiceTool, VoiceToolResult, ToolTier } from './tool-definition.interface';
import { AppointmentsService } from '../../appointments/appointments.service';
import { UsersService } from '../../users/users.service';

@Injectable()
export class CheckAvailabilityTool implements VoiceTool {
  name = 'check_availability';
  tier: ToolTier = 'public';
  description =
    'Find open appointment times on a given date. Returns times only — it ' +
    'never reveals who holds the booked slots.';
  inputSchema = {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: 'The date to check, in YYYY-MM-DD format.',
      },
    },
    required: ['date'],
    additionalProperties: false,
  };

  constructor(
    private appointments: AppointmentsService,
    private users: UsersService
  ) {}

  async execute(input: Record<string, unknown>): Promise<VoiceToolResult> {
    const date = String(input.date);

    const providers = await this.users.findProviders();
    if (!providers || providers.length === 0) {
      return { status: 'failed', error: 'no_provider_available' };
    }

    const slots = await this.appointments.getAvailability(providers[0].id, date);
    const availableTimes = (slots ?? [])
      .filter((slot: { available: boolean }) => slot.available)
      .map((slot: { time: string }) => slot.time);

    return { status: 'ok', date, availableTimes };
  }
}
