import { VOICE_CONFIG, CLINIC_INFO, SERVICE_PRICING } from '../../src/modules/voice/voice.config';

describe('voice config', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(VOICE_CONFIG.enabled).toBe(false);
  });

  it('uses Claude Opus 5 at low effort', () => {
    expect(VOICE_CONFIG.model).toBe('claude-opus-5');
    expect(VOICE_CONFIG.effort).toBe('low');
  });

  it('exposes clinic facts for the public tools', () => {
    expect(CLINIC_INFO.hours).toBeDefined();
    expect(CLINIC_INFO.address).toBeDefined();
  });

  it('exposes published price ranges', () => {
    expect(SERVICE_PRICING.length).toBeGreaterThan(0);
    expect(SERVICE_PRICING[0]).toHaveProperty('service');
    expect(SERVICE_PRICING[0]).toHaveProperty('priceRange');
  });
});
