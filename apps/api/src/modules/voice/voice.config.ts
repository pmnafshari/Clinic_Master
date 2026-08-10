/**
 * Phase 0 is text-only. The flag stays false until a phase is deliberately
 * switched on in an environment.
 */
export const VOICE_CONFIG = {
  enabled: process.env.VOICE_AGENT_ENABLED === 'true',
  model: 'claude-opus-5',
  // Thinking is deliberately left at its adaptive default. Disabling it on
  // Opus 5 can cause tool calls to be emitted as plain text, which completes
  // the turn without running the tool — a silent booking failure.
  effort: 'low' as const,
  maxTokens: 2048,
};

export const CLINIC_INFO = {
  name: 'SmileFlow Dental',
  address: '124 Chestnut Street, Springfield',
  phone: '+1-555-0100',
  hours: 'Monday to Friday, 8am to 6pm. Closed weekends and public holidays.',
  parking: 'Free patient parking is available behind the building, entrance on Willow Lane.',
  prepInstructions:
    'Arrive ten minutes early. Bring a list of any medications you take. ' +
    'For a cleaning, eat beforehand and brush as normal.',
};

export const SERVICE_PRICING: Array<{ service: string; priceRange: string }> = [
  { service: 'Routine cleaning', priceRange: '$90 to $150' },
  { service: 'Dental examination', priceRange: '$60 to $110' },
  { service: 'Filling', priceRange: '$150 to $350' },
  { service: 'Root canal', priceRange: '$700 to $1,200' },
  { service: 'Crown', priceRange: '$900 to $1,800' },
  { service: 'Extraction', priceRange: '$180 to $450' },
];
