import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { transaction } from '../data/repository';
import { LifecycleActionDto, LifecyclePageDto } from './lifecycle.dto';
import { OCRSnapshot } from './ocr-inventory';
export const protectedTenders = new Set([
  'f768e259-c0fe-4819-a62b-28d5630025c6',
  '3c936af9-7b49-41cd-8b12-6b8c3b9a38fc',
  '240a9be8-d6e1-4fa7-a3f0-ea73bd60ef7c',
  'af32d29e-6589-410a-a7f5-e9e8795c7975',
  '62affe51-1e91-429e-a1b7-23611be38ac3',
  '346de0b5-f052-45a2-bdd8-d1f0882a8e5e',
  'e1f80509-6590-4b94-bc8b-4772aaaf54a5',
  '91f1fadf-9273-416e-a881-863a6456c693',
]);
const visible = `(t.owner_id=$1 OR EXISTS(SELECT 1 FROM tender_app.tender_member m WHERE m.tender_id=t.id AND m.user_id=$1))`;
const joins = {
  lot_item: 'JOIN tender_app.lot p ON p.id=x.lot_id',
  extraction_run: 'JOIN tender_app.document p ON p.id=x.document_id',
  extracted_field: 'JOIN tender_app.document p ON p.id=x.document_id',
  evidence_reference: 'JOIN tender_app.document p ON p.id=x.document_id',
  field_decision: 'JOIN tender_app.document p ON p.id=x.document_id',
  offer_item: 'JOIN tender_app.offer_version p ON p.id=x.offer_version_id',
  cost_component: 'JOIN tender_app.offer_version p ON p.id=x.offer_version_id',
  comparison_offer: 'JOIN tender_app.comparison p ON p.id=x.comparison_id',
};
export class PgLifecycleRepository {
  constructor(
    private readonly pool: Pool,
    private readonly ocr: (id: string) => Promise<OCRSnapshot>,
  ) {}
  async page(actor: string, input: LifecyclePageDto) {
    return transaction(this.pool, async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const where = `${visible} AND COALESCE(l.state,'active')=$2 AND strpos(lower(t.title),lower($3))>0`;
      const args = [actor, input.state, input.search];
      const total = Number(
        (
          await c.query(
            `SELECT count(*) FROM tender_app.tender t LEFT JOIN tender_app.tender_lifecycle l ON l.tender_id=t.id WHERE ${where}`,
            args,
          )
        ).rows[0].count,
      );
      const items = (
        await c.query(
          `SELECT t.id,t.title,t.revision,COALESCE(l.state,'active') AS state,COALESCE(l.classification,'unclassified') AS classification,t.created_at AS "createdAt" FROM tender_app.tender t LEFT JOIN tender_app.tender_lifecycle l ON l.tender_id=t.id WHERE ${where} ORDER BY t.created_at DESC,t.id LIMIT $4 OFFSET $5`,
          [...args, input.pageSize, (input.page - 1) * input.pageSize],
        )
      ).rows;
      return { items, total, page: input.page, pageSize: input.pageSize };
    });
  }
  private async snapshot(c: PoolClient, actor: string, id: string) {
    const t = (
      await c.query(
        `SELECT t.id,t.title,t.revision,t.dependency_revision::text AS "dependencyRevision",t.content_revision::text AS "contentRevision",t.owner_id FROM tender_app.tender t WHERE t.id=$2 AND ${visible} FOR UPDATE`,
        [actor, id],
      )
    ).rows[0];
    if (!t) throw new NotFoundException();
    const lifecycle = (
      await c.query(
        'SELECT state,classification,classified_content_revision,classified_ocr_hash,evidence,classified_by,classified_at FROM tender_app.tender_lifecycle WHERE tender_id=$1',
        [id],
      )
    ).rows[0] ?? {
      state: 'active',
      classification: 'unclassified',
      classified_content_revision: null,
      classified_ocr_hash: null,
      evidence: null,
      classified_by: null,
      classified_at: null,
    };
    const roles = (
      await c.query('SELECT role FROM tender_app.tender_member WHERE tender_id=$1 AND user_id=$2', [
        id,
        actor,
      ])
    ).rows;
    const capabilities = (
      await c.query(
        'SELECT capability FROM tender_app.tender_capability WHERE tender_id=$1 AND user_id=$2 ORDER BY capability',
        [id, actor],
      )
    ).rows.map((r) => r.capability as string);
    const canWrite = t.owner_id === actor || roles.some((r) => ['buyer', 'manager'].includes(r.role));
    const counts: Record<string, number> = {};
    const direct = (
      await c.query(
        "SELECT table_name FROM information_schema.columns WHERE table_schema='tender_app' AND column_name='tender_id' ORDER BY table_name",
      )
    ).rows;
    for (const { table_name: table } of direct) {
      if (!/^[a-z_]+$/.test(table)) throw Error('invalid_dependency_table');
      counts[table] = Number(
        (await c.query(`SELECT count(*) FROM tender_app.${table} WHERE tender_id=$1`, [id])).rows[0].count,
      );
    }
    for (const [table, join] of Object.entries(joins))
      counts[table] = Number(
        (await c.query(`SELECT count(*) FROM tender_app.${table} x ${join} WHERE p.tender_id=$1`, [id]))
          .rows[0].count,
      );
    const sharedBlobs = Number(
      (
        await c.query(
          'SELECT count(DISTINCT d.blob_sha256) FROM tender_app.document d WHERE d.tender_id=$1 AND EXISTS(SELECT 1 FROM tender_app.document other WHERE other.blob_sha256=d.blob_sha256 AND other.tender_id<>$1)',
          [id],
        )
      ).rows[0].count,
    );
    const dbActive = Number(
      (
        await c.query(
          "SELECT count(*) FROM tender_app.extraction_run r JOIN tender_app.document d ON d.id=r.document_id WHERE d.tender_id=$1 AND r.status IN ('queued','processing')",
          [id],
        )
      ).rows[0].count,
    );
    const ocr = await this.ocr(id),
      held = protectedTenders.has(id),
      busy = dbActive + ocr.active > 0;
    const ocrHash = createHash('sha256').update(JSON.stringify(ocr.jobs)).digest('hex');
    const value = {
      ocrHash,
      id: t.id,
      title: t.title,
      revision: t.revision,
      dependencyRevision: t.dependencyRevision,
      contentRevision: t.contentRevision,
      ...lifecycle,
      counts,
      sharedBlobs,
      ocr,
      dbActive,
      held,
      capabilities,
      canWrite,
    };
    const previewHash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const allowed = {
      archive: canWrite && !held && !busy && lifecycle.state === 'active',
      restore: canWrite && !held && lifecycle.state !== 'active',
      trash:
        canWrite &&
        !held &&
        !busy &&
        lifecycle.state !== 'trash' &&
        lifecycle.classification === 'synthetic' &&
        String(lifecycle.classified_content_revision) === t.contentRevision &&
        lifecycle.classified_ocr_hash === ocrHash &&
        capabilities.includes('trash_synthetic'),
      classify_synthetic:
        canWrite &&
        !held &&
        !busy &&
        lifecycle.state === 'active' &&
        lifecycle.classification !== 'working' &&
        (lifecycle.classification !== 'synthetic' ||
          String(lifecycle.classified_content_revision) !== t.contentRevision ||
          lifecycle.classified_ocr_hash !== ocrHash) &&
        capabilities.includes('classify_synthetic'),
      classify_working:
        canWrite &&
        !held &&
        !busy &&
        lifecycle.state === 'active' &&
        lifecycle.classification !== 'working' &&
        capabilities.includes('classify_synthetic'),
    };
    return { ...value, busy, previewHash, allowed };
  }
  async preview(actor: string, id: string) {
    return transaction(this.pool, (c) => this.snapshot(c, actor, id));
  }
  async act(actor: string, id: string, input: LifecycleActionDto) {
    return transaction(this.pool, async (c) => {
      const before = await this.snapshot(c, actor, id);
      if (input.confirmationId !== id || input.confirmationTitle !== before.title)
        throw new BadRequestException();
      if (input.previewHash !== before.previewHash) throw new ConflictException();
      if (!before.canWrite) throw new ForbiddenException();
      if (
        ['trash', 'classify_synthetic', 'classify_working'].includes(input.action) &&
        !before.capabilities.includes(input.action === 'trash' ? 'trash_synthetic' : 'classify_synthetic')
      )
        throw new ForbiddenException();
      if (!before.allowed[input.action as keyof typeof before.allowed]) throw new ConflictException();
      if (input.reason.trim().length < 10) throw new BadRequestException();
      const classification =
        input.action === 'classify_synthetic'
          ? 'synthetic'
          : input.action === 'classify_working'
            ? 'working'
            : before.classification;
      if (input.action === 'classify_synthetic' && input.evidence.trim().length < 10)
        throw new BadRequestException();
      const state =
        input.action === 'archive'
          ? 'archived'
          : input.action === 'trash'
            ? 'trash'
            : input.action === 'restore'
              ? 'active'
              : before.state;
      await c.query(
        `INSERT INTO tender_app.tender_lifecycle(tender_id,state,classification,evidence,classified_by,classified_at,classified_content_revision,classified_ocr_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tender_id) DO UPDATE SET state=excluded.state,classification=excluded.classification,evidence=excluded.evidence,classified_by=excluded.classified_by,classified_at=excluded.classified_at,classified_content_revision=excluded.classified_content_revision,classified_ocr_hash=excluded.classified_ocr_hash,changed_at=now()`,
        [
          id,
          state,
          classification,
          input.action.startsWith('classify_') ? input.evidence.trim() : before.evidence,
          input.action.startsWith('classify_') ? actor : before.classified_by,
          input.action.startsWith('classify_') ? new Date() : before.classified_at,
          input.action.startsWith('classify_') ? before.contentRevision : before.classified_content_revision,
          input.action.startsWith('classify_') ? before.ocrHash : before.classified_ocr_hash,
        ],
      );
      const after = { state, classification };
      await c.query(
        'INSERT INTO tender_app.lifecycle_event(id,tender_id,actor_id,action,before_state,after_state,preview_hash,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          randomUUID(),
          id,
          actor,
          input.action,
          JSON.stringify(before),
          JSON.stringify(after),
          before.previewHash,
          input.reason.trim(),
        ],
      );
      await c.query(
        "INSERT INTO tender_app.audit_event(id,actor_id,tender_id,action,entity_revision,entity,entity_id) VALUES($1,$2,$3,$4,$5,'tender',$3)",
        [randomUUID(), actor, id, `tender.lifecycle.${input.action}`, before.revision],
      );
      return this.snapshot(c, actor, id);
    });
  }
}
