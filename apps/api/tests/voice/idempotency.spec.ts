import { IdempotencyService } from '../../src/modules/voice/idempotency/idempotency.service';
import { createVerifiedSession } from '../../src/modules/voice/session/voice-session';
import { VoiceToolResult } from '../../src/modules/voice/tools/tool-definition.interface';

describe('IdempotencyService', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    service = new IdempotencyService();
  });

  it('builds a key from session, turn and tool name', () => {
    const session = createVerifiedSession('s1', 'u1', 'p1');
    session.turnIndex = 3;
    expect(service.keyFor(session, 'book_appointment')).toBe('s1:3:book_appointment');
  });

  it('runs the operation once and replays the result', async () => {
    const operation = jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValue({ status: 'confirmed', appointmentId: 'a1' });

    const first = await service.runOnce('k1', operation);
    const second = await service.runOnce('k1', operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(second.appointmentId).toBe('a1');
  });

  it('does not cache failures, so a retry can genuinely retry', async () => {
    const operation = jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValueOnce({ status: 'failed', error: 'transient' })
      .mockResolvedValueOnce({ status: 'confirmed', appointmentId: 'a2' });

    const first = await service.runOnce('k2', operation);
    const second = await service.runOnce('k2', operation);

    expect(first.status).toBe('failed');
    expect(second.status).toBe('confirmed');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('keys different tools in the same turn separately', async () => {
    const session = createVerifiedSession('s1', 'u1', 'p1');
    expect(service.keyFor(session, 'book_appointment')).not.toBe(
      service.keyFor(session, 'cancel_appointment')
    );
  });
});
