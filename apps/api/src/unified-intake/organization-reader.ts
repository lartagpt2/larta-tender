import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { organizationSchema } from './organizations';
export interface CompaniesQuery {
  cursor?: string;
  limit?: string;
  reviewStatus?: string;
  search?: string;
}
export class OrganizationReader {
  constructor(private readonly pool: Pool) {}
  private async card(tender: string, company: string) {
    const row = (
      await this.pool.query(
        'SELECT c.id AS "preliminaryCompanyId",c.state_revision AS "stateRevision",c.confirmed_supplier_id AS "confirmedSupplierId",r.* FROM tender_app.intake_company c JOIN tender_app.intake_company_revision r ON r.id=c.current_revision_id WHERE c.tender_id=$1 AND c.id=$2',
        [tender, company],
      )
    ).rows[0];
    if (!row) throw new NotFoundException();
    const associations = (
      await this.pool.query(
        'SELECT r.*,d.original_name AS "documentName",i.original_id AS "originalId" FROM tender_app.intake_association_head h JOIN tender_app.intake_association_revision r ON r.id=h.current_revision_id JOIN tender_app.intake_receipt i ON i.id=h.receipt_id JOIN tender_app.intake_document d ON d.id=i.original_id WHERE h.tender_id=$1 AND h.company_id=$2 ORDER BY h.receipt_id,h.association_type',
        [tender, company],
      )
    ).rows;
    const matches = (
      await this.pool.query(
        'SELECT * FROM tender_app.intake_match_proposal WHERE tender_id=$1 AND company_id=$2 ORDER BY created_at,id',
        [tender, company],
      )
    ).rows;
    return {
      ...row,
      name: row.requisites.names[0] ?? null,
      requisites: row.requisites,
      roles: row.requisites.roles,
      identifiers: row.requisites.identifiers,
      supplierRole: row.requisites.roles.includes('supplier'),
      reviewState: row.review_state,
      observationCount: row.source_observations.length,
      receiptCount: new Set(associations.map((a) => a.receipt_id)).size,
      documents: associations,
      associationProposals: associations,
      matchProposals: matches,
      conflicts: row.requisites.conflicts,
      evidenceReferences: row.evidence_ids,
      existingParticipantCandidates: matches
        .filter((m) => m.target_supplier_id)
        .map((m) => m.target_supplier_id),
    };
  }
  async list(tender: string, q: CompaniesQuery) {
    const limit = q.limit === undefined ? 30 : Number(q.limit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (q.limit !== undefined && !/^[0-9]+$/.test(q.limit))
    )
      throw new BadRequestException('limit must be 1–100');
    if (q.cursor && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(q.cursor))
      throw new BadRequestException('Invalid cursor');
    if (
      q.reviewStatus &&
      !['proposed', 'needs_review', 'confirmed', 'rejected', 'superseded'].includes(q.reviewStatus)
    )
      throw new BadRequestException('Invalid review status');
    if (q.search && q.search.length > 200) throw new BadRequestException('Search is too long');
    const found = (
      await this.pool.query(
        'SELECT c.id FROM tender_app.intake_company c JOIN tender_app.intake_company_revision r ON r.id=c.current_revision_id WHERE c.tender_id=$1 AND ($2::uuid IS NULL OR c.id>$2) AND ($3::text IS NULL OR r.review_state=$3) AND ($4::text IS NULL OR position(lower($4) in lower(r.requisites::text))>0) ORDER BY c.id LIMIT $5',
        [tender, q.cursor ?? null, q.reviewStatus ?? null, q.search ?? null, limit + 1],
      )
    ).rows;
    const items = [];
    for (const r of found.slice(0, limit)) items.push(await this.card(tender, r.id));
    const unassigned = (
      await this.pool.query(
        'SELECT r.id AS "receiptId",r.original_name AS name FROM tender_app.intake_receipt r WHERE r.tender_id=$1 AND NOT EXISTS(SELECT 1 FROM tender_app.intake_association_head h WHERE h.receipt_id=r.id AND h.association_type=\'supplier_of\') ORDER BY r.received_at,r.id LIMIT 100',
        [tender],
      )
    ).rows;
    return {
      contractVersion: organizationSchema,
      items,
      nextCursor: found.length > limit ? found[limit - 1].id : null,
      unassignedReceipts: unassigned,
    };
  }
  async detail(tender: string, company: string) {
    const card = await this.card(tender, company);
    const observations = (
      await this.pool.query(
        'SELECT * FROM tender_app.intake_organization_observation WHERE tender_id=$1 AND id=ANY($2::uuid[]) ORDER BY created_at,id',
        [tender, card.source_observations],
      )
    ).rows;
    const revisions = (
      await this.pool.query(
        'SELECT * FROM tender_app.intake_company_revision WHERE company_id=$1 AND tender_id=$2 ORDER BY revision',
        [company, tender],
      )
    ).rows;
    const evidence = (
      await this.pool.query(
        'SELECT * FROM tender_app.intake_evidence WHERE tender_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
        [tender, card.evidence_ids],
      )
    ).rows;
    return {
      contractVersion: organizationSchema,
      ...card,
      currentRevision: revisions.at(-1),
      revisions,
      observations,
      evidence,
    };
  }
  async receipt(tender: string, receipt: string) {
    const organizations = (
      await this.pool.query(
        "SELECT o.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('preliminaryCompanyId',a.company_id,'associationType',a.association_type,'state',a.state,'revisionId',a.id)) FROM tender_app.intake_association_revision a WHERE a.observation_id=o.id AND a.tender_id=o.tender_id),'[]'::jsonb) AS \"associationProposals\" FROM tender_app.intake_organization_observation o WHERE o.tender_id=$1 AND o.receipt_id=$2 ORDER BY o.created_at,o.local_key",
        [tender, receipt],
      )
    ).rows;
    const matches = (
      await this.pool.query(
        'SELECT m.* FROM tender_app.intake_match_proposal m JOIN tender_app.intake_organization_observation o ON o.id=m.observation_id WHERE o.tender_id=$1 AND o.receipt_id=$2 ORDER BY m.id',
        [tender, receipt],
      )
    ).rows;
    const results = (
      await this.pool.query(
        'SELECT id,schema_version AS "schemaVersion",policy_version AS "policyVersion",extraction_method AS "extractionMethod",model,classification_result_id AS "classificationResultId" FROM tender_app.intake_organization_result WHERE tender_id=$1 AND receipt_id=$2 ORDER BY created_at,id',
        [tender, receipt],
      )
    ).rows;
    return {
      organizationsContractVersion: organizationSchema,
      organizations: organizations.map((o) => {
        const ids = [
          ...new Set(
            o.associationProposals
              .map((a: { preliminaryCompanyId: string | null }) => a.preliminaryCompanyId)
              .filter(Boolean),
          ),
        ];
        return { ...o, preliminaryCompanyIds: ids, preliminaryCompanyId: ids.length === 1 ? ids[0] : null };
      }),
      organizationResults: results,
      matchProposals: matches,
    };
  }
}
