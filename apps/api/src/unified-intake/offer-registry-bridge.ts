import { Pool } from 'pg';
import type { OfferDocument } from '../data/offer-repository';
import { bridgeInstalled } from './business-bridge';
export async function contextualRegistry(
  pool: Pool,
  tender: string,
  documents: OfferDocument[],
): Promise<OfferDocument[]> {
  if (!(await bridgeInstalled(pool))) return documents;
  const projections = (
    await pool.query(
      `SELECT rp.*,lp.owned_document,co.confirmed_supplier_id AS supplier_id,s.legal_name AS supplier_name,a.state AS association_state,cr.review_state AS company_state FROM tender_app.intake_receipt_projection rp JOIN tender_app.intake_legacy_projection lp ON lp.original_id=rp.original_id AND lp.purpose=rp.purpose LEFT JOIN tender_app.intake_association_head h ON h.receipt_id=rp.receipt_id AND h.tender_id=rp.tender_id AND h.association_type='supplier_of' AND h.approved_revision_id=h.current_revision_id LEFT JOIN tender_app.intake_association_revision a ON a.id=h.approved_revision_id LEFT JOIN tender_app.intake_company co ON co.id=a.company_id AND co.tender_id=a.tender_id LEFT JOIN tender_app.intake_company_revision cr ON cr.id=co.current_revision_id LEFT JOIN tender_app.supplier s ON s.id=co.confirmed_supplier_id WHERE rp.tender_id=$1 AND rp.purpose='offer'`,
      [tender],
    )
  ).rows;
  const output: OfferDocument[] = [];
  for (const doc of documents) {
    const maps = projections.filter((p) => p.legacy_document_id === doc.id);
    if (!maps.length) {
      output.push(doc);
      continue;
    }
    const managedIds = new Set(maps.map((m) => m.legacy_receipt_id));
    const unmanaged = doc.receipts.filter((r) => !managedIds.has(r.id));
    if (!maps[0].owned_document) {
      if (!unmanaged.length) {
        const original = (
          await pool.query(
            'SELECT d.*,u.display_name FROM tender_app.document d JOIN tender_app.app_user u ON u.id=d.uploaded_by WHERE d.id=$1 AND d.tender_id=$2',
            [doc.id, tender],
          )
        ).rows[0];
        unmanaged.push({
          id: doc.id,
          batchId: original.batch_id,
          receivedAt: original.received_at,
          actorId: original.uploaded_by,
          actorName: original.display_name,
          source: original.channel ?? 'unknown',
          stage: doc.stage,
          supplierId: doc.supplierId,
          supplierName: doc.supplierName,
          senderEmail: original.sender_email,
          originalName: original.original_name,
          legacy: true,
        });
      }
      output.push({ ...doc, receipts: unmanaged });
    }
    const groups = new Map<string, OfferDocument>();
    for (const map of maps) {
      const confirmed = map.association_state === 'confirmed' && map.company_state === 'confirmed',
        supplier = confirmed ? map.supplier_id : null,
        key = supplier ?? 'unassigned';
      if (!groups.has(key))
        groups.set(
          key,
          Object.assign(
            {
              ...doc,
              supplierId: supplier,
              supplierName: confirmed ? map.supplier_name : null,
              associationStatus: confirmed ? 'confirmed' : 'unresolved',
              receipts: [],
            },
            { managedReceipt: true, contextReceiptIds: [] },
          ),
        );
      const group = groups.get(key)!;
      const receipt = doc.receipts.find((r) => r.id === map.legacy_receipt_id);
      if (receipt)
        group.receipts.push(
          Object.assign(
            { ...receipt, supplierId: supplier, supplierName: confirmed ? map.supplier_name : null },
            { intakeReceiptId: map.receipt_id, associationReview: map.association_state ?? 'unassigned' },
          ),
        );
      (group as OfferDocument & { contextReceiptIds: string[] }).contextReceiptIds.push(map.receipt_id);
    }
    output.push(...groups.values());
  }
  return output;
}
