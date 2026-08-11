import { Injectable } from '@nestjs/common';
import { VoiceTool, VoiceToolResult, ToolTier } from './tool-definition.interface';
import { SERVICE_PRICING } from '../voice.config';

/**
 * Tier 'public' holds only while pricing is published and identical for
 * everyone. If patient-specific or insurance-adjusted pricing is introduced,
 * this tool moves to 'verified'.
 */
@Injectable()
export class ServicePricingTool implements VoiceTool {
  name = 'get_service_pricing';
  tier: ToolTier = 'public';
  description =
    'Get published price ranges for common treatments. These are general ' +
    'ranges, not a quote for a specific patient.';
  inputSchema = { type: 'object', properties: {}, additionalProperties: false };

  async execute(): Promise<VoiceToolResult> {
    return { status: 'ok', services: SERVICE_PRICING };
  }
}
