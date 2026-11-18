import { IntakeReviewRepository } from './review-repository';
import {
  NativeCommercialPort,
  CommercialPort,
  CommercialCandidate,
  commercialSchema,
} from './commercial-port';
import { IntakePolicy } from './processing-policy';
import { IntakeQueue, Ticket, workerTiming } from './processing-queue';
import { Organization } from './organizations';
import { ContextAssociations } from './context-associations';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { PgScopeRepository } from '../data/scope-repository';
import { transaction } from '../data/repository';
import { FileRejected, IncomingOfferFile, inspectOffer } from '../offer-files';
import { FileStore } from '../storage/file-store';
import { Classification, schemaVersion, rulesVersion } from './classification';
import { ClassificationDecisionDto } from './intake.dto';
import { protectedTenders } from '../lifecycle/lifecycle-repository';
import {
  NativeOrganizationsExtractor,
  OrganizationsPort,
  organizationText,
  organizationSchema,
  validateOrganizations,
  TestOrganizationsMock,
} from './organizations';
import { OrganizationResolver } from './organization-resolver';
import { CompaniesQuery, OrganizationReader } from './organization-reader';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
interface Outcome {
  index: number;
  name: string;
  status: 'accepted' | 'rejected';
  code?: string;
  originalIds: string[];
  receiptIds: string[];
  runIds: string[];
}
export class PgIntakeRepository extends PgScopeRepository {
  constructor(
    pool: Pool,
    private readonly organizationsPort: OrganizationsPort = new NativeOrganizationsExtractor(),
    policy: IntakePolicy = new IntakePolicy(),
    private readonly commercialPort: CommercialPort = new NativeCommercialPort(),
  ) {
    super(pool);
    this.queue = new IntakeQueue(pool, policy);
    this.review = new IntakeReviewRepository(pool, this);
    if (commercialPort.method === 'test_mock' && process.env.NODE_ENV !== 'test')
      throw new Error('Test commercial port forbidden');
    if (organizationsPort instanceof TestOrganizationsMock && process.env.NODE_ENV !== 'test')
      throw new Error('Test organization port requires NODE_ENV=test');
  }
  readonly queue: IntakeQueue;
  readonly review: IntakeReviewRepository;
  protected override async lock(c: PoolClient, actor: string, id: string, revision?: number) {
    const value = await super.lock(c, actor, id, revision);
    if (protectedTenders.has(id)) throw new ConflictException('Protected tender is read only for intake');
    return value;
  }
  private async event(
    c: PoolClient,
    actor: string,
    tender: string,
    entity: string,
    entityId: string,
    action: string,
    revision: number,
    worker?: string,
  ) {
    await c.query(
      'INSERT INTO tender_app.audit_event(id,actor_id,tender_id,action,entity,entity_id,entity_revision,worker_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), actor, tender, action, entity, entityId, revision, worker ?? null],
    );
  }
  private async persist(
    c: PoolClient,
    actor: string,
    tender: string,
    receipt: string,
    original: string,
    sha: string,
    value: Classification,
    job: Ticket,
    organizations: Organization[],
  ) {
    const h = (
      await c.query(
        'SELECT * FROM tender_app.intake_classification_head WHERE receipt_id=$1 AND tender_id=$2 FOR UPDATE',
        [receipt, tender],
      )
    ).rows[0];
    const run = job.id,
      result = randomUUID(),
      revision = (h?.state_revision ?? 0) + 1,
      revisionId = randomUUID();
    const output = JSON.stringify(value);
    await c.query(
      'INSERT INTO tender_app.intake_result(id,tender_id,run_id,receipt_id,original_id,source_sha,schema_version,rules_version,output,output_sha,coverage) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        result,
        tender,
        run,
        receipt,
        original,
        sha,
        schemaVersion,
        rulesVersion,
        output,
        hash(output),
        JSON.stringify(value.coverage),
      ],
    );
    const evidence: string[] = [];
    for (const e of value.evidence) {
      const eid = randomUUID();
      evidence.push(eid);
      await c.query(
        "INSERT INTO tender_app.intake_evidence(id,tender_id,result_id,original_id,receipt_id,source_sha,field_path,page,sheet,cell_range,excerpt,method) VALUES($1,$2,$3,$4,$5,$6,'classification.type',$7,$8,$9,$10,'native_content_marker')",
        [
          eid,
          tender,
          result,
          original,
          receipt,
          sha,
          e.page,
          e.sheet ?? null,
          e.cellRange ?? null,
          e.excerpt,
        ],
      );
    }
    await c.query(
      "INSERT INTO tender_app.intake_classification_revision(id,tender_id,receipt_id,revision,type,review_state,source,result_id,evidence_id,reason,supersedes_id,created_by) VALUES($1,$2,$3,$4,$5,$6,'rules',$7,$8,$9,$10,$11)",
      [
        revisionId,
        tender,
        receipt,
        revision,
        value.type,
        value.type === 'unknown' ? 'needs_review' : 'proposed',
        result,
        evidence[0] ?? null,
        value.reason,
        h?.current_revision_id ?? null,
        actor,
      ],
    );
    if (h)
      await c.query(
        'UPDATE tender_app.intake_classification_head SET current_revision_id=$2,state_revision=$3 WHERE receipt_id=$1',
        [receipt, revisionId, revision],
      );
    else
      await c.query(
        'INSERT INTO tender_app.intake_classification_head(receipt_id,tender_id,current_revision_id,state_revision) VALUES($1,$2,$3,1)',
        [receipt, tender, revisionId],
      );
    await this.event(
      c,
      actor,
      tender,
      'intake_receipt',
      receipt,
      'intake.classified',
      revision,
      job.worker_id,
    );
    await new OrganizationResolver().persist(
      c,
      {
        tender,
        receipt,
        original,
        sha,
        result,
        actor,
        method: this.organizationsPort.method,
        policyVersion: job.policy_version,
        worker: job.worker_id,
      },
      organizations,
    );
    return run;
  }
  async batch(
    actor: string,
    tender: string,
    key: string,
    files: IncomingOfferFile[],
    store: FileStore,
    stageId?: string,
  ) {
    await this.assertWrite(actor, tender);
    const manifest = hash(
      JSON.stringify({
        version: 'intake-v1',
        stageId: stageId ?? null,
        files: files.map((f) => ({ name: f.name, mime: f.mime, sha: hash(f.content) })),
      }),
    );
    const replay = (
      await this.pool.query(
        'SELECT id,request_hash,outcomes FROM tender_app.intake_batch WHERE tender_id=$1 AND request_key=$2',
        [tender, key],
      )
    ).rows[0];
    if (replay) {
      if (replay.request_hash !== manifest) throw new ConflictException();
      return { contractVersion: 'intake-v1', batchId: replay.id, outcomes: replay.outcomes, replayed: true };
    }
    const intakePolicy = await this.queue.policy.current();
    const prepared: (
      | { error: string }
      | {
          parts: {
            file: IncomingOfferFile;
            blob: Awaited<ReturnType<FileStore['put']>>;
          }[];
        }
    )[] = [];
    for (const f of files) {
      let parts: IncomingOfferFile[];
      try {
        parts = intakePolicy.reason(hash(f.content)) ? blockedIntakePart(f) : inspectOffer({ ...f });
      } catch (e) {
        if (e instanceof FileRejected) {
          prepared.push({ error: e.code });
          continue;
        }
        throw e;
      }
      const output = [];
      for (const part of parts)
        output.push({
          file: part,
          blob: await store.put(part.content),
        });
      prepared.push({ parts: output });
    }
    return transaction(this.pool, async (c) => {
      await this.lock(c, actor, tender);
      const currentPolicy = await this.queue.policy.current();
      const existing = (
        await c.query(
          'SELECT id,request_hash,outcomes FROM tender_app.intake_batch WHERE tender_id=$1 AND request_key=$2',
          [tender, key],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== manifest) throw new ConflictException();
        return {
          contractVersion: 'intake-v1',
          batchId: existing.id,
          outcomes: existing.outcomes,
          replayed: true,
        };
      }
      if (
        stageId &&
        !(
          await c.query('SELECT 1 FROM tender_app.tender_stage WHERE tender_id=$1 AND id=$2', [
            tender,
            stageId,
          ])
        ).rowCount
      )
        throw new BadRequestException();
      const batchId = randomUUID(),
        outcomes: Outcome[] = [];
      for (const [index, p] of prepared.entries()) {
        const out: Outcome = {
          index,
          name: files[index].name,
          status: 'error' in p ? 'rejected' : 'accepted',
          originalIds: [],
          receiptIds: [],
          runIds: [],
        };
        if ('error' in p) out.code = p.error;
        else
          for (const [partIndex, part] of p.parts.entries()) {
            const { file, blob } = part;
            await c.query(
              'INSERT INTO tender_app.blob(sha256,storage_key,byte_size) VALUES($1,$2,$3) ON CONFLICT(sha256) DO NOTHING',
              [blob.sha256, blob.key, blob.bytes],
            );
            let original = (
              await c.query(
                'SELECT id FROM tender_app.intake_document WHERE tender_id=$1 AND blob_sha256=$2',
                [tender, blob.sha256],
              )
            ).rows[0]?.id;
            if (!original) {
              original = randomUUID();
              await c.query(
                'INSERT INTO tender_app.intake_document(id,tender_id,blob_sha256,original_name,mime_type,created_by) VALUES($1,$2,$3,$4,$5,$6)',
                [original, tender, blob.sha256, file.name, file.mime, actor],
              );
            }
            const receipt = randomUUID();
            await c.query(
              'INSERT INTO tender_app.intake_receipt(id,tender_id,batch_id,original_id,top_level_index,part_path,parent_receipt_id,channel,declared_sender,original_name,declared_mime,stage_id,received_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
              [
                receipt,
                tender,
                batchId,
                original,
                index,
                String(partIndex),
                file.parent === undefined ? null : out.receiptIds[file.parent],
                file.parent !== undefined || file.mime === 'message/rfc822' ? 'email' : 'manual',
                file.sender ?? null,
                file.name,
                partIndex === 0 ? files[index].mime : file.mime,
                stageId ?? null,
                actor,
              ],
            );
            out.originalIds.push(original);
            out.receiptIds.push(receipt);
            out.runIds.push(
              await this.queue.enqueue(c, actor, tender, receipt, original, blob.sha256, currentPolicy),
            );
            await this.event(c, actor, tender, 'intake_receipt', receipt, 'intake.received', 1);
          }
        outcomes.push(out);
      }
      await c.query(
        'INSERT INTO tender_app.intake_batch(id,tender_id,request_key,request_hash,stage_id,actor_id,outcomes) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [batchId, tender, key, manifest, stageId ?? null, actor, JSON.stringify(outcomes)],
      );
      await this.event(c, actor, tender, 'intake_batch', batchId, 'intake.batch.accepted', 1);
      return { contractVersion: 'intake-v1', batchId, outcomes, replayed: false };
    });
  }
  async list(actor: string, tender: string) {
    await this.read(actor, tender);
    return (
      await this.pool.query(
        `SELECT r.id AS "receiptId",r.original_id AS "originalId",r.original_name AS name,d.mime_type AS "mimeType",d.blob_sha256 AS "blobSha256",r.received_at AS "receivedAt",r.batch_id AS "batchId",r.parent_receipt_id AS "parentReceiptId",r.declared_sender AS "declaredSender",r.stage_id AS "stageId",
      COALESCE(h.state_revision,0) AS revision,COALESCE(initial.type,'unknown') AS "initialType",COALESCE(effective.type,'unknown') AS type,effective.review_state AS "reviewState",COALESCE(effective.reason,run.error_code) AS reason,
      current.type AS "proposedType",run.status AS "processingStatus",run.stage AS "processingStage",run.state_revision AS "runRevision",run.attempt_count AS "attemptCount",run.updated_at AS "updatedAt",COALESCE(result.coverage,run.coverage) AS coverage,result.id AS "resultId"
      FROM tender_app.intake_receipt r JOIN tender_app.intake_document d ON d.id=r.original_id
      LEFT JOIN tender_app.intake_classification_head h ON h.receipt_id=r.id
      LEFT JOIN tender_app.intake_classification_revision current ON current.id=h.current_revision_id
      LEFT JOIN tender_app.intake_classification_revision effective ON effective.id=COALESCE(h.approved_revision_id,h.current_revision_id)
      LEFT JOIN tender_app.intake_classification_revision initial ON initial.receipt_id=r.id AND initial.revision=1
      JOIN LATERAL (SELECT * FROM tender_app.intake_processing_run pr WHERE pr.receipt_id=r.id ORDER BY generation DESC LIMIT 1) run ON true
      LEFT JOIN tender_app.intake_result result ON result.run_id=run.id
      WHERE r.tender_id=$1 ORDER BY r.received_at,r.id LIMIT 1000`,
        [tender],
      )
    ).rows;
  }
  async getBatch(actor: string, tender: string, id: string) {
    await this.read(actor, tender);
    const row = (
      await this.pool.query(
        'SELECT id AS "batchId",outcomes,created_at AS "createdAt",actor_id AS "actorId",stage_id AS "stageId" FROM tender_app.intake_batch WHERE id=$1 AND tender_id=$2',
        [id, tender],
      )
    ).rows[0];
    if (!row) throw new NotFoundException();
    const processingRuns = (
      await this.pool.query(
        'SELECT p.id,p.receipt_id,p.status,p.stage,p.attempt_count,p.error_code,p.updated_at,p.coverage FROM tender_app.intake_processing_run p JOIN tender_app.intake_receipt r ON r.id=p.receipt_id WHERE r.batch_id=$1 AND r.tender_id=$2 ORDER BY p.enqueue_order',
        [id, tender],
      )
    ).rows;
    return {
      contractVersion: 'intake-v1',
      processingContractVersion: 'intake-processing-v2',
      ...row,
      processingRuns,
    };
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
    return {
      processing: await this.queue.history(actor, tender, receipt),
      ...(await new OrganizationReader(this.pool).receipt(tender, receipt)),
      revisions: (
        await this.pool.query(
          'SELECT id,revision,type,review_state AS "reviewState",source,reason,created_by AS "actorId",created_at AS "createdAt" FROM tender_app.intake_classification_revision WHERE receipt_id=$1 AND tender_id=$2 ORDER BY revision',
          [receipt, tender],
        )
      ).rows,
      evidence: (
        await this.pool.query(
          'SELECT id,page,sheet,cell_range AS "cellRange",excerpt,result_id AS "resultId",source_sha AS "sourceSha" FROM tender_app.intake_evidence WHERE receipt_id=$1 AND tender_id=$2 ORDER BY id',
          [receipt, tender],
        )
      ).rows,
    };
  }
  async original(actor: string, tender: string, id: string) {
    await this.read(actor, tender);
    const row = (
      await this.pool.query(
        'SELECT d.original_name AS name,b.storage_key AS key FROM tender_app.intake_document d JOIN tender_app.blob b ON b.sha256=d.blob_sha256 WHERE d.id=$1 AND d.tender_id=$2',
        [id, tender],
      )
    ).rows[0];
    if (!row) throw new NotFoundException();
    return row as { name: string; key: string };
  }
  async decision(actor: string, tender: string, receipt: string, input: ClassificationDecisionDto) {
    return transaction(this.pool, async (c) => {
      await this.lock(c, actor, tender);
      const h = (
        await c.query(
          'SELECT * FROM tender_app.intake_classification_head WHERE receipt_id=$1 AND tender_id=$2 FOR UPDATE',
          [receipt, tender],
        )
      ).rows[0];
      if (!h) throw new NotFoundException();
      if (h.state_revision !== input.expectedRevision) throw new ConflictException();
      const previous = (
        await c.query('SELECT type FROM tender_app.intake_classification_revision WHERE id=$1', [
          h.approved_revision_id ?? h.current_revision_id,
        ])
      ).rows[0];
      if (input.action === 'change' && !input.type) throw new BadRequestException();
      const type = input.action === 'reject' ? 'unknown' : (input.type ?? previous.type);
      const revision = h.state_revision + 1,
        id = randomUUID();
      await c.query(
        "INSERT INTO tender_app.intake_classification_revision(id,tender_id,receipt_id,revision,type,review_state,source,reason,supersedes_id,created_by) VALUES($1,$2,$3,$4,$5,$6,'human',$7,$8,$9)",
        [
          id,
          tender,
          receipt,
          revision,
          type,
          input.action === 'reject' ? 'rejected' : 'confirmed',
          input.note.trim(),
          h.current_revision_id,
          actor,
        ],
      );
      await c.query(
        'UPDATE tender_app.intake_classification_head SET current_revision_id=$2,approved_revision_id=$2,state_revision=$3 WHERE receipt_id=$1',
        [receipt, id, revision],
      );
      await this.event(
        c,
        actor,
        tender,
        'intake_receipt',
        receipt,
        'intake.classification.' + input.action,
        revision,
      );
      return { receiptId: receipt, revision, type };
    });
  }
  async completeWorker(
    job: Ticket,
    value: Classification,
    organizations: Organization[],
    timing: ReturnType<typeof workerTiming>,
    afterResolver?: () => Promise<void>,
    pages: import('./organizations').TextPage[] = [],
  ) {
    return transaction(this.pool, async (c) => {
      const owned = await this.queue.fenced(c, job);
      const final = (
        await c.query(
          "UPDATE tender_app.intake_processing_run SET status='completed',stage='completed',state_revision=state_revision+1,completed_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,coverage=$2 WHERE id=$1 RETURNING *",
          [
            job.id,
            JSON.stringify({
              ...job.coverage,
              classification: true,
              organizations: true,
              resolver: true,
              associations: true,
              model: false,
            }),
          ],
        )
      ).rows[0];
      await this.persist(
        c,
        job.created_by,
        job.tender_id,
        job.receipt_id,
        job.original_id,
        job.source_sha,
        value,
        job,
        organizations,
      );
      const saved = (
        await c.query('SELECT * FROM tender_app.intake_result WHERE run_id=$1 AND tender_id=$2', [
          job.id,
          job.tender_id,
        ])
      ).rows[0];
      const checkpoint = (
        await c.query(
          "SELECT payload FROM tender_app.intake_processing_checkpoint WHERE run_id=$1 AND stage='organizations'",
          [job.id],
        )
      ).rows[0];
      const candidates = (checkpoint?.payload.commercial ?? []) as CommercialCandidate[];
      const output: Record<string, { value: string; evidenceId: string }> = {};
      for (const field of candidates) {
        if (
          !['amount', 'currency', 'vatMode', 'paymentTerms', 'deliveryTerms'].includes(field.field) ||
          !pages.some((p) => p.page === field.page && p.text.includes(field.excerpt)) ||
          field.excerpt.length > 2000
        )
          throw new BadRequestException('commercial_evidence_invalid');
        const evidenceId = randomUUID();
        await c.query(
          'INSERT INTO tender_app.intake_evidence(id,tender_id,result_id,original_id,receipt_id,source_sha,field_path,page,excerpt,method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            evidenceId,
            job.tender_id,
            saved.id,
            job.original_id,
            job.receipt_id,
            job.source_sha,
            'commercial.fields.' + field.field,
            field.page,
            field.excerpt,
            checkpoint.payload.commercialMethod,
          ],
        );
        output[field.field] = { value: field.value, evidenceId };
      }
      await c.query(
        'INSERT INTO tender_app.intake_commercial_result(result_id,tender_id,receipt_id,schema_version,method,model,output) VALUES($1,$2,$3,$4,$5,false,$6)',
        [
          saved.id,
          job.tender_id,
          job.receipt_id,
          commercialSchema,
          checkpoint?.payload.commercialMethod ?? 'native_labeled',
          JSON.stringify(output),
        ],
      );
      await new ContextAssociations().persist(c, job, value, pages);
      await afterResolver?.();
      if (
        !(await c.query('SELECT $1::timestamptz>clock_timestamp() valid', [owned.lease_expires_at])).rows[0]
          .valid
      )
        throw new ConflictException('lease_expired_before_commit');
      const policy = await this.queue.policy.current();
      if (policy.version !== job.policy_version || policy.reason(job.source_sha))
        throw new ConflictException('policy_changed');
      await this.queue.runEvent(c, final, 'completed', undefined, job.worker_id);
      void timing;
      return final;
    });
  }
  async workerExtract(job: Ticket, file: IncomingOfferFile) {
    const policy = await this.queue.policy.current();
    if (policy.version !== job.policy_version || policy.reason(job.source_sha))
      throw new ConflictException('policy_changed');
    const pages = await organizationText(file);
    const organizations = await this.organizationsPort.extract({
      tenderId: job.tender_id,
      originalId: job.original_id,
      receiptId: job.receipt_id,
      contractVersion: organizationSchema,
      pages,
      structure: { mime: file.mime },
    });
    validateOrganizations(organizations, pages);
    if (
      organizations.some((o) => o.extraction_method !== this.organizationsPort.method) ||
      (this.organizationsPort.method === 'localai' && organizations.length)
    )
      throw new BadRequestException('adapter_disabled_or_mislabeled');
    const commercial = await this.commercialPort.extract(pages);
    return { organizations, pages, commercial, commercialMethod: this.commercialPort.method };
  }
  async processing(actor: string, tender: string, receipt: string) {
    return this.queue.history(actor, tender, receipt);
  }
  async companies(actor: string, tender: string, query: CompaniesQuery) {
    await this.read(actor, tender);
    return new OrganizationReader(this.pool).list(tender, query);
  }
  async company(actor: string, tender: string, id: string) {
    await this.read(actor, tender);
    return new OrganizationReader(this.pool).detail(tender, id);
  }
  /** Explicit resolver replay, used by isolated integration tests; no HTTP write endpoint. */
  async replayOrganizations(actor: string, tender: string, result: string) {
    return transaction(this.pool, async (c) => {
      await this.lock(c, actor, tender);
      const r = (
        await c.query(
          'SELECT o.*,p.policy_version processing_policy_version FROM tender_app.intake_organization_result o JOIN tender_app.intake_result cr ON cr.id=o.classification_result_id AND cr.tender_id=o.tender_id JOIN tender_app.intake_processing_run p ON p.id=cr.run_id WHERE o.id=$1 AND o.tender_id=$2',
          [result, tender],
        )
      ).rows[0];
      if (!r) throw new NotFoundException();
      return new OrganizationResolver().persist(
        c,
        {
          tender,
          receipt: r.receipt_id,
          original: r.original_id,
          sha: r.source_sha,
          result: r.classification_result_id,
          actor,
          method: r.extraction_method,
          policyVersion: r.processing_policy_version,
        },
        r.output,
      );
    });
  }
}

function blockedIntakePart(file: IncomingOfferFile): IncomingOfferFile[] {
  const m: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    eml: 'message/rfc822',
  };
  const ext = file.name.toLowerCase().split('.').pop()!;
  if (!m[ext]) throw new FileRejected('unsupported_type');
  if (
    !file.name ||
    file.name.length > 255 ||
    /[\\/]/.test(file.name) ||
    [...file.name].some((c) => c.charCodeAt(0) < 32)
  )
    throw new FileRejected('invalid_filename');
  if (!file.content.length || file.content.length > 20 * 1024 * 1024) throw new FileRejected('file_size');
  if (file.mime !== m[ext]) throw new FileRejected('type_mismatch');
  return [{ ...file, mime: m[ext] }];
}
