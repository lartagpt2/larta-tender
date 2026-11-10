import { NewSupplierDto } from '../offer.dto';
import { Pool } from 'pg';
import { DocumentProcessingPort } from '../offer-files';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { FileStore } from '../storage/file-store';
import { FileRejected, IncomingOfferFile, inspectOffer, WaitingDocumentProcessor } from '../offer-files';
import { transaction } from './repository';
import { PgScopeRepository } from './scope-repository';
export interface OfferDocument {
  id: string;
  name: string;
  status: string;
  supplierId: string | null;
  supplierName: string | null;
  email: string | null;
  associationStatus: string;
  revision: number;
  parentId: string | null;
  stage: string | null;
  receipts: {
    id: string;
    batchId: string;
    receivedAt: string;
    actorId: string;
    actorName: string;
    source: string;
    stage: string | null;
    supplierId: string | null;
    supplierName: string | null;
    senderEmail: string | null;
    originalName: string;
    legacy: boolean;
  }[];
}
export class PgOfferRepository extends PgScopeRepository {
  constructor(
    pool: Pool,
    private readonly processor: DocumentProcessingPort = new WaitingDocumentProcessor(),
  ) {
    super(pool);
  }
  async rejectBatch(actor: string, id: string, code: string) {
    await transaction(this.pool, async (c) => {
      const t = await this.lock(c, actor, id);
      await this.audit(c, actor, id, 'offer.batch.rejected.' + code, t.revision);
    });
  }
  async list(actor: string, id: string): Promise<OfferDocument[]> {
    await this.read(actor, id);
    return (
      await this.pool.query<OfferDocument>(
        `SELECT d.id,d.original_name AS name,d.status,d.supplier_id AS "supplierId",s.legal_name AS "supplierName",d.sender_email AS email,d.association_status AS "associationStatus",d.revision,d.parent_document_id AS "parentId",st.label AS stage,COALESCE((SELECT json_agg(json_build_object('id',fd.id,'batchId',fd.value::jsonb->>'batchId','receivedAt',fd.decided_at,'actorId',fd.decided_by,'actorName',u.display_name,'source',fd.value::jsonb->>'source','stage',rs.label,'supplierId',fd.value::jsonb->>'supplierId','supplierName',ss.legal_name,'senderEmail',fd.value::jsonb->>'senderEmail','originalName',fd.value::jsonb->>'originalName','legacy',COALESCE((fd.value::jsonb->>'legacy')::boolean,false)) ORDER BY fd.decided_at,fd.id) FROM tender_app.field_decision fd JOIN tender_app.app_user u ON u.id=fd.decided_by LEFT JOIN tender_app.tender_stage rs ON rs.id::text=fd.value::jsonb->>'stageId' AND rs.tender_id=d.tender_id LEFT JOIN tender_app.supplier ss ON ss.id::text=fd.value::jsonb->>'supplierId' WHERE fd.document_id=d.id AND fd.field_key='offer.received.v1'),json_build_array(json_build_object('id',d.id,'batchId',d.batch_id,'receivedAt',d.received_at,'actorId',d.uploaded_by,'actorName',(SELECT display_name FROM tender_app.app_user WHERE id=d.uploaded_by),'source',d.channel,'stage',st.label,'supplierId',NULL,'supplierName',NULL,'senderEmail',d.sender_email,'originalName',d.original_name,'legacy',true))) AS receipts FROM tender_app.document d LEFT JOIN tender_app.supplier s ON s.id=d.supplier_id LEFT JOIN tender_app.tender_stage st ON st.id=d.stage_id WHERE d.tender_id=$1 AND d.purpose='offer' ORDER BY d.created_at,d.id`,
        [id],
      )
    ).rows;
  }
  async suppliers(actor: string, id: string) {
    await this.read(actor, id);
    return (
      await this.pool.query(
        `SELECT s.id,s.legal_name AS name,s.tax_id AS "registrationNumber",s.email FROM tender_app.tender_supplier ts JOIN tender_app.supplier s ON s.id=ts.supplier_id WHERE ts.tender_id=$1 ORDER BY s.legal_name,s.id`,
        [id],
      )
    ).rows;
  }
  async stages(actor: string, id: string) {
    await this.read(actor, id);
    return (
      await this.pool.query(
        'SELECT id,label FROM tender_app.tender_stage WHERE tender_id=$1 ORDER BY ordinal',
        [id],
      )
    ).rows;
  }
  async originalOffer(actor: string, id: string, doc: string) {
    await this.read(actor, id);
    const r = await this.pool.query(
      `SELECT d.original_name AS name,b.storage_key AS key FROM tender_app.document d JOIN tender_app.blob b ON b.sha256=d.blob_sha256 WHERE d.tender_id=$1 AND d.id=$2 AND d.purpose='offer'`,
      [id, doc],
    );
    if (!r.rows[0]) throw new NotFoundException();
    return r.rows[0] as { name: string; key: string };
  }
  async batch(
    actor: string,
    id: string,
    key: string,
    files: IncomingOfferFile[],
    store: FileStore,
    stageId?: string,
  ) {
    await this.assertWrite(actor, id);
    const manifest = createHash('sha256')
      .update(
        JSON.stringify(
          files.map((f) => ({
            name: f.name,
            mime: f.mime,
            sha: createHash('sha256').update(f.content).digest('hex'),
          })),
        ),
      )
      .digest('hex');
    const requestManifest = stageId
      ? createHash('sha256')
          .update(manifest + ':stage:' + stageId)
          .digest('hex')
      : manifest;
    const prepared = await Promise.all(
      files.map(async (file) => {
        try {
          const parts = inspectOffer({ ...file });
          const blobs = [];
          for (const part of parts) blobs.push(await store.put(part.content));
          return { parts, blobs };
        } catch (e) {
          if (e instanceof FileRejected) return { error: e.code };
          throw e;
        }
      }),
    );
    return transaction(this.pool, async (c) => {
      const tender = await this.lock(c, actor, id);
      const old = await c.query('SELECT tender_id FROM tender_app.upload_batch WHERE id=$1', [key]);
      const action = 'offer.batch.' + requestManifest;
      if (
        stageId &&
        !(await c.query('SELECT 1 FROM tender_app.tender_stage WHERE tender_id=$1 AND id=$2', [id, stageId]))
          .rowCount
      )
        throw new BadRequestException();
      if (old.rowCount) {
        const receipt = await c.query(
          'SELECT 1 FROM tender_app.audit_event WHERE tender_id=$1 AND entity_id=$2 AND action=$3',
          [id, key, action],
        );
        if (old.rows[0].tender_id !== id || !receipt.rowCount) throw new ConflictException();
      } else {
        await c.query(
          'INSERT INTO tender_app.upload_batch(id,tender_id,created_by,stage_id) VALUES($1,$2,$3,$4)',
          [key, id, actor, stageId ?? null],
        );
        await c.query(
          `INSERT INTO tender_app.audit_event(id,actor_id,tender_id,action,entity,entity_id,entity_revision) VALUES($1,$2,$3,$4,'upload_batch',$5,$6)`,
          [randomUUID(), actor, id, action, key, tender.revision],
        );
      }
      const outcomes = [];
      for (const [index, p] of prepared.entries()) {
        if ('error' in p) {
          if (!old.rowCount) await this.audit(c, actor, id, 'offer.rejected.' + p.error, tender.revision);
          outcomes.push({ index, name: files[index].name, status: 'rejected', code: p.error, documents: [] });
          continue;
        }
        const docs: string[] = [];
        for (const [i, f] of p.parts.entries()) {
          const blob = p.blobs[i];
          const existing = await c.query(
            "SELECT id FROM tender_app.document WHERE tender_id=$1 AND blob_sha256=$2 AND purpose='offer'",
            [id, blob.sha256],
          );
          const candidates = f.sender
            ? (
                await c.query(
                  `SELECT DISTINCT s.id FROM tender_app.tender_supplier ts JOIN tender_app.supplier s ON s.id=ts.supplier_id JOIN tender_app.contact ct ON ct.tender_id=ts.tender_id AND ct.supplier_id=s.id WHERE ts.tender_id=$1 AND ct.verified AND lower(ct.email)=$2`,
                  [id, f.sender],
                )
              ).rows
            : [];
          const supplier = candidates.length === 1 ? candidates[0].id : null;

          let doc = existing.rows[0]?.id;
          if (!doc) {
            doc = randomUUID();
            const pkg = randomUUID();
            await c.query('INSERT INTO tender_app.offer_package(id,tender_id) VALUES($1,$2)', [pkg, id]);
            await c.query(
              'INSERT INTO tender_app.blob(sha256,storage_key,byte_size) VALUES($1,$2,$3) ON CONFLICT(sha256) DO NOTHING',
              [blob.sha256, blob.key, blob.bytes],
            );
            const state = this.processor.inspect(f);
            await c.query(
              `INSERT INTO tender_app.document(id,tender_id,purpose,offer_package_id,original_name,mime_type,blob_sha256,uploaded_by,batch_id,parent_document_id,channel,sender_email,supplier_id,association_status,association_reason,status) VALUES($1,$2,'offer',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
              [
                doc,
                id,
                pkg,
                f.name,
                f.mime,
                blob.sha256,
                actor,
                key,
                f.parent !== undefined ? docs[f.parent] : null,
                f.parent !== undefined ? 'email' : 'manual',
                f.sender ?? null,
                supplier,
                supplier ? 'candidate' : 'unresolved',
                supplier ? 'unique_verified_sender_contact' : state.reason,
                state.status,
              ],
            );
            await this.audit(c, actor, id, 'offer.uploaded', tender.revision, doc);
          }
          if (f.parent !== undefined && docs[f.parent] !== doc)
            await c.query(
              `INSERT INTO tender_app.document_relation(from_document_id,to_document_id,tender_id,relation_type) VALUES($1,$2,$3,'attachment') ON CONFLICT DO NOTHING`,
              [docs[f.parent], doc, id],
            );
          if (!old.rowCount) {
            // The original document is deduplicated; every independent intake remains append-only.
            // Before 005B only the first intake was linked to the document. Preserve that known fact.
            const hasReceipts = await c.query(
              "SELECT 1 FROM tender_app.field_decision WHERE document_id=$1 AND field_key='offer.received.v1' LIMIT 1",
              [doc],
            );
            if (existing.rowCount && !hasReceipts.rowCount) {
              const legacy = await c.query(
                'SELECT d.batch_id,d.received_at,d.uploaded_by,d.channel,d.sender_email,d.original_name,b.stage_id FROM tender_app.document d LEFT JOIN tender_app.upload_batch b ON b.id=d.batch_id WHERE d.id=$1',
                [doc],
              );
              const first = legacy.rows[0];
              await c.query(
                `INSERT INTO tender_app.field_decision(id,document_id,field_key,value,source_type,source_note,decided_by,decided_at) VALUES($1,$2,'offer.received.v1',$3,'document','First known intake from immutable original; earlier repeat history unavailable',$4,(SELECT received_at FROM tender_app.document WHERE id=$2))`,
                [
                  randomUUID(),
                  doc,
                  JSON.stringify({
                    batchId: first.batch_id,
                    source: first.channel,
                    stageId: first.stage_id ?? null,
                    supplierId: null,
                    senderEmail: first.sender_email,
                    originalName: first.original_name,
                    legacy: true,
                  }),
                  first.uploaded_by,
                ],
              );
            }
            const current = await c.query(
              'SELECT supplier_id,association_status FROM tender_app.document WHERE id=$1',
              [doc],
            );
            const receiptSupplier =
              f.mime === 'message/rfc822' || f.parent !== undefined
                ? supplier
                : (current.rows[0].supplier_id ?? null);
            await c.query(
              `INSERT INTO tender_app.field_decision(id,document_id,field_key,value,source_type,source_note,decided_by) VALUES($1,$2,'offer.received.v1',$3,'document','Independent offer intake; sender is declared From, not authenticated identity',$4)`,
              [
                randomUUID(),
                doc,
                JSON.stringify({
                  batchId: key,
                  index,
                  part: i,
                  source: f.mime === 'message/rfc822' || f.parent !== undefined ? 'email' : 'manual',
                  stageId: stageId ?? null,
                  supplierId: receiptSupplier,
                  senderEmail: f.sender ?? null,
                  originalName: f.name,
                  parentId: f.parent !== undefined ? docs[f.parent] : null,
                  legacy: false,
                }),
                actor,
              ],
            );
            await this.audit(c, actor, id, 'offer.received', tender.revision, doc);
          }
          docs.push(doc);
        }
        outcomes.push({ index, name: files[index].name, status: 'stored', documents: docs });
      }
      return { batchId: key, outcomes };
    });
  }
  async associate(
    actor: string,
    id: string,
    doc: string,
    revision: number,
    supplierId: string | null | undefined,
    note: string,
    newSupplier?: NewSupplierDto,
  ) {
    return transaction(this.pool, async (c) => {
      const t = await this.lock(c, actor, id);
      const d = await c.query(
        "SELECT revision FROM tender_app.document WHERE id=$1 AND tender_id=$2 AND purpose='offer' FOR UPDATE",
        [doc, id],
      );
      if (!d.rows[0]) throw new NotFoundException();
      if (d.rows[0].revision !== revision) throw new ConflictException();
      if (
        (newSupplier !== undefined && supplierId !== undefined) ||
        (newSupplier === undefined && supplierId === undefined) ||
        newSupplier === null
      )
        throw new BadRequestException();
      if (newSupplier) {
        supplierId = randomUUID();
        await c.query('INSERT INTO tender_app.supplier(id,legal_name,tax_id,email) VALUES($1,$2,$3,$4)', [
          supplierId,
          newSupplier.name,
          newSupplier.registrationNumber ?? null,
          newSupplier.email ?? null,
        ]);
        await c.query(
          "INSERT INTO tender_app.tender_supplier(tender_id,supplier_id,contact_status) VALUES($1,$2,'confirmed')",
          [id, supplierId],
        );
        await c.query(
          `INSERT INTO tender_app.field_decision(id,document_id,field_key,value,source_type,source_note,decided_by) VALUES($1,$2,'supplier.created.v1',$3,'other',$4,$5)`,
          [randomUUID(), doc, JSON.stringify({ supplierId, ...newSupplier }), note, actor],
        );
        if (newSupplier.email)
          await c.query(
            'INSERT INTO tender_app.contact(id,tender_id,supplier_id,email,source_document_id,verified) VALUES($1,$2,$3,$4,$5,false)',
            [randomUUID(), id, supplierId, newSupplier.email, doc],
          );
        await this.audit(c, actor, id, 'supplier.created.manually', t.revision, doc);
      }
      if (
        supplierId &&
        !(
          await c.query('SELECT 1 FROM tender_app.tender_supplier WHERE tender_id=$1 AND supplier_id=$2', [
            id,
            supplierId,
          ])
        ).rowCount
      )
        throw new BadRequestException();
      await c.query(
        `UPDATE tender_app.document SET supplier_id=$3,association_status=$4,association_reason='manual_confirmation',revision=revision+1 WHERE id=$1 AND tender_id=$2`,
        [doc, id, supplierId, supplierId ? 'confirmed' : 'unresolved'],
      );
      await c.query(
        `INSERT INTO tender_app.field_decision(id,document_id,field_key,value,source_type,source_note,decided_by) VALUES($1,$2,'offer.supplier',$3,'other',$4,$5)`,
        [randomUUID(), doc, supplierId, note, actor],
      );
      await this.audit(c, actor, id, 'offer.association.changed', t.revision, doc);
      return { id: doc, revision: revision + 1, supplierId };
    });
  }
}
