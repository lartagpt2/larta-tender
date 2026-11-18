import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { PgScopeRepository } from '../data/scope-repository';
import { transaction } from '../data/repository';
import { protectedTenders } from '../lifecycle/lifecycle-repository';
import { IntakePolicy, PolicySnapshot } from './processing-policy';
import { rulesVersion, schemaVersion } from './classification';
import { organizationPolicy, organizationSchema } from './organizations';
export const processingVersions = {
  rulesVersion,
  schemaVersion,
  organizationPolicy,
  organizationSchema,
  orchestration: 'intake-processing-v2',
};
export const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, value]) => [k, canonical(value)]),
    );
  return v;
}
export interface Ticket {
  id: string;
  tender_id: string;
  receipt_id: string;
  original_id: string;
  source_sha: string;
  created_by: string;
  state_revision: number;
  lease_token: string;
  worker_id: string;
  attempt_count: number;
  policy_version: string;
  status: string;
  stage: string;
  coverage: Record<string, boolean>;
  versions: typeof processingVersions;
  lease_expires_at: Date;
}
export class LeaseLost extends Error {
  constructor() {
    super('lease_lost');
  }
}
export interface WorkerTiming {
  leaseMs: number;
  heartbeatMs: number;
  pollMs: number;
  backoffMs: number[];
  concurrency: number;
}
export function workerTiming(input: Partial<WorkerTiming> = {}, test = false): WorkerTiming {
  const t = {
    leaseMs: 180000,
    heartbeatMs: 15000,
    pollMs: 1000,
    backoffMs: [2000, 10000, 30000],
    concurrency: 1,
    ...input,
  };
  if (
    !Number.isInteger(t.concurrency) ||
    t.concurrency < 1 ||
    t.concurrency > 2 ||
    t.leaseMs < (test ? 200 : 180000) ||
    t.heartbeatMs < 10 ||
    t.heartbeatMs > t.leaseMs / 3 ||
    t.pollMs < 10 ||
    t.backoffMs.length !== 3 ||
    t.backoffMs.some((n) => !Number.isInteger(n) || n < (test ? 10 : 2000)) ||
    (!test && input.heartbeatMs !== undefined && input.heartbeatMs !== 15000)
  )
    throw Error('unsafe_worker_timing');
  return t;
}
export class IntakeQueue extends PgScopeRepository {
  constructor(
    pool: Pool,
    readonly policy: IntakePolicy,
  ) {
    super(pool);
  }
  protected override async lock(c: PoolClient, actor: string, id: string) {
    const r = await super.lock(c, actor, id);
    if (protectedTenders.has(id)) throw new ConflictException('protected_tender');
    return r;
  }
  async runEvent(
    c: PoolClient,
    r: {
      id: string;
      tender_id: string;
      receipt_id: string;
      state_revision: number;
      status: string;
      stage?: string;
    },
    code: string,
    actor?: string,
    worker?: string,
  ) {
    await c.query(
      'INSERT INTO tender_app.intake_run_event(id,tender_id,run_id,receipt_id,state_revision,to_state,code,actor_id,worker_id,stage) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        randomUUID(),
        r.tender_id,
        r.id,
        r.receipt_id,
        r.state_revision,
        r.status,
        code,
        actor ?? null,
        worker ?? null,
        r.stage ?? r.status,
      ],
    );
  }
  async enqueue(
    c: PoolClient,
    actor: string,
    tender: string,
    receipt: string,
    original: string,
    sha: string,
    policy: PolicySnapshot,
    retryOf?: string,
  ) {
    const next = (
      await c.query(
        'SELECT COALESCE(max(generation),0)+1 generation,COALESCE(max(state_revision),0)+1 revision FROM tender_app.intake_processing_run WHERE receipt_id=$1',
        [receipt],
      )
    ).rows[0];
    const generation = next.generation;
    const id = randomUUID(),
      reason = policy.reason(sha),
      status = reason ? 'blocked' : 'queued';
    const row = (
      await c.query(
        "INSERT INTO tender_app.intake_processing_run(id,tender_id,receipt_id,original_id,source_sha,generation,request_key,fingerprint,retry_of,status,policy_version,versions,attempt_count,state_revision,error_code,created_by,stage) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,$15,$13,$14,'registered') RETURNING *",
        [
          id,
          tender,
          receipt,
          original,
          sha,
          generation,
          randomUUID(),
          digest(JSON.stringify([receipt, sha, generation, policy.version, processingVersions])),
          retryOf ?? null,
          status,
          policy.version,
          JSON.stringify(processingVersions),
          reason,
          actor,
          next.revision,
        ],
      )
    ).rows[0];
    await this.runEvent(c, row, reason ?? 'enqueued', actor);
    return id;
  }
  async reprocess(
    actor: string,
    tender: string,
    receipt: string,
    key: string,
    input: { expectedRunRevision: number; reason: string },
    cancel = false,
  ) {
    if (
      !/^[a-f0-9-]{36}$/i.test(key) ||
      !Number.isInteger(input.expectedRunRevision) ||
      input.expectedRunRevision < 1 ||
      !input.reason.trim()
    )
      throw new BadRequestException();
    const hash = digest(JSON.stringify([receipt, input.expectedRunRevision, input.reason, cancel]));
    return transaction(this.pool, async (c) => {
      await this.lock(c, actor, tender);
      const old = (
        await c.query(
          'SELECT * FROM tender_app.intake_processing_operation WHERE tender_id=$1 AND operation_key=$2',
          [tender, key],
        )
      ).rows[0];
      if (old) {
        if (old.request_hash !== hash) throw new ConflictException('operation_key_conflict');
        return {
          contractVersion: 'intake-processing-v2',
          runId: old.run_id,
          receiptId: receipt,
          replayed: true,
        };
      }
      const r = (
        await c.query(
          'SELECT * FROM tender_app.intake_processing_run WHERE receipt_id=$1 AND tender_id=$2 ORDER BY generation DESC LIMIT 1 FOR UPDATE',
          [receipt, tender],
        )
      ).rows[0];
      if (!r) throw new NotFoundException();
      if (r.state_revision !== input.expectedRunRevision) throw new ConflictException('stale_run_revision');
      let id: string;
      if (cancel) {
        if (!['blocked', 'queued', 'retry_wait'].includes(r.status))
          throw new ConflictException('run_cannot_be_cancelled');
        const next = (
          await c.query(
            "UPDATE tender_app.intake_processing_run SET status='failed',stage='cancelled',error_code='cancelled_by_user',state_revision=state_revision+1,completed_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL WHERE id=$1 RETURNING *",
            [r.id],
          )
        ).rows[0];
        await this.runEvent(c, next, 'cancelled_by_user', actor);
        id = r.id;
      } else {
        if (['blocked', 'queued', 'running', 'retry_wait'].includes(r.status))
          throw new ConflictException('run_is_active');
        const p = await this.policy.current();
        id = await this.enqueue(c, actor, tender, receipt, r.original_id, r.source_sha, p, r.id);
      }
      await c.query(
        'INSERT INTO tender_app.intake_processing_operation(id,tender_id,receipt_id,operation_key,request_hash,run_id,expected_revision,action,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          randomUUID(),
          tender,
          receipt,
          key,
          hash,
          id,
          input.expectedRunRevision,
          cancel ? 'cancel' : 'reprocess',
          input.reason,
          actor,
        ],
      );
      return { contractVersion: 'intake-processing-v2', runId: id, receiptId: receipt, replayed: false };
    });
  }
  async claim(worker: string, timing: WorkerTiming): Promise<Ticket | null> {
    const candidates = (
      await this.pool.query(
        "SELECT p.id,p.tender_id FROM tender_app.intake_processing_run p LEFT JOIN tender_app.tender_lifecycle l ON l.tender_id=p.tender_id WHERE COALESCE(l.state,'active')='active' AND (p.status='queued' OR p.status='retry_wait' AND p.next_attempt_at<=clock_timestamp() OR p.status='running' AND p.lease_expires_at<=clock_timestamp()) ORDER BY p.enqueue_order LIMIT 100",
      )
    ).rows;
    for (const candidate of candidates) {
      if (protectedTenders.has(candidate.tender_id)) continue;
      const claimed = await transaction(this.pool, async (c) => {
        if (
          !(
            await c.query('SELECT id FROM tender_app.tender WHERE id=$1 FOR UPDATE SKIP LOCKED', [
              candidate.tender_id,
            ])
          ).rowCount
        )
          return null;
        const r = (
          await c.query(
            "SELECT * FROM tender_app.intake_processing_run WHERE id=$1 AND (status='queued' OR status='retry_wait' AND next_attempt_at<=clock_timestamp() OR status='running' AND lease_expires_at<=clock_timestamp()) FOR UPDATE SKIP LOCKED",
            [candidate.id],
          )
        ).rows[0];
        if (!r) return null;
        // Recheck initiator access before parsing. A system-only terminal transition records permanent denial.
        let denied = false;
        try {
          await this.lock(c, r.created_by, r.tender_id);
        } catch (error) {
          if (!(error instanceof ForbiddenException || error instanceof NotFoundException)) throw error;
          await this.assertActive(c, r.tender_id);
          denied = true;
        }
        const policy = await this.policy.current(),
          reason = denied
            ? 'permission_denied'
            : (policy.reason(r.source_sha) ??
              (r.policy_version !== policy.version ? 'policy_changed' : null));
        const exhausted = r.attempt_count >= 3;
        const status = denied || exhausted ? 'failed' : reason ? 'blocked' : 'running',
          code = exhausted
            ? 'attempts_exhausted'
            : (reason ?? (r.status === 'running' ? 'lease_recovered' : 'claimed'));
        const next = (
          await c.query(
            "UPDATE tender_app.intake_processing_run SET status=$2,stage=$2,state_revision=state_revision+1,attempt_count=attempt_count+$3,lease_token=$4,lease_expires_at=CASE WHEN $2='running' THEN clock_timestamp()+$5*interval '1 millisecond' ELSE NULL END,worker_id=$6,error_code=$7,next_attempt_at=NULL,completed_at=CASE WHEN $2='failed' THEN clock_timestamp() ELSE NULL END WHERE id=$1 RETURNING *",
            [
              r.id,
              status,
              status === 'running' ? 1 : 0,
              status === 'running' ? randomUUID() : null,
              timing.leaseMs,
              worker,
              reason ?? (exhausted ? 'attempts_exhausted' : null),
            ],
          )
        ).rows[0];
        await this.runEvent(c, next, code, undefined, worker);
        return status === 'running' ? (next as Ticket) : null;
      });
      if (claimed) return claimed;
    }
    return null;
  }
  async fenced(c: PoolClient, t: Ticket) {
    await this.lock(c, t.created_by, t.tender_id);
    const r = (
      await c.query(
        "SELECT * FROM tender_app.intake_processing_run WHERE id=$1 AND status='running' AND lease_token=$2 AND state_revision=$3 AND lease_expires_at>clock_timestamp() AND worker_id=$4 FOR UPDATE",
        [t.id, t.lease_token, t.state_revision, t.worker_id],
      )
    ).rows[0];
    if (!r) throw new LeaseLost();
    const policy = await this.policy.current();
    if (policy.reason(t.source_sha) || policy.version !== t.policy_version)
      throw new ConflictException('policy_changed');
    if (
      JSON.stringify(r.versions) !== JSON.stringify(t.versions) ||
      Object.entries(processingVersions).some(([k, v]) => r.versions[k] !== v)
    )
      throw new ConflictException('processing_versions_changed');
    if ((await c.query('SELECT 1 FROM tender_app.intake_result WHERE run_id=$1', [t.id])).rowCount)
      throw new LeaseLost();
    return r as Ticket;
  }
  async update(
    t: Ticket,
    stage: string,
    timing: WorkerTiming,
    coverage: Record<string, boolean> = {},
    status = 'running',
    code = stage,
  ) {
    return transaction(this.pool, async (c) => {
      await this.fenced(c, t);
      const r = (
        await c.query(
          "UPDATE tender_app.intake_processing_run SET state_revision=state_revision+1,stage=$2,coverage=coverage||$3::jsonb,status=$4,error_code=$5,lease_expires_at=CASE WHEN $4='running' THEN clock_timestamp()+$6*interval '1 millisecond' ELSE NULL END,lease_token=CASE WHEN $4='running' THEN lease_token ELSE NULL END,next_attempt_at=CASE WHEN $4='retry_wait' THEN clock_timestamp()+$7*interval '1 millisecond' ELSE NULL END,completed_at=CASE WHEN $4='failed' THEN clock_timestamp() ELSE NULL END WHERE id=$1 RETURNING *",
          [
            t.id,
            stage,
            JSON.stringify(coverage),
            status,
            status === 'running' ? null : code,
            timing.leaseMs,
            timing.backoffMs[Math.min(t.attempt_count - 1, 2)],
          ],
        )
      ).rows[0];
      await this.runEvent(c, r, code, undefined, t.worker_id);
      return r as Ticket;
    });
  }
  async rejected(t: Ticket, code: string) {
    // Audit writes are explicitly allowed by the existing Lifecycle guard in archived tenders.
    await this.pool.query(
      "INSERT INTO tender_app.audit_event(id,actor_id,tender_id,action,entity,entity_id,entity_revision,worker_id) VALUES($1,$2,$3,$4,'intake_processing_run',$5,$6,$7)",
      [
        randomUUID(),
        t.created_by,
        t.tender_id,
        'intake.worker.rejected.' + code,
        t.id,
        t.state_revision,
        t.worker_id,
      ],
    );
  }
  async checkpoint(t: Ticket, stage: string, payload: unknown, timing: WorkerTiming) {
    return transaction(this.pool, async (c) => {
      await this.fenced(c, t);
      const body = JSON.stringify(canonical(payload)),
        sha = digest(body);
      await c.query(
        'INSERT INTO tender_app.intake_processing_checkpoint(id,tender_id,receipt_id,run_id,stage,payload,payload_sha,schema_version,worker_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(run_id,stage) DO NOTHING',
        [
          randomUUID(),
          t.tender_id,
          t.receipt_id,
          t.id,
          stage,
          body,
          sha,
          'intake-checkpoint-v1',
          t.worker_id,
        ],
      );
      const row = (
        await c.query(
          "UPDATE tender_app.intake_processing_run SET stage=$2,coverage=coverage||$3::jsonb,state_revision=state_revision+1,lease_expires_at=clock_timestamp()+$4*interval '1 millisecond' WHERE id=$1 RETURNING *",
          [t.id, stage, JSON.stringify({ [stage]: true, model: false }), timing.leaseMs],
        )
      ).rows[0];
      await this.runEvent(c, row, stage + '_checkpoint', undefined, t.worker_id);
      return row as Ticket;
    });
  }
  async checkpoints(t: Ticket) {
    const rows = (
      await this.pool.query(
        'SELECT stage,payload,payload_sha,schema_version FROM tender_app.intake_processing_checkpoint WHERE run_id=$1 AND tender_id=$2 AND receipt_id=$3',
        [t.id, t.tender_id, t.receipt_id],
      )
    ).rows;
    if (
      rows.some(
        (r) =>
          r.schema_version !== 'intake-checkpoint-v1' ||
          digest(JSON.stringify(canonical(r.payload))) !== r.payload_sha,
      )
    )
      throw Error('checkpoint_integrity_failed');
    return rows;
  }
  async history(actor: string, tender: string, receipt: string) {
    await this.read(actor, tender);
    if (
      !(
        await this.pool.query('SELECT 1 FROM tender_app.intake_receipt WHERE id=$1 AND tender_id=$2', [
          receipt,
          tender,
        ])
      ).rowCount
    )
      throw new NotFoundException();
    const runs = (
      await this.pool.query(
        'SELECT id,generation,retry_of,status,stage,attempt_count,state_revision,error_code,created_at,updated_at,completed_at,coverage,worker_id FROM tender_app.intake_processing_run WHERE tender_id=$1 AND receipt_id=$2 ORDER BY generation',
        [tender, receipt],
      )
    ).rows;
    const events = (
      await this.pool.query(
        'SELECT * FROM tender_app.intake_run_event WHERE tender_id=$1 AND receipt_id=$2 ORDER BY created_at,state_revision',
        [tender, receipt],
      )
    ).rows;
    const rejectedEvents = (
      await this.pool.query(
        "SELECT a.action AS code,a.entity_id AS run_id,a.worker_id,a.created_at FROM tender_app.audit_event a JOIN tender_app.intake_processing_run r ON r.id=a.entity_id AND r.tender_id=a.tender_id WHERE r.tender_id=$1 AND r.receipt_id=$2 AND a.action LIKE 'intake.worker.rejected.%' ORDER BY a.created_at",
        [tender, receipt],
      )
    ).rows;
    return { contractVersion: 'intake-processing-v2', runs, events, rejectedEvents };
  }
}
