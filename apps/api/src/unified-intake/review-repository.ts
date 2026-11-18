import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { PgScopeRepository } from '../data/scope-repository';
import { transaction } from '../data/repository';
import type { PgIntakeRepository } from './intake-repository';
import {
  AssociationDecisionDto,
  ObservationDecisionDto,
  CompanyDecisionDto,
  ReviewClassificationDto,
  TransferDraftDto,
  WorkspaceQueryDto,
} from './review.dto';
import { identifier, Identifier } from './organization-identity';
import {
  actualContext,
  acknowledgeImpact,
  assertReference,
  confirmedContext,
  humanDecision,
  impact,
  operationReplay,
  projectReceipt,
  receiptResult,
  Row,
  strings,
  valueHash,
} from './business-bridge';
export class IntakeReviewRepository extends PgScopeRepository {
  constructor(
    pool: Pool,
    private readonly intake: PgIntakeRepository,
  ) {
    super(pool);
  }
  async workspace(actor: string, tender: string, q: WorkspaceQueryDto) {
    await this.read(actor, tender);
    const receipts = (
      await this.pool.query(
        `SELECT r.id AS "receiptId",r.original_id AS "originalId",r.original_name AS name,r.declared_mime AS mime,b.byte_size::text AS bytes,d.blob_sha256 AS sha256,r.stage_id AS "stageId",p.status AS "processingState",p.stage AS "processingStage",p.attempt_count AS attempts,p.coverage,p.error_code AS "safeError",p.updated_at AS "updatedAt",p.state_revision AS "runRevision",cl.type AS "initialClassification",eff.type AS "effectiveClassification",eff.review_state AS "classificationReview",ch.state_revision AS "classificationRevision",COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'companyId',a.company_id,'targetReceiptId',a.target_receipt_id,'kind',a.association_type,'state',a.state,'revision',h.state_revision,'companyReview',cr.review_state,'supplierId',co.confirmed_supplier_id)) FROM tender_app.intake_association_head h JOIN tender_app.intake_association_revision a ON a.id=h.current_revision_id LEFT JOIN tender_app.intake_company co ON co.id=a.company_id AND co.tender_id=a.tender_id LEFT JOIN tender_app.intake_company_revision cr ON cr.id=co.current_revision_id WHERE h.receipt_id=r.id AND h.tender_id=r.tender_id),'[]'::jsonb) AS associations,rp.legacy_document_id AS "legacyDocumentId",rp.legacy_receipt_id AS "legacyReceiptId",COALESCE((SELECT v.intent FROM tender_app.intake_verification_context v WHERE v.receipt_id=r.id ORDER BY v.offer_version_id DESC LIMIT 1),'not_transferred') AS "commercialReview" FROM tender_app.intake_receipt r JOIN tender_app.intake_document d ON d.id=r.original_id JOIN tender_app.blob b ON b.sha256=d.blob_sha256 LEFT JOIN LATERAL(SELECT * FROM tender_app.intake_processing_run j WHERE j.receipt_id=r.id ORDER BY j.generation DESC LIMIT 1)p ON true LEFT JOIN tender_app.intake_classification_head ch ON ch.receipt_id=r.id LEFT JOIN tender_app.intake_classification_revision eff ON eff.id=COALESCE(ch.approved_revision_id,ch.current_revision_id) LEFT JOIN LATERAL(SELECT type FROM tender_app.intake_classification_revision x WHERE x.receipt_id=r.id ORDER BY x.revision LIMIT 1)cl ON true LEFT JOIN tender_app.intake_receipt_projection rp ON rp.receipt_id=r.id AND rp.purpose=eff.type WHERE r.tender_id=$1 ORDER BY r.received_at,r.id`,
        [tender],
      )
    ).rows;
    for (const r of receipts) {
      if (r.commercialReview === 'confirm') {
        const last = (
          await this.pool.query(
            'SELECT v.offer_version_id FROM tender_app.intake_verification_context v JOIN tender_app.offer_version ov ON ov.id=v.offer_version_id WHERE v.tender_id=$1 AND v.receipt_id=$2 ORDER BY ov.created_at DESC,ov.version DESC LIMIT 1',
            [tender, r.receiptId],
          )
        ).rows[0];
        if (last && (await actualContext(this.pool, tender, last.offer_version_id)))
          r.commercialReview = 'stale';
      }
    }
    const canWrite = (
      await this.pool.query(
        "SELECT (t.owner_id=$1 OR EXISTS(SELECT 1 FROM tender_app.tender_member m WHERE m.tender_id=t.id AND m.user_id=$1 AND m.role IN ('buyer','manager'))) AND NOT EXISTS(SELECT 1 FROM tender_app.tender_lifecycle l WHERE l.tender_id=t.id AND l.state<>'active') AS allowed FROM tender_app.tender t WHERE t.id=$2",
        [actor, tender],
      )
    ).rows[0].allowed;
    const filtered = receipts
      .filter((r) => !q.receiptId || r.receiptId === q.receiptId)
      .filter((r) =>
        q.filter === 'errors'
          ? ['failed', 'blocked', 'unsupported'].includes(r.processingState)
          : q.filter === 'unassigned'
            ? !r.associations.some((a: Row) => a.kind === 'supplier_of' && a.state === 'confirmed')
            : q.filter === 'review'
              ? r.classificationReview !== 'confirmed' ||
                r.associations.some((a: Row) => a.state !== 'confirmed' || a.companyReview !== 'confirmed')
              : q.filter === 'preliminary'
                ? r.associations.some((a: Row) => a.companyId && a.companyReview !== 'confirmed')
                : true,
      );
    if (q.sort === 'received_desc') filtered.reverse();
    if (q.sort === 'name')
      filtered.sort(
        (a, b) =>
          String(a.name).localeCompare(String(b.name)) ||
          String(a.receiptId).localeCompare(String(b.receiptId)),
      );
    return {
      canWrite,
      page: q.page,
      pageSize: q.pageSize,
      total: filtered.length,
      allCount: receipts.length,
      items: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
      companies: await this.intake.companies(actor, tender, { limit: '100' }),
      warnings: ['Обработка не подтверждает компанию, тип, связь, контакт, аккредитацию или цену.'],
    };
  }
  async detail(actor: string, tender: string, receipt: string) {
    await this.read(actor, tender);
    await assertReference(this.pool, 'intake_receipt', tender, receipt);
    const [history, evidence, drafts, decisions, commercial, projections] = await Promise.all([
      this.intake.history(actor, tender, receipt),
      this.pool.query(
        'SELECT e.* FROM tender_app.intake_evidence e WHERE e.tender_id=$1 AND e.receipt_id=$2 ORDER BY e.id',
        [tender, receipt],
      ),
      this.pool.query(
        'SELECT * FROM tender_app.intake_commercial_draft WHERE tender_id=$1 AND receipt_id=$2 ORDER BY revision',
        [tender, receipt],
      ),
      this.pool.query(
        'SELECT * FROM tender_app.intake_review_decision WHERE tender_id=$1 AND receipt_id=$2 ORDER BY created_at,id',
        [tender, receipt],
      ),
      this.pool.query(
        'SELECT * FROM tender_app.intake_commercial_result WHERE tender_id=$1 AND receipt_id=$2 ORDER BY created_at DESC',
        [tender, receipt],
      ),
      this.pool.query(
        'SELECT * FROM tender_app.intake_receipt_projection WHERE tender_id=$1 AND receipt_id=$2',
        [tender, receipt],
      ),
    ]);
    let context;
    try {
      context = await confirmedContext(this.pool, tender, receipt);
    } catch (error) {
      if (!(error instanceof ConflictException || error instanceof NotFoundException)) throw error;
      context = null;
    }
    const affected = await impact(this.pool, tender, receipt);
    const card = await this.workspace(actor, tender, {
      page: 1,
      pageSize: 1,
      filter: 'all',
      sort: 'received_asc',
      receiptId: receipt,
    });
    const observationDecisions = (
      await this.pool.query(
        'SELECT * FROM tender_app.intake_observation_decision WHERE tender_id=$1 AND receipt_id=$2 ORDER BY revision,created_at,id',
        [tender, receipt],
      )
    ).rows;
    const draftFields = (
      await this.pool.query(
        'SELECT f.*,m.note AS manual_note,m.actor_id AS manual_actor_id,m.created_at AS manual_created_at FROM tender_app.intake_draft_field f LEFT JOIN tender_app.intake_manual_source m ON m.id=f.manual_decision_id AND m.tender_id=f.tender_id WHERE f.tender_id=$1 AND f.receipt_id=$2 ORDER BY f.draft_id,f.field_path',
        [tender, receipt],
      )
    ).rows;
    return {
      draftFields,
      ...history,
      receipt: card.items[0],
      observationDecisions,
      evidence: evidence.rows,
      drafts: drafts.rows,
      decisions: decisions.rows,
      commercial: commercial.rows[0] ?? null,
      projections: projections.rows,
      intakeContext: context,
      impact: { versions: affected, previewHash: valueHash(affected) },
    };
  }
  async evidence(actor: string, tender: string, receipt: string, result: string, id: string) {
    await this.read(actor, tender);
    const found = (
      await this.pool.query(
        'SELECT * FROM tender_app.intake_evidence WHERE tender_id=$1 AND receipt_id=$2 AND result_id=$3 AND id=$4',
        [tender, receipt, result, id],
      )
    ).rows[0];
    if (!found) throw new NotFoundException();
    return found;
  }
  private async companyHead(c: PoolClient, tender: string, id: string) {
    const row = (
      await c.query(
        'SELECT co.*,r.requisites,r.source_observations,r.evidence_ids,r.review_state FROM tender_app.intake_company co JOIN tender_app.intake_company_revision r ON r.id=co.current_revision_id WHERE co.tender_id=$1 AND co.id=$2 FOR UPDATE OF co',
        [tender, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }
  async companyDecision(
    actor: string,
    tender: string,
    company: string,
    key: string,
    input: CompanyDecisionDto,
  ) {
    return transaction(this.pool, async (c) => {
      await this.lock(c, actor, tender);
      const op = await operationReplay(c, tender, key, { kind: 'company', company, input });
      if (op.reply) return op.reply;
      const head = await this.companyHead(c, tender, company);
      if (head.state_revision !== input.expectedRevision)
        throw new ConflictException('stale_company_revision');
      const data = { ...head.requisites };
      let supplier: string | null = null,
        state = 'needs_review';
      if (input.action === 'edit') {
        if (
          !input.changes ||
          !Object.keys(input.changes).length ||
          input.existingSupplierId ||
          input.createFromRevision !== undefined
        )
          throw new BadRequestException();
        const changes = input.changes;
        if (changes.legalName !== undefined)
          data.names = [changes.legalName, ...strings(data.names).slice(1)];
        if (changes.country !== undefined)
          data.countries = [changes.country, ...strings(data.countries).slice(1)];
        if (changes.address !== undefined)
          data.addresses = [changes.address, ...strings(data.addresses).slice(1)];
        if (changes.email !== undefined) data.emails = [changes.email, ...strings(data.emails).slice(1)];
        if (
          changes.registrationNumber !== undefined ||
          (changes.country !== undefined && data.identifiers?.length)
        ) {
          const country = strings(data.countries)[0] ?? null;
          const number = identifier(
            country,
            country === 'GB' ? 'GB_CRN' : 'RU_INN',
            changes.registrationNumber ?? data.identifiers[0].raw_value,
          );
          if (!number.valid) throw new BadRequestException('invalid_registration_number');
          data.identifiers = [number];
        }
        data.manualSources = {
          ...(data.manualSources ?? {}),
          ...Object.fromEntries(
            Object.keys(changes).map((field) => [
              field,
              { actorId: actor, note: input.note, at: new Date().toISOString(), source: 'manual' },
            ]),
          ),
        };
        state = 'proposed';
      } else if (input.action === 'confirm' || input.action === 'choose_existing') {
        if (
          input.changes ||
          (input.createFromRevision === true) === !!input.existingSupplierId ||
          (input.action === 'choose_existing' && !input.existingSupplierId)
        )
          throw new BadRequestException('exactly_one_supplier_target_required');
        if (
          input.existingSupplierId &&
          !(
            await c.query('SELECT 1 FROM tender_app.tender_supplier WHERE tender_id=$1 AND supplier_id=$2', [
              tender,
              input.existingSupplierId,
            ])
          ).rowCount
        )
          throw new NotFoundException();
        if (head.confirmed_supplier_id) {
          if (input.existingSupplierId && input.existingSupplierId !== head.confirmed_supplier_id)
            throw new ConflictException('company_already_confirmed');
          const reply = {
            companyId: company,
            supplierId: head.confirmed_supplier_id,
            revision: head.state_revision,
            revisionId: head.current_revision_id,
          };
          await humanDecision(
            c,
            actor,
            tender,
            key,
            op.hash,
            'company',
            company,
            input.expectedRevision,
            input.action === 'choose_existing' ? 'choose_existing' : 'confirm',
            input.note,
            head,
            reply,
          );
          return reply;
        }
        const ids = (data.identifiers ?? []) as Identifier[],
          strong = ids.filter((i) => i.valid && i.normalized_value),
          country = strings(data.countries)[0] ?? null;
        if ((data.conflicts ?? []).length) throw new ConflictException('company_identity_needs_review');
        for (const item of strong) {
          const conflicting = (
            await c.query(
              'SELECT 1 FROM tender_app.intake_identity_claim WHERE tender_id=$1 AND country_key=$2 AND scheme=$3 AND normalized_value=$4 AND company_id<>$5',
              [tender, country, item.scheme, item.normalized_value, company],
            )
          ).rowCount;
          if (conflicting) throw new ConflictException('identity_claim_conflict');
        }
        if (input.existingSupplierId) {
          if (
            !(
              await c.query(
                'SELECT 1 FROM tender_app.tender_supplier WHERE tender_id=$1 AND supplier_id=$2',
                [tender, input.existingSupplierId],
              )
            ).rowCount
          )
            throw new NotFoundException();
          supplier = input.existingSupplierId;
          const target = (await c.query('SELECT * FROM tender_app.supplier WHERE id=$1', [supplier])).rows[0];
          if (
            strong.length &&
            (target.country !== country ||
              (target.tax_id &&
                strong.every(
                  (i) => i.normalized_value !== identifier(country, i.scheme, target.tax_id).normalized_value,
                )))
          )
            throw new ConflictException('supplier_identity_conflict');
        } else {
          const tax = strong[0]?.normalized_value ?? null;
          if (
            tax &&
            (
              await c.query(
                'SELECT 1 FROM tender_app.tender_supplier ts JOIN tender_app.supplier s ON s.id=ts.supplier_id WHERE ts.tender_id=$1 AND s.tax_id=$2 AND s.country IS NOT DISTINCT FROM $3',
                [tender, tax, country],
              )
            ).rowCount
          )
            throw new ConflictException('existing_supplier_identity_requires_explicit_choice');
          const name = strings(data.names)[0];
          if (!name) throw new BadRequestException('company_name_required');
          supplier = randomUUID();
          await c.query(
            'INSERT INTO tender_app.supplier(id,legal_name,tax_id,email,country,verified_by,verified_at) VALUES($1,$2,$3,$4,$5,$6,now())',
            [supplier, name, tax, strings(data.emails)[0] ?? null, country, actor],
          );
          await c.query(
            "INSERT INTO tender_app.tender_supplier(tender_id,supplier_id,contact_status) VALUES($1,$2,'unresolved')",
            [tender, supplier],
          );
          for (const email of strings(data.emails))
            await c.query(
              'INSERT INTO tender_app.contact(id,tender_id,supplier_id,email,verified) VALUES($1,$2,$3,$4,false)',
              [randomUUID(), tender, supplier, email],
            );
        }
        state = 'confirmed';
      } else {
        if (input.changes || input.existingSupplierId || input.createFromRevision !== undefined)
          throw new BadRequestException();
        state = input.action === 'reject' ? 'rejected' : 'needs_review';
      }
      const revision = head.state_revision + 1,
        id = randomUUID();
      await c.query(
        "INSERT INTO tender_app.intake_company_revision(id,tender_id,company_id,revision,requisites,source_observations,evidence_ids,review_state,reason,source,actor_id,supersedes_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'human',$10,$11)",
        [
          id,
          tender,
          company,
          revision,
          JSON.stringify(data),
          head.source_observations,
          head.evidence_ids,
          state,
          input.note,
          actor,
          head.current_revision_id,
        ],
      );
      await c.query(
        'UPDATE tender_app.intake_company SET current_revision_id=$2,state_revision=$3,confirmed_supplier_id=$4 WHERE id=$1',
        [company, id, revision, supplier],
      );
      const reply = {
        companyId: company,
        supplierId: supplier,
        revision,
        revisionId: id,
        reviewState: state,
      };
      await humanDecision(
        c,
        actor,
        tender,
        key,
        op.hash,
        'company',
        company,
        input.expectedRevision,
        input.action === 'choose_existing' ? 'choose_existing' : input.action,
        input.note,
        head,
        reply,
      );
      return reply;
    });
  }
  async observationDecision(
    actor: string,
    tender: string,
    receipt: string,
    observation: string,
    key: string,
    input: ObservationDecisionDto,
  ) {
    return transaction(this.pool, async (c) => {
      await this.lock(c, actor, tender);
      const op = await operationReplay(c, tender, key, { kind: 'observation', receipt, observation, input });
      if (op.reply) return op.reply;
      const original = (
        await c.query(
          'SELECT * FROM tender_app.intake_organization_observation WHERE id=$1 AND tender_id=$2 AND receipt_id=$3',
          [observation, tender, receipt],
        )
      ).rows[0];
      if (!original) throw new NotFoundException();
      const last = (
        await c.query(
          'SELECT * FROM tender_app.intake_observation_decision WHERE observation_id=$1 AND tender_id=$2 ORDER BY revision DESC LIMIT 1',
          [observation, tender],
        )
      ).rows[0];
      if ((last?.revision ?? 0) !== input.expectedRevision)
        throw new ConflictException('stale_observation_revision');
      await acknowledgeImpact(c, tender, receipt, input.impactPreviewHash, input.acknowledgeImpact);
      const reply = {
        observationId: observation,
        receiptId: receipt,
        revision: input.expectedRevision + 1,
        state: 'rejected',
      };
      const decision = await humanDecision(
        c,
        actor,
        tender,
        key,
        op.hash,
        'receipt',
        receipt,
        input.expectedRevision,
        'reject',
        input.note,
        last ?? original,
        reply,
        original.result_id,
      );
      await c.query(
        'INSERT INTO tender_app.intake_observation_decision(id,tender_id,observation_id,result_id,receipt_id,revision,action,review_decision_id,actor_id,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          randomUUID(),
          tender,
          observation,
          original.result_id,
          receipt,
          reply.revision,
          'reject',
          decision,
          actor,
          input.note,
        ],
      );
      return reply;
    });
  }
  async classification(
    actor: string,
    tender: string,
    receipt: string,
    key: string,
    input: ReviewClassificationDto,
  ) {
    return transaction(this.pool, async (c) => {
      await this.lock(c, actor, tender);
      const op = await operationReplay(c, tender, key, { kind: 'classification', receipt, input });
      if (op.reply) return op.reply;
      const head = (
        await c.query(
          'SELECT h.*,r.type FROM tender_app.intake_classification_head h JOIN tender_app.intake_classification_revision r ON r.id=h.current_revision_id WHERE h.tender_id=$1 AND h.receipt_id=$2 FOR UPDATE OF h',
          [tender, receipt],
        )
      ).rows[0];
      if (!head) throw new NotFoundException();
      if (head.state_revision !== input.expectedRevision)
        throw new ConflictException('stale_classification_revision');
      await acknowledgeImpact(c, tender, receipt, input.impactPreviewHash, input.acknowledgeImpact);
      if (input.action === 'change' && !input.type) throw new BadRequestException();
      const source = await receiptResult(c, tender, receipt),
        type = input.action === 'reject' ? 'unknown' : (input.type ?? head.type),
        id = randomUUID(),
        revision = head.state_revision + 1;
      await c.query(
        "INSERT INTO tender_app.intake_classification_revision(id,tender_id,receipt_id,revision,type,review_state,source,result_id,reason,supersedes_id,created_by) VALUES($1,$2,$3,$4,$5,$6,'human',$7,$8,$9,$10)",
        [
          id,
          tender,
          receipt,
          revision,
          type,
          input.action === 'reject' ? 'rejected' : 'confirmed',
          source.result_id,
          input.note,
          head.current_revision_id,
          actor,
        ],
      );
      await c.query(
        'UPDATE tender_app.intake_classification_head SET current_revision_id=$2,approved_revision_id=$2,state_revision=$3 WHERE receipt_id=$1',
        [receipt, id, revision],
      );
      const projection = await projectReceipt(c, tender, receipt, id),
        reply = {
          receiptId: receipt,
          type,
          revision,
          revisionId: id,
          legacyDocumentId: projection?.legacy_document_id ?? null,
          legacyReceiptId: projection?.legacy_receipt_id ?? null,
        };
      await humanDecision(
        c,
        actor,
        tender,
        key,
        op.hash,
        'receipt',
        receipt,
        input.expectedRevision,
        'classification',
        input.note,
        head,
        reply,
      );
      return reply;
    });
  }
  private async associationRevision(
    c: PoolClient,
    actor: string,
    head: Row,
    state: string,
    note: string,
    company = head.company_id,
    target = head.target_receipt_id,
  ) {
    const key = head.association_type + ':' + (company ?? target),
      existing = (
        await c.query(
          'SELECT * FROM tender_app.intake_association_head WHERE tender_id=$1 AND receipt_id=$2 AND association_key=$3 FOR UPDATE',
          [head.tender_id, head.receipt_id, key],
        )
      ).rows[0];
    const id = randomUUID(),
      revision = (existing?.state_revision ?? 0) + 1;
    await c.query(
      'INSERT INTO tender_app.intake_association_revision(id,tender_id,receipt_id,company_id,target_receipt_id,association_key,observation_id,revision,association_type,state,evidence_ids,reason,rules_version,supersedes_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [
        id,
        head.tender_id,
        head.receipt_id,
        company,
        target,
        key,
        head.observation_id,
        revision,
        head.association_type,
        state,
        head.evidence_ids,
        note,
        'intake-human-review-v1',
        existing?.current_revision_id ?? null,
        actor,
      ],
    );
    if (existing)
      await c.query(
        'UPDATE tender_app.intake_association_head SET current_revision_id=$3,approved_revision_id=$4,state_revision=$5 WHERE receipt_id=$1 AND association_key=$2',
        [head.receipt_id, key, id, state === 'confirmed' ? id : null, revision],
      );
    else
      await c.query(
        'INSERT INTO tender_app.intake_association_head(tender_id,receipt_id,company_id,target_receipt_id,association_key,association_type,current_revision_id,approved_revision_id,state_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)',
        [
          head.tender_id,
          head.receipt_id,
          company,
          target,
          key,
          head.association_type,
          id,
          state === 'confirmed' ? id : null,
        ],
      );
    return { associationId: id, revision, associationKey: key, state };
  }
  async association(
    actor: string,
    tender: string,
    receipt: string,
    association: string,
    key: string,
    input: AssociationDecisionDto,
  ) {
    return transaction(this.pool, async (c) => {
      await this.lock(c, actor, tender);
      const op = await operationReplay(c, tender, key, { kind: 'association', receipt, association, input });
      if (op.reply) return op.reply;
      const head = (
        await c.query(
          'SELECT h.*,a.observation_id,a.evidence_ids,a.id AS revision_id FROM tender_app.intake_association_head h JOIN tender_app.intake_association_revision a ON a.id=h.current_revision_id WHERE h.tender_id=$1 AND h.receipt_id=$2 AND a.id=$3 FOR UPDATE OF h',
          [tender, receipt, association],
        )
      ).rows[0];
      if (!head) throw new NotFoundException();
      if (head.state_revision !== input.expectedRevision)
        throw new ConflictException('stale_association_revision');
      if (input.companyId) await assertReference(c, 'intake_company', tender, input.companyId);
      if (input.targetReceiptId) await assertReference(c, 'intake_receipt', tender, input.targetReceiptId);
      await acknowledgeImpact(c, tender, receipt, input.impactPreviewHash, input.acknowledgeImpact);
      const company = input.companyId ?? head.company_id,
        target = input.targetReceiptId ?? head.target_receipt_id;
      if (
        (head.company_id === null) != (company === null) ||
        (company && input.targetReceiptId) ||
        (target && input.companyId)
      )
        throw new BadRequestException('association_target_kind_mismatch');
      if (input.action === 'confirm' || input.action === 'change') {
        if (
          head.observation_id &&
          (
            await c.query(
              "SELECT 1 FROM tender_app.intake_observation_decision WHERE observation_id=$1 AND tender_id=$2 AND action='reject'",
              [head.observation_id, tender],
            )
          ).rowCount
        )
          throw new ConflictException('observation_rejected');
        const cl = (
          await c.query(
            'SELECT r.* FROM tender_app.intake_classification_head h JOIN tender_app.intake_classification_revision r ON r.id=h.current_revision_id WHERE h.tender_id=$1 AND h.receipt_id=$2',
            [tender, receipt],
          )
        ).rows[0];
        if (!cl || cl.review_state !== 'confirmed')
          throw new ConflictException('classification_not_confirmed');
        if (company) {
          const co = await this.companyHead(c, tender, company);
          if (!co.confirmed_supplier_id || co.review_state !== 'confirmed')
            throw new ConflictException('company_not_confirmed');
          if (
            head.association_type === 'supplier_of' &&
            !['offer', 'supporting', 'quality_certificate'].includes(cl.type)
          )
            throw new ConflictException('classification_does_not_allow_supplier');
          const other = (
            await c.query(
              "SELECT h.*,a.observation_id,a.evidence_ids FROM tender_app.intake_association_head h JOIN tender_app.intake_association_revision a ON a.id=h.current_revision_id WHERE h.receipt_id=$1 AND h.association_type='supplier_of' AND h.approved_revision_id IS NOT NULL AND h.association_key<>$2 FOR UPDATE OF h",
              [receipt, head.association_type + ':' + company],
            )
          ).rows[0];
          if (head.association_type === 'supplier_of' && other) {
            if (input.action !== 'change')
              throw new ConflictException('supplier_association_already_confirmed');
            await this.associationRevision(c, actor, other, 'revoked', input.note);
          }
        } else if (target === receipt) throw new BadRequestException('self_association');
        if (
          head.association_type === 'relates_to_specification' &&
          !(
            await c.query(
              "SELECT 1 FROM tender_app.intake_classification_head h JOIN tender_app.intake_classification_revision r ON r.id=h.current_revision_id WHERE h.receipt_id=$1 AND h.tender_id=$2 AND r.type='specification' AND r.review_state='confirmed'",
              [target, tender],
            )
          ).rowCount
        )
          throw new ConflictException('target_specification_not_confirmed');
      }
      if (input.action === 'change' && (company !== head.company_id || target !== head.target_receipt_id))
        await this.associationRevision(c, actor, head, 'revoked', input.note);
      const reply = await this.associationRevision(
        c,
        actor,
        head,
        input.action === 'reject' ? 'rejected' : input.action === 'defer' ? 'deferred' : 'confirmed',
        input.note,
        company,
        target,
      );
      const projection = (
        await c.query(
          "SELECT legacy_document_id FROM tender_app.intake_receipt_projection WHERE tender_id=$1 AND receipt_id=$2 AND purpose='offer'",
          [tender, receipt],
        )
      ).rows[0];
      if (projection)
        await c.query(
          "INSERT INTO tender_app.field_decision(id,document_id,field_key,value,source_type,source_note,decided_by) VALUES($1,$2,'intake.association.v1',$3,'other',$4,$5)",
          [
            randomUUID(),
            projection.legacy_document_id,
            JSON.stringify({ intakeReceiptId: receipt, ...reply }),
            input.note,
            actor,
          ],
        );
      await humanDecision(
        c,
        actor,
        tender,
        key,
        op.hash,
        'receipt',
        receipt,
        input.expectedRevision,
        'association',
        input.note,
        head,
        reply,
      );
      return reply;
    });
  }
  async transfer(actor: string, tender: string, receipt: string, key: string, input: TransferDraftDto) {
    return transaction(this.pool, async (c) => {
      await this.lock(c, actor, tender);
      const op = await operationReplay(c, tender, key, { kind: 'transfer', receipt, input });
      if (op.reply) return op.reply;
      const context = await confirmedContext(c, tender, receipt);
      if (context.contextToken !== input.contextToken) throw new ConflictException('stale_intake_context');
      const latest = (
        await c.query(
          'SELECT * FROM tender_app.intake_commercial_draft WHERE tender_id=$1 AND receipt_id=$2 ORDER BY revision DESC LIMIT 1',
          [tender, receipt],
        )
      ).rows[0];
      if ((latest?.revision ?? 0) !== input.expectedRevision)
        throw new ConflictException('stale_draft_revision');
      await assertReference(c, 'lot', tender, input.lotId);
      if (new Set(input.items.map((i) => i.lotItemId)).size !== input.items.length)
        throw new BadRequestException('duplicate_lot_mapping');
      for (const item of input.items)
        if (
          !(
            await c.query('SELECT 1 FROM tender_app.lot_item WHERE id=$1 AND lot_id=$2', [
              item.lotItemId,
              input.lotId,
            ])
          ).rowCount
        )
          throw new NotFoundException();
      const extracted =
        (
          await c.query(
            'SELECT output FROM tender_app.intake_commercial_result WHERE result_id=$1 AND tender_id=$2 AND receipt_id=$3',
            [context.resultId, tender, receipt],
          )
        ).rows[0]?.output ?? {};
      const fields: Record<string, unknown> = { ...input.form };
      const sources: Record<string, string> = {};
      for (const field of input.selectedFields) {
        if (
          (fields[field] === null || fields[field] === undefined || fields[field] === 'unknown') &&
          extracted[field]
        ) {
          fields[field] = extracted[field].value;
          sources['fields.' + field] = extracted[field].evidenceId;
        }
      }
      const id = randomUUID(),
        revision = input.expectedRevision + 1,
        form = { fields, items: input.items, lotId: input.lotId };
      await c.query(
        'INSERT INTO tender_app.intake_commercial_draft(id,tender_id,receipt_id,result_id,revision,context_token,form,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, tender, receipt, context.resultId, revision, context.contextToken, JSON.stringify(form), actor],
      );
      const values: Record<string, unknown> = Object.fromEntries(
        Object.entries(fields).map(([k, v]) => ['fields.' + k, v]),
      );
      for (const item of input.items)
        for (const [k, v] of Object.entries(item))
          if (k !== 'lotItemId') values['items.' + item.lotItemId + '.' + k] = v;
      for (const [path, value] of Object.entries(values)) {
        const hash = valueHash(value),
          evidence = sources[path] ?? null,
          manual = evidence ? null : randomUUID();
        if (manual)
          await c.query(
            'INSERT INTO tender_app.intake_manual_source(id,tender_id,receipt_id,result_id,field_path,value,value_hash,note,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [manual, tender, receipt, context.resultId, path, JSON.stringify(value), hash, input.note, actor],
          );
        await c.query(
          'INSERT INTO tender_app.intake_draft_field(id,tender_id,receipt_id,result_id,draft_id,field_path,value_hash,evidence_id,manual_decision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [randomUUID(), tender, receipt, context.resultId, id, path, hash, evidence, manual],
        );
      }
      const reply = {
        draftId: id,
        revision,
        form,
        intakeContext: {
          receiptId: context.receiptId,
          resultId: context.resultId,
          companyRevisionId: context.companyRevisionId,
          classificationRevisionId: context.classificationRevisionId,
          associationRevisionId: context.associationRevisionId,
          contextToken: context.contextToken,
          draftId: id,
          operationKey: randomUUID(),
        },
      };
      await humanDecision(
        c,
        actor,
        tender,
        key,
        op.hash,
        'receipt',
        receipt,
        input.expectedRevision,
        'transfer',
        input.note,
        latest ?? {},
        reply,
      );
      return reply;
    });
  }
}
