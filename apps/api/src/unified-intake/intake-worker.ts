import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { FileStore } from '../storage/file-store';
import { PgIntakeRepository } from './intake-repository';
import { classify, Classification } from './classification';
import { IntakeQueue, Ticket, WorkerTiming, workerTiming, LeaseLost, digest } from './processing-queue';
import { Organization, TextPage } from './organizations';
export class ProcessingFailure extends Error {
  constructor(
    readonly transient: boolean,
    readonly code: string,
  ) {
    super(code);
  }
}
export type WorkerHook = (point: string, ticket: Ticket) => Promise<void>;
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProcessingFailure(true, 'processing_timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export class IntakeWorker {
  private stopping = false;
  readonly timing: WorkerTiming;
  constructor(
    private readonly pool: Pool,
    private readonly repo: PgIntakeRepository,
    private readonly store: FileStore,
    readonly workerId: string,
    options: Partial<WorkerTiming> = {},
    private readonly hook?: WorkerHook,
  ) {
    if (hook && process.env.NODE_ENV !== 'test') throw Error('fault_hooks_test_only');
    if (!workerId || workerId.length > 120) throw Error('invalid_worker_id');
    this.timing = workerTiming(options, process.env.NODE_ENV === 'test');
  }
  get queue(): IntakeQueue {
    return this.repo.queue;
  }
  stop() {
    this.stopping = true;
  }
  async start() {
    await Promise.all(
      Array.from({ length: this.timing.concurrency }, async () => {
        while (!this.stopping) {
          try {
            const job = await this.queue.claim(this.workerId, this.timing);
            if (job) await this.execute(job);
            else await wait(this.timing.pollMs);
          } catch {
            await wait(this.timing.pollMs);
          }
        }
      }),
    );
  }
  async execute(job: Ticket) {
    let lost = false,
      chain: Promise<unknown> = Promise.resolve();
    const serialized = <T>(work: () => Promise<T>): Promise<T> => {
      const task = chain.then(async () => {
        if (lost) throw new LeaseLost();
        return work();
      });
      chain = task.catch(() => {
        lost = true;
      });
      return task;
    };
    // This worker invokes native/test ports only. Preserve recorded executions on checkpoint retry.
    let executedCoverage: Record<string, boolean> = { model: false, ocr: false, ...job.coverage };
    const recordCoverage = (coverage: Record<string, boolean>) => {
      executedCoverage = {
        ...executedCoverage,
        ...coverage,
        model: executedCoverage.model === true || coverage.model === true,
        ocr: executedCoverage.ocr === true || coverage.ocr === true,
      };
      return executedCoverage;
    };
    const touch = async (stage: string, coverage: Record<string, boolean> = {}) =>
      serialized(async () =>
        Object.assign(job, await this.queue.update(job, stage, this.timing, recordCoverage(coverage))),
      );
    const interval = setInterval(() => {
      void serialized(async () =>
        Object.assign(job, await this.queue.update(job, job.stage, this.timing, {}, 'running', 'heartbeat')),
      ).catch(() => {
        lost = true;
      });
    }, this.timing.heartbeatMs);
    const deadline = setTimeout(() => {
      lost = true;
      clearInterval(interval);
    }, 120000);
    try {
      await this.hook?.('after_claim', job);
      // Eligibility is checked before FileStore/native parser/extractor/model access.
      const p = await this.queue.policy.current();
      if (p.version !== job.policy_version || p.reason(job.source_sha))
        throw new ConflictException('policy_changed');
      const row = (
        await this.pool.query(
          'SELECT d.mime_type,d.original_name,b.storage_key FROM tender_app.intake_document d JOIN tender_app.blob b ON b.sha256=d.blob_sha256 WHERE d.id=$1 AND d.tender_id=$2 AND d.blob_sha256=$3',
          [job.original_id, job.tender_id, job.source_sha],
        )
      ).rows[0];
      if (!row) throw new ProcessingFailure(false, 'original_missing');
      const bytes = await bounded(this.store.get(row.storage_key), 30000);
      if (digest(bytes) !== job.source_sha) throw new ProcessingFailure(false, 'sha_mismatch');
      await touch('original_verified', { originalVerified: true });
      await this.hook?.('after_read', job);
      const checkpoint = await this.queue.checkpoints(job);
      const file = { name: row.original_name, mime: row.mime_type, content: bytes };
      const classification =
        (checkpoint.find((r) => r.stage === 'classification')?.payload as Classification | undefined) ??
        (await classify(file));
      recordCoverage(classification.coverage);
      if (classification.status !== 'completed')
        throw new ProcessingFailure(/timeout/.test(classification.reason), classification.reason);
      if (!checkpoint.some((r) => r.stage === 'classification'))
        await serialized(async () =>
          Object.assign(job, await this.queue.checkpoint(job, 'classification', classification, this.timing)),
        );
      await this.hook?.('after_classification', job);
      const extracted =
        (checkpoint.find((r) => r.stage === 'organizations')?.payload as
          { organizations: Organization[]; pages: TextPage[] } | undefined) ??
        (await bounded(this.repo.workerExtract(job, file), 35000));
      if (!checkpoint.some((r) => r.stage === 'organizations'))
        await serialized(async () =>
          Object.assign(job, await this.queue.checkpoint(job, 'organizations', extracted, this.timing)),
        );
      await this.hook?.('after_organizations', job);
      clearInterval(interval);
      await chain;
      if (lost) throw new LeaseLost();
      await this.repo.completeWorker(
        job,
        classification,
        extracted.organizations,
        this.timing,
        () => this.hook?.('after_resolver', job) ?? Promise.resolve(),
        extracted.pages,
      );
      await this.hook?.('after_commit', job);
    } catch (error) {
      clearInterval(interval);
      await chain;
      const e = error as Error & { code?: string };
      if (e instanceof LeaseLost || lost) {
        await this.queue.rejected(job, 'lease_lost').catch(() => {});
        return;
      }
      const policy = e instanceof ConflictException,
        denied = e instanceof ForbiddenException || e instanceof NotFoundException;
      const transient =
        e instanceof ProcessingFailure
          ? e.transient
          : ['EIO', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET', '40001', '40P01', '08006', '57P01'].includes(
              e.code ?? '',
            );
      const code =
        e instanceof ProcessingFailure
          ? e.code
          : policy
            ? 'policy_or_lifecycle_changed'
            : denied
              ? 'permission_denied'
              : transient
                ? 'temporary_processing_failure'
                : e.message === 'Storage integrity check failed'
                  ? 'sha_mismatch'
                  : 'permanent_processing_failure';
      try {
        const status = transient && job.attempt_count < 3 ? 'retry_wait' : 'failed';
        await this.queue.update(
          job,
          status,
          this.timing,
          executedCoverage,
          status,
          transient && job.attempt_count >= 3 ? 'attempts_exhausted' : code,
        );
      } catch {
        await this.queue.rejected(job, code).catch(() => {});
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(interval);
    }
  }
}
