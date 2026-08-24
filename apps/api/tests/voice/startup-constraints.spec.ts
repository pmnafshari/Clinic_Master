import { warnIfMultiInstance } from '../../src/common/config/instance-warning';

describe('the single-process constraint warns rather than blocks', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  function logger() {
    return { warn: jest.fn() };
  }

  it('warns when browser voice is on and more than one instance is declared', () => {
    process.env.VOICE_BROWSER_ENABLED = 'true';
    process.env.APP_INSTANCES = '2';
    const log = logger();

    expect(warnIfMultiInstance(log)).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/single process/i);
  });

  it('stays quiet for one instance, an unset count, or browser voice off', () => {
    const cases: Array<[string | undefined, string | undefined]> = [
      ['true', '1'],
      ['true', undefined],
      ['false', '4'],
      [undefined, '4'],
    ];

    for (const [enabled, instances] of cases) {
      if (enabled === undefined) delete process.env.VOICE_BROWSER_ENABLED;
      else process.env.VOICE_BROWSER_ENABLED = enabled;
      if (instances === undefined) delete process.env.APP_INSTANCES;
      else process.env.APP_INSTANCES = instances;

      const log = logger();
      expect(warnIfMultiInstance(log)).toBe(false);
      expect(log.warn).not.toHaveBeenCalled();
    }
  });
});
