import { Injectable } from '@nestjs/common';
import { VoiceTool, VoiceToolResult, ToolTier } from './tool-definition.interface';
import { CLINIC_INFO } from '../voice.config';

@Injectable()
export class ClinicInfoTool implements VoiceTool {
  name = 'get_clinic_info';
  tier: ToolTier = 'public';
  description =
    'Get the clinic opening hours, address, parking information, and how to ' +
    'prepare for an appointment. Call this for any question about visiting the clinic.';
  inputSchema = { type: 'object', properties: {}, additionalProperties: false };

  async execute(): Promise<VoiceToolResult> {
    return { status: 'ok', ...CLINIC_INFO };
  }
}
