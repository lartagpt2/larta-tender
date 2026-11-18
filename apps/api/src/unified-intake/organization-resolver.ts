import { ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { countryKey, identifier, normalizationVersion, weakName } from './organization-identity';
import { Organization, organizationPolicy, organizationSchema } from './organizations';
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, value]) => [k, canonical(value)]),
    );
  return v;
}
const hash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
const unique = <T>(v: T[]) => [...new Set(v)];
interface Context {
  tender: string;
  receipt: string;
  original: string;
  sha: string;
  result: string;
  actor: string;
  policyVersion?: string;
  worker?: string;
  method?: Organization['extraction_method'];
}
interface Requisites {
  names: string[];
  identifiers: Organization['identifiers'];
  roles: string[];
  emails: string[];
  contacts: string[];
  addresses: string[];
  countries: string[];
  conflicts: string[];
}
export class OrganizationResolver {
  async persist(c: PoolClient, ctx: Context, orgs: Organization[], policy = organizationPolicy) {
    if (policy !== organizationPolicy) throw new ConflictException('Organization policy changed');
    const source = (
      await c.query(
        'SELECT r.*,p.generation,p.status,p.policy_version FROM tender_app.intake_result r JOIN tender_app.intake_processing_run p ON p.id=r.run_id WHERE r.id=$1 AND r.tender_id=$2 AND r.receipt_id=$3 AND r.original_id=$4 AND r.source_sha=$5 FOR UPDATE OF p',
        [ctx.result, ctx.tender, ctx.receipt, ctx.original, ctx.sha],
      )
    ).rows[0];
    if (
      !source ||
      source.policy_version !== (ctx.policyVersion ?? 'native-only-v1') ||
      !['completed', 'failed', 'unsupported'].includes(source.status)
    )
      throw new ConflictException('Organization source unavailable');
    if (
      (
        await c.query('SELECT max(generation) n FROM tender_app.intake_processing_run WHERE receipt_id=$1', [
          ctx.receipt,
        ])
      ).rows[0].n !== source.generation
    )
      throw new ConflictException('Stale organization run');
    orgs = orgs.map((o) => ({
      ...o,
      identifiers: o.identifiers.map((i) => identifier(countryKey(o.country), i.scheme, i.raw_value)),
    }));
    const outputHash = hash(orgs);
    const method = ctx.method ?? orgs[0]?.extraction_method ?? 'native_labeled';
    const previous = (
      await c.query(
        'SELECT id,output_sha,extraction_method FROM tender_app.intake_organization_result WHERE classification_result_id=$1',
        [ctx.result],
      )
    ).rows[0];
    if (previous) {
      if (previous.output_sha !== outputHash || previous.extraction_method !== method)
        throw new ConflictException('Organization result conflict');
      return previous.id as string;
    }
    const result = randomUUID();
    const inserted = await c.query(
      'INSERT INTO tender_app.intake_organization_result(id,tender_id,receipt_id,classification_result_id,original_id,source_sha,schema_version,policy_version,output,output_sha,extraction_method,model) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false) ON CONFLICT(classification_result_id) DO NOTHING RETURNING id',
      [
        result,
        ctx.tender,
        ctx.receipt,
        ctx.result,
        ctx.original,
        ctx.sha,
        organizationSchema,
        policy,
        JSON.stringify(orgs),
        outputHash,
        method,
      ],
    );
    if (!inserted.rowCount) {
      const winner = (
        await c.query(
          'SELECT id,output_sha,extraction_method FROM tender_app.intake_organization_result WHERE classification_result_id=$1',
          [ctx.result],
        )
      ).rows[0];
      if (winner?.output_sha !== outputHash || winner.extraction_method !== method)
        throw new ConflictException('Organization result conflict');
      return winner.id as string;
    }
    const stored: { org: Organization; id: string; origin: string; mapping: Record<string, string> }[] = [];
    for (const org of orgs) {
      // Recompute validator output here: an adapter cannot assert that an arbitrary ID is valid.
      const id = randomUUID(),
        mapping: Record<string, string> = {};
      for (const [field, e] of Object.entries(org.evidence_by_field)) {
        const eid = randomUUID();
        mapping[field] = eid;
        await c.query(
          'INSERT INTO tender_app.intake_evidence(id,tender_id,result_id,original_id,receipt_id,source_sha,field_path,page,sheet,cell_range,excerpt,method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
          [
            eid,
            ctx.tender,
            ctx.result,
            ctx.original,
            ctx.receipt,
            ctx.sha,
            'organizations.' + org.local_key + '.' + field,
            e.page,
            e.sheet ?? null,
            e.cell_range ?? null,
            e.excerpt,
            org.extraction_method,
          ],
        );
      }
      const origin = hash([
        ctx.receipt,
        org.local_key,
        org.role,
        {
          ...org,
          evidence_by_field: undefined,
          extraction_method: undefined,
          warnings: undefined,
          review_state: undefined,
        },
      ]);
      await c.query(
        'INSERT INTO tender_app.intake_organization_observation(id,tender_id,result_id,receipt_id,classification_result_id,local_key,origin_key,role,name,legal_name,country,identifiers,address,emails,contacts,evidence_by_field,extraction_method,review_state,warnings) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)',
        [
          id,
          ctx.tender,
          result,
          ctx.receipt,
          ctx.result,
          org.local_key,
          origin,
          org.role,
          org.name,
          org.legal_name,
          org.country,
          JSON.stringify(org.identifiers),
          org.address,
          JSON.stringify(org.emails),
          JSON.stringify(org.contacts),
          JSON.stringify(mapping),
          org.extraction_method,
          org.review_state,
          JSON.stringify(org.warnings),
        ],
      );
      stored.push({ org, id, origin, mapping });
    }
    // Supplier observations create identities first; other evidenced roles may then link to the same identity.
    for (const entry of [...stored].sort(
      (a, b) => Number(b.org.role === 'supplier') - Number(a.org.role === 'supplier'),
    )) {
      const { org, id: observation, origin, mapping } = entry,
        country = countryKey(org.country);
      const supported = org.identifiers.filter((i) => i.valid);
      const conflict =
        org.warnings.includes('conflicting_identifiers') ||
        supported.some((i) =>
          supported.some((j) => i.scheme === j.scheme && i.normalized_value !== j.normalized_value),
        );
      const strong =
        org.role === 'supplier' && org.review_state === 'proposed' && !conflict && country ? supported : [];
      const claimants: string[] = [];
      for (const i of supported)
        if (country) {
          const claim = (
            await c.query(
              'SELECT company_id FROM tender_app.intake_identity_claim WHERE tender_id=$1 AND country_key=$2 AND scheme=$3 AND normalized_value=$4',
              [ctx.tender, country, i.scheme, i.normalized_value],
            )
          ).rows[0];
          if (claim) claimants.push(claim.company_id);
        }
      const distinct = unique(claimants);
      let company: string | undefined;
      if (strong.length && distinct.length === 1) company = distinct[0];
      const originCompany = (
        await c.query(
          'SELECT id FROM tender_app.intake_company WHERE tender_id=$1 AND origin_observation_key=$2',
          [ctx.tender, origin],
        )
      ).rows[0]?.id as string | undefined;
      if (originCompany && company && originCompany !== company)
        throw new ConflictException('Existing origin cannot be reassigned');
      company ??= originCompany;
      if (org.role !== 'supplier') {
        // No buyer-only/manufacturer-only company is ever created.
        if (!conflict && distinct.length === 1 && org.role !== 'unknown') company = distinct[0];
        else continue;
      }
      if (!(org.legal_name ?? org.name)) continue;
      const warnings = unique([
        ...org.warnings,
        ...(conflict || distinct.length > 1 ? ['identifier_conflict'] : []),
      ]);
      if (distinct.length > 1) company = originCompany;
      const newCompany = !company;
      const priorAssociations = (
        await c.query(
          'SELECT DISTINCT h.company_id FROM tender_app.intake_association_head h JOIN tender_app.intake_association_revision a ON a.id=h.current_revision_id JOIN tender_app.intake_organization_observation o ON o.id=a.observation_id WHERE h.tender_id=$1 AND h.receipt_id=$2 AND o.local_key=$3 AND o.role=$4',
          [ctx.tender, ctx.receipt, org.local_key, org.role],
        )
      ).rows;
      if (newCompany && priorAssociations.length) warnings.push('changed_identity');
      const revisionId = randomUUID();
      if (!company) {
        company = randomUUID();
        const r = await c.query(
          'INSERT INTO tender_app.intake_company(id,tender_id,origin_observation_id,origin_observation_key,current_revision_id,state_revision) VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(tender_id,origin_observation_key) DO NOTHING RETURNING id',
          [company, ctx.tender, observation, origin, revisionId],
        );
        if (!r.rowCount)
          company = (
            await c.query(
              'SELECT id FROM tender_app.intake_company WHERE tender_id=$1 AND origin_observation_key=$2',
              [ctx.tender, origin],
            )
          ).rows[0].id;
      }
      const head = (
        await c.query(
          'SELECT c.*,r.requisites,r.source_observations,r.evidence_ids,r.review_state,r.source AS revision_source FROM tender_app.intake_company c LEFT JOIN tender_app.intake_company_revision r ON r.id=c.current_revision_id WHERE c.id=$1 AND c.tender_id=$2 FOR UPDATE OF c',
          [company, ctx.tender],
        )
      ).rows[0];
      const old = head.requisites as Requisites | undefined;
      if (old?.addresses.length && org.address && !old.addresses.includes(org.address))
        warnings.push('conflicting_address');
      const data: Requisites = {
        names: unique([...(old?.names ?? []), ...[org.name, org.legal_name].filter((s): s is string => !!s)]),
        identifiers: [...(old?.identifiers ?? []), ...org.identifiers].filter(
          (i, n, all) => all.findIndex((j) => JSON.stringify(j) === JSON.stringify(i)) === n,
        ),
        roles: unique([...(old?.roles ?? []), org.role]),
        emails: unique([...(old?.emails ?? []), ...org.emails]),
        contacts: unique([...(old?.contacts ?? []), ...org.contacts]),
        addresses: unique([...(old?.addresses ?? []), ...(org.address ? [org.address] : [])]),
        countries: unique([...(old?.countries ?? []), ...(org.country ? [org.country] : [])]),
        conflicts: unique([...(old?.conflicts ?? []), ...warnings]),
      };
      const evidenceIds = Object.values(mapping),
        number = old ? head.state_revision + 1 : 1;
      if (head.revision_source !== 'human') {
        await c.query(
          "INSERT INTO tender_app.intake_company_revision(id,tender_id,company_id,revision,requisites,source_observations,evidence_ids,review_state,reason,source,actor_id,supersedes_id,worker_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'system',$10,$11,$12)",
          [
            old ? revisionId : head.current_revision_id,
            ctx.tender,
            company,
            number,
            JSON.stringify(data),
            unique([...(head.source_observations ?? []), observation]),
            unique([...(head.evidence_ids ?? []), ...evidenceIds]),
            data.conflicts.length ? 'needs_review' : 'proposed',
            data.conflicts.join(',') || 'evidence_backed_supplier_role',
            ctx.actor,
            old ? head.current_revision_id : null,
            ctx.worker ?? null,
          ],
        );
        if (old)
          await c.query(
            'UPDATE tender_app.intake_company SET current_revision_id=$2,state_revision=$3 WHERE id=$1 AND state_revision=$4',
            [company, revisionId, number, head.state_revision],
          );
      }
      // Append-only claims cannot be transferred; ON CONFLICT is followed by explicit winner verification.
      if (distinct.length <= 1)
        for (const i of strong) {
          const idx = org.identifiers.indexOf(i),
            eid = mapping['identifiers.' + idx + '.raw_value'];
          await c.query(
            'INSERT INTO tender_app.intake_identity_claim(id,tender_id,company_id,observation_id,country_key,scheme,normalized_value,normalization_version,evidence_id,result_id,receipt_id,classification_result_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(tender_id,country_key,scheme,normalized_value) DO NOTHING',
            [
              randomUUID(),
              ctx.tender,
              company,
              observation,
              country,
              i.scheme,
              i.normalized_value,
              normalizationVersion,
              eid,
              result,
              ctx.receipt,
              ctx.result,
            ],
          );
          const winner = (
            await c.query(
              'SELECT company_id FROM tender_app.intake_identity_claim WHERE tender_id=$1 AND country_key=$2 AND scheme=$3 AND normalized_value=$4',
              [ctx.tender, country, i.scheme, i.normalized_value],
            )
          ).rows[0];
          if (winner.company_id !== company) throw new ConflictException('Identity claim conflict');
        }
      const candidates = (
        await c.query(
          'SELECT c.id,r.requisites FROM tender_app.intake_company c JOIN tender_app.intake_company_revision r ON r.id=c.current_revision_id WHERE c.tender_id=$1 AND c.id<>$2 ORDER BY c.id',
          [ctx.tender, company],
        )
      ).rows;
      const propose = async (target: string, type: string, supplier = false) =>
        c.query(
          "INSERT INTO tender_app.intake_match_proposal(id,tender_id,company_id,target_company_id,target_supplier_id,observation_id,match_type,basis,evidence_ids,state,rules_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'proposed',$10) ON CONFLICT DO NOTHING",
          [
            randomUUID(),
            ctx.tender,
            company,
            supplier ? null : target,
            supplier ? target : null,
            observation,
            type,
            JSON.stringify({ country, identifiers: org.identifiers, method: org.extraction_method }),
            evidenceIds,
            organizationPolicy,
          ],
        );
      for (const candidate of candidates) {
        const r = candidate.requisites as Requisites;
        if (distinct.includes(candidate.id) && (conflict || distinct.length > 1))
          await propose(candidate.id, 'identifier_conflict');
        else if (r.names.some((n) => weakName(n) === weakName(org.legal_name ?? org.name)))
          await propose(candidate.id, 'weak_name');
        else if (r.emails.some((e) => org.emails.some((s) => s.toLowerCase() === e.toLowerCase())))
          await propose(candidate.id, 'weak_email');
        else if (r.contacts.some((e) => org.contacts.includes(e)))
          await propose(candidate.id, 'weak_contact');
        else if (
          r.emails.some((e) =>
            org.emails.some(
              (s) => s.split('@')[1] && s.split('@')[1].toLowerCase() === e.split('@')[1]?.toLowerCase(),
            ),
          )
        )
          await propose(candidate.id, 'weak_domain');
        else if (org.address && r.addresses.includes(org.address))
          await propose(candidate.id, 'weak_address');
      }
      const changed = priorAssociations.filter((a) => a.company_id !== company);
      if (newCompany && changed.length)
        for (const other of changed) await propose(other.company_id, 'changed_identity');
      const suppliers = (
        await c.query(
          'SELECT s.* FROM tender_app.tender_supplier ts JOIN tender_app.supplier s ON s.id=ts.supplier_id WHERE ts.tender_id=$1 ORDER BY s.id',
          [ctx.tender],
        )
      ).rows;
      for (const supplier of suppliers) {
        const match = strong.some(
          (i) =>
            i.scheme === 'RU_INN' &&
            country === 'RU' &&
            countryKey(supplier.country) === country &&
            identifier(country, i.scheme, supplier.tax_id ?? '').normalized_value === i.normalized_value,
        );
        if (match) await propose(supplier.id, 'strong_identifier', true);
        else if (weakName(supplier.legal_name) === weakName(org.legal_name ?? org.name))
          await propose(supplier.id, 'weak_name', true);
        else if (supplier.email && org.emails.some((e) => e.toLowerCase() === supplier.email.toLowerCase()))
          await propose(supplier.id, 'weak_email', true);
      }
      const type = org.role === 'supplier' ? 'supplier_of' : 'supports';
      const associationKey = type + ':' + company;
      const assoc = (
        await c.query(
          'SELECT * FROM tender_app.intake_association_head WHERE tender_id=$1 AND receipt_id=$2 AND company_id=$3 AND association_type=$4 FOR UPDATE',
          [ctx.tender, ctx.receipt, company, type],
        )
      ).rows[0];
      const association = randomUUID(),
        rev = (assoc?.state_revision ?? 0) + 1;
      await c.query(
        "INSERT INTO tender_app.intake_association_revision(id,tender_id,receipt_id,company_id,observation_id,revision,association_type,state,evidence_ids,reason,rules_version,supersedes_id,association_key) VALUES($1,$2,$3,$4,$5,$6,$7,'proposed',$8,$9,$10,$11,$12)",
        [
          association,
          ctx.tender,
          ctx.receipt,
          company,
          observation,
          rev,
          type,
          evidenceIds,
          'explicit_' + org.role + '_role',
          organizationPolicy,
          assoc?.current_revision_id ?? null,
          associationKey,
        ],
      );
      if (assoc)
        await c.query(
          'UPDATE tender_app.intake_association_head SET current_revision_id=$4,state_revision=$5 WHERE receipt_id=$1 AND company_id=$2 AND association_type=$3 AND state_revision=$6',
          [ctx.receipt, company, type, association, rev, assoc.state_revision],
        );
      else
        await c.query(
          'INSERT INTO tender_app.intake_association_head(tender_id,receipt_id,company_id,association_type,current_revision_id,state_revision,association_key) VALUES($1,$2,$3,$4,$5,1,$6)',
          [ctx.tender, ctx.receipt, company, type, association, associationKey],
        );
      await c.query(
        "INSERT INTO tender_app.audit_event(id,actor_id,tender_id,action,entity,entity_id,entity_revision,worker_id) VALUES($1,$2,$3,'intake.company.proposed','intake_company',$4,$5,$6)",
        [randomUUID(), ctx.actor, ctx.tender, company, number, ctx.worker ?? null],
      );
    }
    await c.query(
      "INSERT INTO tender_app.intake_review_decision(id,tender_id,operation_key,request_hash,subject_type,receipt_id,expected_revision,action,before_state,after_state,reason,actor_id,source,result_id,worker_id) VALUES($1,$2,$3,$4,'receipt',$5,$6,'resolve','{}',$7,$8,$9,'system',$3,$10)",
      [
        randomUUID(),
        ctx.tender,
        result,
        outputHash,
        ctx.receipt,
        source.generation,
        JSON.stringify({ observations: stored.map((s) => s.id) }),
        organizationPolicy,
        ctx.actor,
        ctx.worker ?? null,
      ],
    );
    await c.query(
      "INSERT INTO tender_app.audit_event(id,actor_id,tender_id,action,entity,entity_id,entity_revision,worker_id) VALUES($1,$2,$3,'intake.organizations.resolved','intake_receipt',$4,$5,$6)",
      [randomUUID(), ctx.actor, ctx.tender, ctx.receipt, source.generation, ctx.worker ?? null],
    );
    return result;
  }
}
