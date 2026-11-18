import { IntakePolicy } from './processing-policy';
import { workerTiming } from './processing-queue';
describe('D durable processing eligibility and safe runtime configuration', () => {
  test('default is disabled; a filename or content text cannot grant processing', async () => {
    const p = await new IntakePolicy().current();
    expect(p.reason('a'.repeat(64))).toBe('processing_disabled');
  });
  test('only explicit SHA is eligible; policy versions ignore ordering/duplicate SHA', async () => {
    const allowed = 'a'.repeat(64),
      other = 'b'.repeat(64);
    const p = await new IntakePolicy(async () => ({
      mode: 'synthetic',
      enabled: true,
      sha256: [allowed, other, allowed],
    })).current();
    const reordered = await new IntakePolicy(async () => ({
      mode: 'synthetic',
      enabled: true,
      sha256: [other, allowed],
    })).current();
    expect(p.version).toBe(reordered.version);
    expect(p.reason(allowed)).toBeNull();
    expect(p.reason('c'.repeat(64))).toBe('sha_not_approved');
  });
  test('approved corpus, wildcard and invalid explicit policy fail closed', async () => {
    await expect(
      new IntakePolicy(async () => ({ mode: 'approved_corpus', enabled: true, sha256: [] })).current(),
    ).rejects.toThrow();
    await expect(
      new IntakePolicy(async () => ({ mode: 'synthetic', enabled: true, sha256: ['*'] })).current(),
    ).rejects.toThrow();
    expect(
      (
        await new IntakePolicy(async () => ({
          mode: 'synthetic',
          enabled: false,
          sha256: ['a'.repeat(64)],
        })).current()
      ).reason('a'.repeat(64)),
    ).toBe('intake_processing_disabled');
  });
  test('production lease/heartbeat/retry defaults and bounded concurrency', () => {
    expect(workerTiming()).toMatchObject({
      leaseMs: 180000,
      heartbeatMs: 15000,
      backoffMs: [2000, 10000, 30000],
      concurrency: 1,
    });
    expect(workerTiming({ concurrency: 2 }).concurrency).toBe(2);
    for (const concurrency of [0, 3]) expect(() => workerTiming({ concurrency })).toThrow();
    expect(() => workerTiming({ leaseMs: 900, heartbeatMs: 100 })).toThrow();
    expect(workerTiming({ leaseMs: 900, heartbeatMs: 100 }, true).leaseMs).toBe(900);
  });
});
