import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolClient, QueryResultRow } from 'pg';
export type Client = Pool | PoolClient;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export const valueHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export async function bridgeInstalled(c: Client) {
  return (
    (await c.query("SELECT to_regclass('tender_app.intake_receipt_projection') IS NOT NULL installed"))
      .rows[0]?.installed === true
  );
}
export async function receiptResult(c: Client, tender: string, receipt: string) {
  const row = (
    await c.query(
      'SELECT r.*,p.id AS result_id,p.original_id,p.source_sha FROM tender_app.intake_receipt r JOIN tender_app.intake_result p ON p.receipt_id=r.id AND p.tender_id=r.tender_id JOIN tender_app.intake_processing_run j ON j.id=p.run_id WHERE r.tender_id=$1 AND r.id=$2 ORDER BY j.generation DESC LIMIT 1',
      [tender, receipt],
    )
  ).rows[0];
  if (!row) throw new NotFoundException();
  return row;
}
export async function confirmedContext(c: Client, tender: string, receipt: string) {
  const source = await receiptResult(c, tender, receipt);
  const row = (
    await c.query(
      `SELECT cl.id AS classification_revision_id,cl.type,cl.review_state,co.id AS company_id,co.current_revision_id AS company_revision_id,co.confirmed_supplier_id AS supplier_id,cr.review_state AS company_state,a.id AS association_revision_id,a.state AS association_state,h.current_revision_id AS association_current,h.approved_revision_id AS association_approved,p.legacy_document_id,p.legacy_receipt_id,EXISTS(SELECT 1 FROM tender_app.intake_observation_decision od WHERE od.tender_id=a.tender_id AND od.observation_id=a.observation_id) AS observation_rejected FROM tender_app.intake_classification_head ch JOIN tender_app.intake_classification_revision cl ON cl.id=ch.current_revision_id LEFT JOIN tender_app.intake_association_head h ON h.receipt_id=ch.receipt_id AND h.tender_id=ch.tender_id AND h.association_type='supplier_of' AND h.approved_revision_id IS NOT NULL LEFT JOIN tender_app.intake_association_revision a ON a.id=h.approved_revision_id LEFT JOIN tender_app.intake_company co ON co.id=a.company_id AND co.tender_id=a.tender_id LEFT JOIN tender_app.intake_company_revision cr ON cr.id=co.current_revision_id LEFT JOIN tender_app.intake_receipt_projection p ON p.receipt_id=ch.receipt_id AND p.tender_id=ch.tender_id AND p.purpose='offer' WHERE ch.tender_id=$1 AND ch.receipt_id=$2`,
      [tender, receipt],
    )
  ).rows[0];
  if (
    !row ||
    row.observation_rejected ||
    row.type !== 'offer' ||
    row.review_state !== 'confirmed' ||
    row.company_state !== 'confirmed' ||
    !row.supplier_id ||
    row.association_state !== 'confirmed' ||
    row.association_current !== row.association_approved ||
    !row.legacy_receipt_id
  )
    throw new ConflictException('intake_context_not_confirmed');
  const context = {
    tenderId: tender,
    receiptId: receipt,
    resultId: source.result_id,
    companyId: row.company_id,
    companyRevisionId: row.company_revision_id,
    classificationRevisionId: row.classification_revision_id,
    associationRevisionId: row.association_revision_id,
    supplierId: row.supplier_id,
    documentId: row.legacy_document_id,
    legacyReceiptId: row.legacy_receipt_id,
  };
  return { ...context, contextToken: valueHash(context) };
}
export type ConfirmedContext = Awaited<ReturnType<typeof confirmedContext>>;
export async function projectReceipt(c: PoolClient, tender: string, receipt: string, classification: string) {
  const r = (
    await c.query(
      `SELECT r.*,d.blob_sha256,d.mime_type,b.actor_id AS batch_actor,b.created_at AS batch_created,cr.type,cr.review_state FROM tender_app.intake_receipt r JOIN tender_app.intake_document d ON d.id=r.original_id AND d.tender_id=r.tender_id JOIN tender_app.intake_batch b ON b.id=r.batch_id AND b.tender_id=r.tender_id JOIN tender_app.intake_classification_revision cr ON cr.id=$3 AND cr.receipt_id=r.id AND cr.tender_id=r.tender_id WHERE r.tender_id=$1 AND r.id=$2`,
      [tender, receipt, classification],
    )
  ).rows[0];
  if (!r) throw new NotFoundException();
  if (r.review_state !== 'confirmed' || !['offer', 'specification'].includes(r.type)) return null;
  const prior = (
    await c.query(
      'SELECT * FROM tender_app.intake_receipt_projection WHERE tender_id=$1 AND receipt_id=$2 AND purpose=$3',
      [tender, receipt, r.type],
    )
  ).rows[0];
  if (prior) return prior;
  let projection = (
    await c.query(
      'SELECT * FROM tender_app.intake_legacy_projection WHERE original_id=$1 AND tender_id=$2 AND purpose=$3',
      [r.original_id, tender, r.type],
    )
  ).rows[0];
  if (!projection) {
    let document = (
      await c.query(
        'SELECT * FROM tender_app.document WHERE tender_id=$1 AND blob_sha256=$2 AND purpose=$3',
        [tender, r.blob_sha256, r.type],
      )
    ).rows[0];
    const owned = !document;
    if (!document) {
      await c.query(
        'INSERT INTO tender_app.upload_batch(id,tender_id,stage_id,created_by,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
        [r.batch_id, tender, r.stage_id, r.batch_actor, r.batch_created],
      );
      if (
        !(
          await c.query('SELECT 1 FROM tender_app.upload_batch WHERE id=$1 AND tender_id=$2', [
            r.batch_id,
            tender,
          ])
        ).rowCount
      )
        throw new ConflictException('legacy_batch_conflict');
      const packageId = r.type === 'offer' ? randomUUID() : null;
      if (packageId)
        await c.query('INSERT INTO tender_app.offer_package(id,tender_id) VALUES($1,$2)', [
          packageId,
          tender,
        ]);
      document = (
        await c.query(
          `INSERT INTO tender_app.document(id,tender_id,offer_package_id,purpose,original_name,mime_type,blob_sha256,status,uploaded_by,stage_id,batch_id,channel,sender_email,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,'needs_review',$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            randomUUID(),
            tender,
            packageId,
            r.type,
            r.original_name,
            r.mime_type,
            r.blob_sha256,
            r.received_by,
            r.stage_id,
            r.batch_id,
            r.channel,
            r.declared_sender,
            r.received_at,
          ],
        )
      ).rows[0];
    }
    projection = (
      await c.query(
        'INSERT INTO tender_app.intake_legacy_projection(original_id,tender_id,purpose,legacy_document_id,classification_revision_id,receipt_id,owned_document,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [r.original_id, tender, r.type, document.id, classification, receipt, owned, r.received_by],
      )
    ).rows[0];
  }
  let legacyReceipt: string | null = null;
  if (r.type === 'offer') {
    legacyReceipt = randomUUID();
    await c.query(
      `INSERT INTO tender_app.field_decision(id,document_id,field_key,value,source_type,source_note,decided_by,decided_at) VALUES($1,$2,'offer.received.v1',$3,'document','Actual unified intake receipt projection',$4,$5)`,
      [
        legacyReceipt,
        projection.legacy_document_id,
        JSON.stringify({
          intakeReceiptId: receipt,
          batchId: r.batch_id,
          stageId: r.stage_id,
          source: r.channel,
          senderEmail: r.declared_sender,
          originalName: r.original_name,
          receivedAt: r.received_at,
          actorId: r.received_by,
          supplierId: null,
          legacy: false,
        }),
        r.received_by,
        r.received_at,
      ],
    );
  }
  return (
    await c.query(
      'INSERT INTO tender_app.intake_receipt_projection(receipt_id,tender_id,purpose,original_id,legacy_document_id,legacy_receipt_id,classification_revision_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        receipt,
        tender,
        r.type,
        r.original_id,
        projection.legacy_document_id,
        legacyReceipt,
        classification,
        r.received_by,
      ],
    )
  ).rows[0];
}
export async function operationReplay(c: PoolClient, tender: string, key: string, body: unknown) {
  const hash = valueHash(body),
    prior = (
      await c.query(
        'SELECT * FROM tender_app.intake_review_decision WHERE tender_id=$1 AND operation_key=$2',
        [tender, key],
      )
    ).rows[0];
  if (prior && prior.request_hash !== hash) throw new ConflictException('operation_key_conflict');
  return { hash, reply: prior?.after_state };
}
export async function humanDecision(
  c: PoolClient,
  actor: string,
  tender: string,
  key: string,
  hash: string,
  kind: 'receipt' | 'company',
  subject: string,
  expected: number,
  action: string,
  note: string,
  before: unknown,
  after: unknown,
  organizationResultId?: string,
) {
  const result = (
    await c.query(
      organizationResultId
        ? 'SELECT id FROM tender_app.intake_organization_result WHERE tender_id=$1 AND receipt_id=$2 AND id=$3'
        : kind === 'receipt'
          ? 'SELECT id FROM tender_app.intake_organization_result WHERE tender_id=$1 AND receipt_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1'
          : 'SELECT o.result_id AS id FROM tender_app.intake_company c JOIN tender_app.intake_organization_observation o ON o.id=c.origin_observation_id AND o.tender_id=c.tender_id WHERE c.tender_id=$1 AND c.id=$2',
      organizationResultId ? [tender, subject, organizationResultId] : [tender, subject],
    )
  ).rows[0];
  if (!result) throw new NotFoundException();
  const id = randomUUID();
  await c.query(
    `INSERT INTO tender_app.intake_review_decision(id,tender_id,operation_key,request_hash,subject_type,receipt_id,company_id,expected_revision,action,before_state,after_state,reason,actor_id,source,result_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'human',$14)`,
    [
      id,
      tender,
      key,
      hash,
      kind,
      kind === 'receipt' ? subject : null,
      kind === 'company' ? subject : null,
      expected,
      action,
      JSON.stringify(before),
      JSON.stringify(after),
      note,
      actor,
      result.id,
    ],
  );
  await c.query(
    `INSERT INTO tender_app.audit_event(id,actor_id,tender_id,action,entity,entity_id,entity_revision) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), actor, tender, 'intake.review.' + action, 'intake_' + kind, subject, expected],
  );
  return id;
}
export async function impact(c: Client, tender: string, receipt: string) {
  return (
    await c.query(
      'SELECT v.offer_version_id AS "versionId",v.context_token AS "contextToken" FROM tender_app.intake_verification_context v WHERE v.tender_id=$1 AND v.receipt_id=$2 ORDER BY v.offer_version_id',
      [tender, receipt],
    )
  ).rows;
}
export async function acknowledgeImpact(
  c: PoolClient,
  tender: string,
  receipt: string,
  hash?: string,
  ack?: boolean,
) {
  const affected = await impact(c, tender, receipt);
  if (affected.length && (!ack || hash !== valueHash(affected)))
    throw new ConflictException('commercial_impact_acknowledgment_required');
}
export async function assertReference(
  c: Client,
  table: 'lot' | 'intake_company' | 'intake_receipt',
  tender: string,
  id: string,
) {
  if (
    !(await c.query('SELECT 1 FROM tender_app.' + table + ' WHERE tender_id=$1 AND id=$2', [tender, id]))
      .rowCount
  )
    throw new NotFoundException();
}
export async function actualContext(c: Client, tender: string, version: string) {
  const stored = (
    await c.query(
      'SELECT * FROM tender_app.intake_verification_context WHERE tender_id=$1 AND offer_version_id=$2',
      [tender, version],
    )
  ).rows[0];
  if (!stored) return null;
  try {
    const current = await confirmedContext(c, tender, stored.receipt_id);
    return stored.intent === 'confirm' && current.contextToken === stored.context_token
      ? null
      : 'intake_context_stale_or_unconfirmed';
  } catch {
    return 'intake_context_stale_or_revoked';
  }
}
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
export function requireNote(note: string) {
  if (!note?.trim()) throw new BadRequestException('review_note_required');
}
export type Row = QueryResultRow;
