import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Classification } from './classification';
import { TextPage } from './organizations';
import { Ticket } from './processing-queue';
export class ContextAssociations {
  async persist(c: PoolClient, t: Ticket, value: Classification, pages: TextPage[]) {
    const result = (await c.query('SELECT id FROM tender_app.intake_result WHERE run_id=$1', [t.id])).rows[0];
    const observations = (
      await c.query(
        "SELECT o.*,a.company_id FROM tender_app.intake_organization_observation o JOIN tender_app.intake_association_revision a ON a.observation_id=o.id AND a.association_type='supplier_of' WHERE o.classification_result_id=$1 AND o.role='supplier'",
        [result.id],
      )
    ).rows;
    const add = async (
      kind: string,
      company: string | null,
      target: string | null,
      obs: string | null,
      evidence: string[],
      reason: string,
    ) => {
      const key = kind + ':' + (company ?? target);
      const head = (
        await c.query(
          'SELECT * FROM tender_app.intake_association_head WHERE tender_id=$1 AND receipt_id=$2 AND association_key=$3 FOR UPDATE',
          [t.tender_id, t.receipt_id, key],
        )
      ).rows[0];
      // A retry/replay with the same context must not append another relation.
      if (head) return;
      const id = randomUUID();
      await c.query(
        "INSERT INTO tender_app.intake_association_revision(id,tender_id,receipt_id,company_id,target_receipt_id,association_key,observation_id,revision,association_type,state,evidence_ids,reason,rules_version) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,'proposed',$9,$10,'context-associations-v1')",
        [id, t.tender_id, t.receipt_id, company, target, key, obs, kind, evidence, reason],
      );
      await c.query(
        'INSERT INTO tender_app.intake_association_head(tender_id,receipt_id,company_id,target_receipt_id,association_key,association_type,current_revision_id,state_revision) VALUES($1,$2,$3,$4,$5,$6,$7,1)',
        [t.tender_id, t.receipt_id, company, target, key, kind, id],
      );
    };
    for (const o of observations) {
      if (value.type === 'quality_certificate')
        await add(
          'quality_for',
          o.company_id,
          null,
          o.id,
          Object.values(o.evidence_by_field),
          'explicit_supplier_role_in_quality_document',
        );
      if (value.type === 'supporting')
        await add(
          'supports',
          o.company_id,
          null,
          o.id,
          Object.values(o.evidence_by_field),
          'explicit_supplier_role_in_supporting_document',
        );
    }
    const source = (
      await c.query('SELECT parent_receipt_id FROM tender_app.intake_receipt WHERE id=$1', [t.receipt_id])
    ).rows[0];
    const evidence = async (field: string, excerpt: string, page: number | null, method: string) => {
      const id = randomUUID();
      await c.query(
        'INSERT INTO tender_app.intake_evidence(id,tender_id,result_id,original_id,receipt_id,source_sha,field_path,page,excerpt,method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          id,
          t.tender_id,
          result.id,
          t.original_id,
          t.receipt_id,
          t.source_sha,
          'relations.' + field,
          page,
          excerpt,
          method,
        ],
      );
      return id;
    };
    if (source.parent_receipt_id) {
      const proof = await evidence(
        'contained_in',
        'MIME parent receipt: ' + source.parent_receipt_id,
        null,
        'mime_containment_metadata',
      );
      await add(
        'contained_in',
        null,
        source.parent_receipt_id,
        null,
        [proof],
        'physical_mime_containment_only',
      );
    }
    for (const page of pages)
      for (const hit of page.text.matchAll(
        /(?:Specification receipt|Supersedes receipt):\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi,
      )) {
        const target = hit[1].toLowerCase();
        if (
          target === t.receipt_id ||
          !(
            await c.query('SELECT 1 FROM tender_app.intake_receipt WHERE id=$1 AND tender_id=$2', [
              target,
              t.tender_id,
            ])
          ).rowCount
        )
          continue;
        const kind = hit[0].toLowerCase().startsWith('specification')
          ? 'relates_to_specification'
          : 'supersedes';
        if (kind === 'relates_to_specification') {
          const targetType = (
            await c.query(
              'SELECT v.type FROM tender_app.intake_classification_head h JOIN tender_app.intake_classification_revision v ON v.id=COALESCE(h.approved_revision_id,h.current_revision_id) WHERE h.receipt_id=$1 AND h.tender_id=$2',
              [target, t.tender_id],
            )
          ).rows[0]?.type;
          if (targetType !== 'specification') continue;
        }
        const proof = await evidence(kind, hit[0], page.page, 'native_explicit_receipt_reference');
        await add(kind, null, target, null, [proof], 'explicit_document_reference');
      }
  }
}
