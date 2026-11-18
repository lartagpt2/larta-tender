import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import type { VerificationDto } from '../comparison/verification.dto';
import {
  bridgeInstalled,
  confirmedContext,
  ConfirmedContext,
  humanDecision,
  operationReplay,
  Row,
  valueHash,
} from './business-bridge';
export interface ManagedVerification {
  context: ConfirmedContext;
  draft: Row;
  requestHash: string;
  operationKey: string;
  reply?: Row;
}
export async function prepareManagedVerification(
  c: PoolClient,
  actor: string,
  tender: string,
  input: VerificationDto,
): Promise<ManagedVerification | null> {
  if (!(await bridgeInstalled(c))) return null;
  const projection = (
    await c.query(
      "SELECT * FROM tender_app.intake_receipt_projection WHERE tender_id=$1 AND legacy_document_id=$2 AND legacy_receipt_id=$3 AND purpose='offer'",
      [tender, input.documentId, input.receiptId],
    )
  ).rows[0];
  if (!projection) {
    if (input.intakeContext) throw new NotFoundException();
    return null;
  }
  const requested = input.intakeContext;
  if (!requested) throw new ConflictException('receipt_context_required');
  if (requested.receiptId !== projection.receipt_id) throw new NotFoundException();
  const op = await operationReplay(c, tender, requested.operationKey, { kind: 'commercial', input });
  if (op.reply)
    return {
      context: {} as ConfirmedContext,
      draft: {},
      requestHash: op.hash,
      operationKey: requested.operationKey,
      reply: op.reply,
    };
  if (input.intent !== 'confirm') throw new BadRequestException('managed_use_transfer_draft');
  const context = await confirmedContext(c, tender, requested.receiptId);
  const scoped = (
    await c.query(
      `SELECT 1 FROM tender_app.intake_result r JOIN tender_app.intake_classification_revision cl ON cl.id=$4 AND cl.receipt_id=r.receipt_id AND cl.tender_id=r.tender_id JOIN tender_app.intake_association_revision a ON a.id=$5 AND a.receipt_id=r.receipt_id AND a.tender_id=r.tender_id JOIN tender_app.intake_company_revision co ON co.id=$6 AND co.company_id=a.company_id AND co.tender_id=a.tender_id WHERE r.id=$3 AND r.tender_id=$1 AND r.receipt_id=$2`,
      [
        tender,
        requested.receiptId,
        requested.resultId,
        requested.classificationRevisionId,
        requested.associationRevisionId,
        requested.companyRevisionId,
      ],
    )
  ).rowCount;
  if (!scoped) throw new NotFoundException();
  if (
    context.contextToken !== requested.contextToken ||
    context.resultId !== requested.resultId ||
    context.classificationRevisionId !== requested.classificationRevisionId ||
    context.associationRevisionId !== requested.associationRevisionId ||
    context.companyRevisionId !== requested.companyRevisionId
  )
    throw new ConflictException('stale_intake_context');
  if (
    context.supplierId !== input.supplierId ||
    context.documentId !== input.documentId ||
    context.legacyReceiptId !== input.receiptId
  )
    throw new ConflictException('intake_supplier_context_mismatch');
  const draft = (
    await c.query(
      'SELECT * FROM tender_app.intake_commercial_draft WHERE id=$1 AND result_id=$2 AND receipt_id=$3 AND tender_id=$4',
      [requested.draftId, context.resultId, context.receiptId, tender],
    )
  ).rows[0];
  if (!draft) throw new NotFoundException();
  if (draft.context_token !== context.contextToken) throw new ConflictException('stale_draft_context');
  if (draft.form.lotId !== input.lotId) throw new ConflictException('draft_lot_mapping_mismatch');
  void actor;
  return { context, draft, requestHash: op.hash, operationKey: requested.operationKey };
}
export async function recordManagedVersion(
  c: PoolClient,
  managed: ManagedVerification | null,
  actor: string,
  input: VerificationDto,
  version: string,
  fields: object,
  initial: boolean,
) {
  if (!managed) return;
  const ctx = managed.context;
  await c.query(
    'INSERT INTO tender_app.intake_verification_context(offer_version_id,tender_id,receipt_id,result_id,company_id,company_revision_id,classification_revision_id,association_revision_id,supplier_id,context_token,draft_id,intent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [
      version,
      ctx.tenderId,
      ctx.receiptId,
      ctx.resultId,
      ctx.companyId,
      ctx.companyRevisionId,
      ctx.classificationRevisionId,
      ctx.associationRevisionId,
      ctx.supplierId,
      ctx.contextToken,
      managed.draft.id,
      input.intent,
    ],
  );
  const values: { path: string; value: unknown; lotItem: string | null }[] = Object.entries(fields).map(
    ([key, value]) => ({ path: (initial ? 'original.' : 'fields.') + key, value, lotItem: null }),
  );
  if (!initial) {
    values.push({ path: 'costsEnabled', value: input.costsEnabled, lotItem: null });
    for (const item of input.items)
      for (const [key, value] of Object.entries(item))
        if (key !== 'lotItemId')
          values.push({ path: 'items.' + item.lotItemId + '.' + key, value, lotItem: item.lotItemId });
    for (const [index, cost] of input.costs.entries())
      for (const [key, value] of Object.entries(cost))
        values.push({ path: 'costs.' + index + '.' + key, value, lotItem: null });
  }
  for (const { path, value, lotItem } of values) {
    const hash = valueHash(value),
      prior = (
        await c.query(
          'SELECT * FROM tender_app.intake_draft_field WHERE draft_id=$1 AND field_path=$2 AND value_hash=$3',
          [managed.draft.id, path, hash],
        )
      ).rows[0];
    const evidence = prior?.evidence_id ?? null,
      manual = prior?.manual_decision_id ?? (evidence ? null : randomUUID());
    if (!prior && manual)
      await c.query(
        'INSERT INTO tender_app.intake_manual_source(id,tender_id,receipt_id,result_id,field_path,value,value_hash,note,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          manual,
          ctx.tenderId,
          ctx.receiptId,
          ctx.resultId,
          path,
          JSON.stringify(value),
          hash,
          input.sourceNote,
          actor,
        ],
      );
    await c.query(
      'INSERT INTO tender_app.intake_field_lineage(id,tender_id,offer_version_id,receipt_id,result_id,field_path,lot_item_id,lot_id,evidence_id,manual_decision_id,transferred_value_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        randomUUID(),
        ctx.tenderId,
        version,
        ctx.receiptId,
        ctx.resultId,
        path,
        lotItem,
        lotItem ? input.lotId : null,
        evidence,
        manual,
        hash,
      ],
    );
  }
}
export async function recordManagedOperation(
  c: PoolClient,
  managed: ManagedVerification | null,
  actor: string,
  input: VerificationDto,
  reply: unknown,
) {
  if (managed)
    await humanDecision(
      c,
      actor,
      managed.context.tenderId,
      managed.operationKey,
      managed.requestHash,
      'receipt',
      managed.context.receiptId,
      input.expectedVersion,
      'commercial',
      input.sourceNote,
      managed.draft,
      reply,
    );
}
