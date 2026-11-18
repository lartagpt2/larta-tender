import assert from 'node:assert/strict';
import { verifyIdentity } from '../testing/isolated-run.mjs';
export async function drainUntilSettled(repository, worker, pool, identity) {
  assert.equal(process.env.NODE_ENV, 'test');
  await verifyIdentity(pool, identity);
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const ticket = await repository.queue.claim(worker.workerId, worker.timing);
    if (ticket) {
      await worker.execute(ticket);
      continue;
    }
    const pending = Number(
      (
        await pool.query(
          "SELECT count(*) n FROM tender_app.intake_processing_run WHERE status IN ('queued','running','retry_wait')",
        )
      ).rows[0].n,
    );
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('regression_queue_not_settled');
}
