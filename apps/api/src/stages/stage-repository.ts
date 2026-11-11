import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { StoredBlob } from '../storage/file-store';
import { Pool, PoolClient } from 'pg';
import { PgScopeRepository } from '../data/scope-repository';
import { transaction } from '../data/repository';
import { PgVerificationRepository } from '../comparison/verification-repository';
import { calculate } from '../comparison/calculation';
import { BaselineDto, AccreditationDto, ContactDto, DraftDto, ResponseDto, StageDto } from './stage.dto';
export class PgStageRepository extends PgScopeRepository {
  constructor(pool: Pool) {
    super(pool);
  }
  private async event(
    c: PoolClient,
    actor: string,
    id: string,
    revision: number,
    action: string,
    entity: string,
    entityId: string,
  ) {
    await c.query('UPDATE tender_app.tender SET revision=revision+1,updated_at=now() WHERE id=$1', [id]);
    await c.query(
      'INSERT INTO tender_app.audit_event(id,actor_id,tender_id,action,entity_revision,entity,entity_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), actor, id, action, revision + 1, entity, entityId],
    );
  }
  private async supplier(c: PoolClient, id: string, supplier: string) {
    if (
      !(
        await c.query('SELECT 1 FROM tender_app.tender_supplier WHERE tender_id=$1 AND supplier_id=$2', [
          id,
          supplier,
        ])
      ).rowCount
    )
      throw new BadRequestException();
  }
  private async stage(c: PoolClient, id: string, stage: string) {
    const row = (
      await c.query('SELECT id,ordinal FROM tender_app.tender_stage WHERE tender_id=$1 AND id=$2', [
        id,
        stage,
      ])
    ).rows[0];
    if (!row) throw new NotFoundException();
    return row as { id: string; ordinal: number };
  }
  async context(actor: string, id: string) {
    const scope = await this.read(actor, id);
    const stages = (
      await this.pool.query(
        'SELECT id,kind,ordinal,label,comment,opened_at AS "createdAt",created_by AS "actorId" FROM tender_app.tender_stage WHERE tender_id=$1 ORDER BY ordinal',
        [id],
      )
    ).rows;
    const responses = (
      await this.pool.query(
        `SELECT r.id,r.stage_id AS "stageId",r.offer_id AS "offerId",o.supplier_id AS "supplierId",r.response_status AS status,r.offer_version_id AS "versionId",r.created_by AS "actorId",(SELECT fd.source_note FROM tender_app.field_decision fd WHERE fd.field_key='stage.response.v1' AND (CASE WHEN fd.field_key='stage.response.v1' THEN fd.value::jsonb END)->>'responseId'=r.id::text LIMIT 1) AS note,r.created_at AS "createdAt" FROM tender_app.stage_response r JOIN tender_app.offer o ON o.id=r.offer_id WHERE r.tender_id=$1 ORDER BY r.created_at,r.id`,
        [id],
      )
    ).rows;
    const contacts = (
      await this.pool.query(
        'SELECT id,supplier_id AS "supplierId",email,verified,source_document_id AS "documentId" FROM tender_app.contact WHERE tender_id=$1 ORDER BY email,id',
        [id],
      )
    ).rows;
    // Each edit creates a new immutable draft row. The previous draft remains visible in history.
    const drafts = (
      await this.pool.query(
        `SELECT d.id,d.stage_id AS "stageId",d.supplier_id AS "supplierId",d.to_addresses AS recipients,d.subject,d.body,EXISTS(SELECT 1 FROM tender_app.audit_event sup WHERE sup.tender_id=d.tender_id AND sup.action='draft.superseded.'||d.id::text) AS superseded,a.created_at AS "createdAt",d.created_by AS "actorId",a.entity_revision AS revision FROM tender_app.draft_message d JOIN tender_app.audit_event a ON a.entity_id=d.id AND a.entity='draft_message' AND a.action='draft.saved' WHERE d.tender_id=$1 ORDER BY a.created_at DESC,a.id`,
        [id],
      )
    ).rows;
    const reports = (
      await this.pool.query(
        'SELECT a.id,a.supplier_id AS "supplierId",a.document_id AS "documentId",d.original_name AS name,d.blob_sha256 AS sha256,a.assessed_at AS "assessedAt",a.status,a.source,a.note,a.created_by AS "actorId",a.created_at AS "createdAt" FROM tender_app.accreditation_report a JOIN tender_app.document d ON d.id=a.document_id AND d.tender_id=a.tender_id WHERE a.tender_id=$1 ORDER BY a.assessed_at DESC,a.created_at DESC,a.id',
        [id],
      )
    ).rows;
    const audit = (
      await this.pool.query(
        `SELECT id,action,entity,entity_id AS "entityId",actor_id AS "actorId",created_at AS at,entity_revision AS revision FROM tender_app.audit_event WHERE tender_id=$1 AND (action LIKE 'stage.%' OR action LIKE 'draft.%' OR action LIKE 'accreditation.%' OR action='contact.confirmed') ORDER BY created_at DESC,id LIMIT 500`,
        [id],
      )
    ).rows;
    const baselines = (
      await this.pool.query(
        `SELECT fd.value::jsonb AS value,fd.source_note AS note,fd.decided_by AS "actorId",fd.decided_at AS at FROM tender_app.field_decision fd JOIN tender_app.document d ON d.id=fd.document_id WHERE d.tender_id=$1 AND fd.field_key='stage.baseline.v1'`,
        [id],
      )
    ).rows;
    return { scope, stages, responses, contacts, drafts, reports, audit, baselines };
  }
  async create(actor: string, id: string, input: StageDto) {
    return transaction(this.pool, async (c) => {
      const t = await this.lock(c, actor, id, input.expectedRevision);
      if (input.kind === 'round' && !input.comment.trim())
        throw new BadRequestException('Round comment required');
      const ordinal = Number(
        (
          await c.query(
            'SELECT COALESCE(max(ordinal),0)+1 AS n FROM tender_app.tender_stage WHERE tender_id=$1',
            [id],
          )
        ).rows[0].n,
      );
      const stageId = randomUUID();
      // Snapshot the baseline once, before the first commercial stage. Later technical edits cannot rewrite it.
      if (ordinal === 1) {
        const context = await new PgVerificationRepository(this.pool).context(actor, id);
        for (const offer of context.offers) {
          const baseline = offer.versions
            .filter(
              (v) =>
                v.metadata &&
                !v.stageId &&
                calculate(v.metadata, context.lotItems[offer.lotId] ?? [], 'lot').rankable,
            )
            .at(-1);
          if (!baseline?.metadata) continue;
          await c.query(
            `INSERT INTO tender_app.field_decision(id,document_id,field_key,value,source_type,source_note,decided_by) VALUES($1,$2,'stage.baseline.v1',$3,'other','Baseline at first commercial stage',$4)`,
            [
              randomUUID(),
              baseline.metadata.documentId,
              JSON.stringify({ tenderId: id, offerId: offer.id, versionId: baseline.id, stageId }),
              actor,
            ],
          );
        }
      }
      await c.query(
        'INSERT INTO tender_app.tender_stage(id,tender_id,kind,ordinal,label,comment,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [stageId, id, input.kind, ordinal, input.label.trim(), input.comment.trim(), actor],
      );
      await this.event(c, actor, id, t.revision, 'stage.created', 'tender_stage', stageId);
      return { id: stageId, ordinal, revision: t.revision + 1 };
    });
  }
  async baseline(actor: string, id: string, input: BaselineDto) {
    return transaction(this.pool, async (c) => {
      const t = await this.lock(c, actor, id, input.expectedRevision);
      const first = (
        await c.query(
          'SELECT id FROM tender_app.tender_stage WHERE tender_id=$1 ORDER BY ordinal DESC LIMIT 1',
          [id],
        )
      ).rows[0];
      if (!first) throw new BadRequestException('Create a commercial stage first');
      const exists = (
        await c.query(
          `SELECT 1 FROM tender_app.field_decision fd JOIN tender_app.document d ON d.id=fd.document_id WHERE d.tender_id=$1 AND fd.field_key='stage.baseline.v1' AND (CASE WHEN fd.field_key='stage.baseline.v1' THEN fd.value::jsonb END)->>'offerId'=$2`,
          [id, input.offerId],
        )
      ).rowCount;
      if (
        exists ||
        (
          await c.query('SELECT 1 FROM tender_app.stage_response WHERE tender_id=$1 AND offer_id=$2', [
            id,
            input.offerId,
          ])
        ).rowCount
      )
        throw new ConflictException('Baseline or response already fixed');
      const context = await new PgVerificationRepository(this.pool).context(actor, id);
      const offer = context.offers.find((o) => o.id === input.offerId),
        version = offer?.versions.find((v) => v.id === input.versionId);
      if (
        !offer ||
        !version?.metadata ||
        version.stageId ||
        !calculate(version.metadata, context.lotItems[offer.lotId] ?? [], 'lot').rankable
      )
        throw new BadRequestException('Confirmed stage-less own offer version required');
      await c.query(
        `INSERT INTO tender_app.field_decision(id,document_id,field_key,value,source_type,source_note,decided_by) VALUES($1,$2,'stage.baseline.v1',$3,'other',$4,$5)`,
        [
          randomUUID(),
          version.metadata.documentId,
          JSON.stringify({ tenderId: id, offerId: offer.id, versionId: version.id, stageId: first.id }),
          input.note.trim(),
          actor,
        ],
      );
      await this.event(c, actor, id, t.revision, 'stage.baseline.fixed', 'offer_version', version.id);
      return { versionId: version.id, revision: t.revision + 1 };
    });
  }
  async respond(actor: string, id: string, stageId: string, input: ResponseDto) {
    return transaction(this.pool, async (c) => {
      const t = await this.lock(c, actor, id, input.expectedRevision),
        stage = await this.stage(c, id, stageId);
      const offer = (
        await c.query('SELECT id,lot_id FROM tender_app.offer WHERE id=$1 AND tender_id=$2', [
          input.offerId,
          id,
        ])
      ).rows[0];
      if (!offer) throw new BadRequestException();
      if (
        (
          await c.query(
            'SELECT 1 FROM tender_app.stage_response r JOIN tender_app.tender_stage s ON s.id=r.stage_id WHERE r.offer_id=$1 AND s.ordinal >= $2',
            [input.offerId, stage.ordinal],
          )
        ).rowCount
      )
        throw new ConflictException('Response already fixed, or later response exists');
      if (input.status === 'received') {
        if (!input.versionId) throw new BadRequestException();
        const valid = (
          await c.query(
            'SELECT 1 FROM tender_app.offer_version WHERE id=$1 AND offer_id=$2 AND stage_id=$3 AND tender_id=$4 AND NOT is_initial',
            [input.versionId, input.offerId, stageId, id],
          )
        ).rowCount;
        if (!valid) throw new BadRequestException('Version must belong to this stage and supplier offer');
        const context = await new PgVerificationRepository(this.pool).context(actor, id);
        const version = context.offers
          .find((o) => o.id === input.offerId)
          ?.versions.find((v) => v.id === input.versionId);
        if (
          !version?.metadata ||
          !calculate(version.metadata, context.lotItems[offer.lot_id] ?? [], 'lot').rankable
        )
          throw new BadRequestException('Confirmed complete version required');
      } else if (input.versionId !== undefined) throw new BadRequestException();
      const responseId = randomUUID();
      await c.query(
        'INSERT INTO tender_app.stage_response(id,stage_id,offer_id,tender_id,response_status,offer_version_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [responseId, stageId, input.offerId, id, input.status, input.versionId ?? null, actor],
      );
      const document = (
        await c.query(
          'SELECT source_document_id FROM tender_app.offer_version WHERE offer_id=$1 ORDER BY version LIMIT 1',
          [input.offerId],
        )
      ).rows[0];
      if (document?.source_document_id)
        await c.query(
          `INSERT INTO tender_app.field_decision(id,document_id,field_key,value,source_type,source_note,decided_by) VALUES($1,$2,'stage.response.v1',$3,'other',$4,$5)`,
          [
            randomUUID(),
            document.source_document_id,
            JSON.stringify({
              responseId,
              stageId,
              offerId: input.offerId,
              status: input.status,
              versionId: input.versionId ?? null,
            }),
            input.note.trim(),
            actor,
          ],
        );
      await this.event(c, actor, id, t.revision, 'stage.response.fixed', 'stage_response', responseId);
      return { id: responseId, revision: t.revision + 1 };
    });
  }
  async confirmContact(actor: string, id: string, input: ContactDto) {
    return transaction(this.pool, async (c) => {
      const t = await this.lock(c, actor, id, input.expectedRevision);
      await this.supplier(c, id, input.supplierId);
      if (
        !(
          await c.query('SELECT 1 FROM tender_app.document WHERE id=$1 AND tender_id=$2', [
            input.documentId,
            id,
          ])
        ).rowCount
      )
        throw new BadRequestException();
      const contactId = randomUUID();
      await c.query(
        'INSERT INTO tender_app.contact(id,tender_id,supplier_id,email,source_document_id,verified) VALUES($1,$2,$3,$4,$5,true)',
        [contactId, id, input.supplierId, input.email.trim().toLowerCase(), input.documentId],
      );
      await c.query(
        `INSERT INTO tender_app.field_decision(id,document_id,field_key,value,source_type,source_note,decided_by) VALUES($1,$2,'contact.confirmed.v1',$3,'other',$4,$5)`,
        [
          randomUUID(),
          input.documentId,
          JSON.stringify({
            contactId,
            supplierId: input.supplierId,
            email: input.email.trim().toLowerCase(),
          }),
          input.note.trim(),
          actor,
        ],
      );
      await this.event(c, actor, id, t.revision, 'contact.confirmed', 'contact', contactId);
      return { id: contactId, revision: t.revision + 1 };
    });
  }
  async draft(actor: string, id: string, stageId: string, input: DraftDto) {
    return transaction(this.pool, async (c) => {
      const t = await this.lock(c, actor, id, input.expectedRevision);
      await this.stage(c, id, stageId);
      await this.supplier(c, id, input.supplierId);
      if (new Set(input.contactIds).size !== input.contactIds.length) throw new BadRequestException();
      const contacts = (
        await c.query(
          'SELECT id,email FROM tender_app.contact WHERE tender_id=$1 AND supplier_id=$2 AND verified AND source_document_id IS NOT NULL AND id=ANY($3::uuid[])',
          [id, input.supplierId, input.contactIds],
        )
      ).rows;
      if (contacts.length !== input.contactIds.length)
        throw new BadRequestException('Only confirmed supplier contacts allowed');
      if (input.previousId) {
        const previous = (
          await c.query(
            'SELECT id FROM tender_app.draft_message WHERE id=$1 AND tender_id=$2 AND stage_id=$3 AND supplier_id=$4',
            [input.previousId, id, stageId, input.supplierId],
          )
        ).rows[0];
        if (!previous) throw new BadRequestException();
        if (
          (
            await c.query('SELECT 1 FROM tender_app.audit_event WHERE tender_id=$1 AND action=$2', [
              id,
              'draft.superseded.' + input.previousId,
            ])
          ).rowCount
        )
          throw new ConflictException();
      }
      const draftId = randomUUID();
      await c.query(
        "INSERT INTO tender_app.draft_message(id,tender_id,stage_id,supplier_id,to_addresses,subject,body,approval_status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8)",
        [
          draftId,
          id,
          stageId,
          input.supplierId,
          contacts.map((v) => v.email),
          input.subject.trim(),
          input.body,
          actor,
        ],
      );
      if (input.previousId)
        await this.audit(c, actor, id, 'draft.superseded.' + input.previousId, t.revision + 1);
      for (const contact of contacts)
        await c.query(
          `INSERT INTO tender_app.audit_event(id,actor_id,tender_id,action,entity_revision,entity,entity_id) VALUES($1,$2,$3,$4,$5,'draft_message',$6)`,
          [randomUUID(), actor, id, 'draft.recipient.' + contact.id, t.revision + 1, draftId],
        );
      if (input.previousId)
        await c.query(
          `INSERT INTO tender_app.audit_event(id,actor_id,tender_id,action,entity_revision,entity,entity_id) VALUES($1,$2,$3,$4,$5,'draft_message',$6)`,
          [randomUUID(), actor, id, 'draft.parent.' + input.previousId, t.revision + 1, draftId],
        );
      await this.event(c, actor, id, t.revision, 'draft.saved', 'draft_message', draftId);
      return { id: draftId, recipients: contacts.map((v) => v.email), revision: t.revision + 1 };
    });
  }
  async upload(actor: string, id: string, key: string, blob: StoredBlob, name: string, mime: string) {
    return transaction(this.pool, async (c) => {
      const t = await this.lock(c, actor, id);
      const hash = createHash('sha256')
        .update(JSON.stringify({ sha: blob.sha256, name, mime }))
        .digest('hex');
      const replay = (
        await c.query(
          "SELECT document_id,action FROM tender_app.audit_event WHERE tender_id=$1 AND entity='accreditation_upload' AND entity_id=$2",
          [id, key],
        )
      ).rows[0];
      if (replay) {
        if (replay.action !== 'accreditation.upload.' + hash) throw new ConflictException();
        return { id: replay.document_id };
      }
      await c.query(
        'INSERT INTO tender_app.blob(sha256,storage_key,byte_size) VALUES($1,$2,$3) ON CONFLICT(sha256) DO NOTHING',
        [blob.sha256, blob.key, blob.bytes],
      );
      let documentId = (
        await c.query(
          "SELECT id FROM tender_app.document WHERE tender_id=$1 AND blob_sha256=$2 AND purpose='offer'",
          [id, blob.sha256],
        )
      ).rows[0]?.id;
      if (!documentId) {
        documentId = randomUUID();
        const packageId = randomUUID();
        await c.query('INSERT INTO tender_app.offer_package(id,tender_id) VALUES($1,$2)', [packageId, id]);
        await c.query(
          "INSERT INTO tender_app.document(id,tender_id,offer_package_id,purpose,original_name,mime_type,blob_sha256,status,uploaded_by,association_reason) VALUES($1,$2,$3,'offer',$4,$5,$6,'uploaded',$7,'accreditation-upload')",
          [documentId, id, packageId, name, mime, blob.sha256, actor],
        );
        await c.query(
          `INSERT INTO tender_app.field_decision(id,document_id,field_key,value,source_type,source_note,decided_by) VALUES($1,$2,'accreditation.file.v1',$3,'document','Original uploaded through the accreditation resource',$4)`,
          [randomUUID(), documentId, JSON.stringify({ role: 'accreditation', tenderId: id }), actor],
        );
      }
      await c.query(
        "INSERT INTO tender_app.audit_event(id,actor_id,tender_id,document_id,action,entity_revision,entity,entity_id) VALUES($1,$2,$3,$4,$5,$6,'accreditation_upload',$7)",
        [randomUUID(), actor, id, documentId, 'accreditation.upload.' + hash, t.revision, key],
      );
      return { id: documentId };
    });
  }
  async accreditation(actor: string, id: string, input: AccreditationDto) {
    return transaction(this.pool, async (c) => {
      const t = await this.lock(c, actor, id, input.expectedRevision);
      await this.supplier(c, id, input.supplierId);
      if (
        !(
          await c.query('SELECT 1 FROM tender_app.document WHERE id=$1 AND tender_id=$2', [
            input.documentId,
            id,
          ])
        ).rowCount
      )
        throw new BadRequestException();
      const reportId = randomUUID();
      await c.query(
        'INSERT INTO tender_app.accreditation_report(id,tender_id,supplier_id,document_id,assessed_at,status,source,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          reportId,
          id,
          input.supplierId,
          input.documentId,
          input.assessedAt,
          input.status,
          input.source.trim(),
          input.note.trim(),
          actor,
        ],
      );
      await this.event(c, actor, id, t.revision, 'accreditation.recorded', 'accreditation_report', reportId);
      return { id: reportId, revision: t.revision + 1 };
    });
  }
}
