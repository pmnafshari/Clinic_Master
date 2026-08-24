/**
 * Voice session and idempotency state lives in process, so a second instance
 * cannot see the first one's sessions.
 *
 * It warns rather than refuses: an operator running behind sticky routing has
 * already solved this, and a guess about their topology should not block a
 * deployment.
 */
export function warnIfMultiInstance(logger: { warn: (message: string) => void }): boolean {
  const browserVoiceOn = process.env.VOICE_BROWSER_ENABLED === 'true';
  const instances = process.env.APP_INSTANCES;

  if (!browserVoiceOn || instances === undefined || instances === '1') {
    return false;
  }

  logger.warn(
    `APP_INSTANCES=${instances} with browser voice enabled: voice sessions are held in a ` +
      'single process and are not shared between instances. Route callers to one instance ' +
      'with sticky sessions, or expect a caller to lose their conversation mid-booking.'
  );
  return true;
}
