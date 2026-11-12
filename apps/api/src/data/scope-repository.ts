import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { ScopeItemDto, ScopePatchDto } from '../scope.dto';
import { StoredBlob } from '../storage/file-store';
import { receiveDocument, transaction } from './repository';
export interface SpecificationDocument {
  id: string;
  name: string;
  status: string;
}
export interface TenderScope {
  id: string;
  title: string;
  revision: number;
  selectionMode: 'lot' | 'items';
  specificationSkipped: boolean;
  scopeStatus: string;
  items: (ScopeItemDto & { id: string })[];
}
const visible = `t.owner_id=$1 OR EXISTS(SELECT 1 FROM tender_app.tender_member m WHERE m.tender_id=t.id AND m.user_id=$1)`;
export class PgScopeRepository {
  constructor(protected readonly pool: Pool) {}
  protected async lock(
    c: PoolClient,
    actor: string,
    id: string,
    revision?: number,
  ): Promise<{ revision: number; selection_mode: 'lot' | 'items' }> {
    const r = await c.query(
      'SELECT owner_id,revision,selection_mode FROM tender_app.tender WHERE id=$1 FOR UPDATE',
      [id],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundException();
    if (row.owner_id !== actor) {
      const m = await c.query(
        'SELECT role FROM tender_app.tender_member WHERE tender_id=$1 AND user_id=$2 FOR SHARE',
        [id, actor],
      );
      if (!m.rows[0]) throw new NotFoundException();
      if (!['buyer', 'manager'].includes(m.rows[0].role)) throw new ForbiddenException();
    }
    await this.assertActive(c, id);
    if (revision !== undefined && row.revision !== revision) throw new ConflictException();
    return row;
  }
  protected async assertActive(c: PoolClient, id: string): Promise<boolean> {
    const installed = (
      await c.query("SELECT to_regclass('tender_app.tender_lifecycle') IS NOT NULL AS installed")
    ).rows[0].installed;
    if (!installed) {
      if (process.env.TENDER_LIFECYCLE_ENABLED === 'true') throw new ConflictException();
      return false;
    }
    const state =
      (await c.query('SELECT state FROM tender_app.tender_lifecycle WHERE tender_id=$1', [id])).rows[0]
        ?.state ?? 'active';
    if (state !== 'active') throw new ConflictException();
    return true;
  }
  protected async activeFence<T>(id: string, work: () => Promise<T>): Promise<T> {
    return transaction(this.pool, async (c) => {
      await c.query('SELECT id FROM tender_app.tender WHERE id=$1 FOR UPDATE', [id]);
      const installed = await this.assertActive(c, id);
      const result = await work();
      if (installed)
        await c.query(
          'UPDATE tender_app.tender SET content_revision=content_revision+1,dependency_revision=dependency_revision+1 WHERE id=$1',
          [id],
        );
      return result;
    });
  }
  async assertWrite(actor: string, id: string): Promise<void> {
    await transaction(this.pool, async (c) => {
      await this.lock(c, actor, id);
    });
  }
  protected async audit(
    c: PoolClient,
    actor: string,
    id: string,
    action: string,
    revision: number,
    documentId?: string,
  ) {
    await c.query(
      'INSERT INTO tender_app.audit_event(id,actor_id,tender_id,document_id,action,entity_revision,entity,entity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        randomUUID(),
        actor,
        id,
        documentId ?? null,
        action,
        revision,
        documentId ? 'document' : 'tender',
        documentId ?? id,
      ],
    );
  }
  protected async replaceItems(c: PoolClient, actor: string, id: string, items: ScopeItemDto[]) {
    const offers = await c.query('SELECT 1 FROM tender_app.offer WHERE tender_id=$1 LIMIT 1', [id]);
    if (offers.rowCount) throw new ConflictException();
    const lots = await c.query('SELECT id FROM tender_app.lot WHERE tender_id=$1 ORDER BY ordinal', [id]);
    if (lots.rows.length > 1) throw new ConflictException();
    let lot = lots.rows[0]?.id;
    if (!lot) {
      lot = randomUUID();
      await c.query(
        'INSERT INTO tender_app.lot(id,tender_id,name,ordinal,created_by) VALUES($1,$2,$3,1,$4)',
        [lot, id, 'Основной лот', actor],
      );
    }
    await c.query('DELETE FROM tender_app.lot_item WHERE lot_id=$1', [lot]);
    for (const [i, item] of items.entries())
      await c.query(
        'INSERT INTO tender_app.lot_item(id,lot_id,ordinal,item_name,quantity,unit,created_by,tech_requirements) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          randomUUID(),
          lot,
          i + 1,
          item.name.trim(),
          item.quantity,
          item.unit.trim(),
          actor,
          item.technicalRequirements ?? null,
        ],
      );
  }
  async createManual(actor: string, title: string, items: ScopeItemDto[]) {
    if (!items.length) throw new BadRequestException();
    return transaction(this.pool, async (c) => {
      const id = randomUUID();
      await c.query(
        "INSERT INTO tender_app.tender(id,title,created_by,owner_id,scope_status) VALUES($1,$2,$3,$3,'confirmed')",
        [id, title, actor],
      );
      await this.replaceItems(c, actor, id, items);
      await this.audit(c, actor, id, 'tender.created.manual', 1);
      return { id, title, revision: 1 };
    });
  }
  async read(actor: string, id: string): Promise<TenderScope> {
    const r = await this.pool.query<TenderScope>(
      `SELECT t.id,t.title,t.revision,t.selection_mode AS "selectionMode",t.specification_skipped AS "specificationSkipped",t.scope_status AS "scopeStatus",COALESCE((SELECT json_agg(json_build_object('id',i.id,'name',i.item_name,'quantity',i.quantity::text,'unit',i.unit,'technicalRequirements',i.tech_requirements) ORDER BY l.ordinal,i.ordinal) FROM tender_app.lot l JOIN tender_app.lot_item i ON i.lot_id=l.id WHERE l.tender_id=t.id),'[]'::json) AS items FROM tender_app.tender t WHERE t.id=$2 AND (${visible})`,
      [actor, id],
    );
    if (!r.rows[0]) throw new NotFoundException();
    return r.rows[0];
  }
  async save(actor: string, id: string, patch: ScopePatchDto): Promise<TenderScope> {
    await transaction(this.pool, async (c) => {
      const row = await this.lock(c, actor, id, patch.revision);
      if (patch.items !== undefined) await this.replaceItems(c, actor, id, patch.items);
      const count = await c.query(
        'SELECT 1 FROM tender_app.lot l JOIN tender_app.lot_item i ON i.lot_id=l.id WHERE l.tender_id=$1 LIMIT 1',
        [id],
      );
      const mode = patch.selectionMode ?? row.selection_mode;
      if (mode === 'items' && !count.rowCount) throw new BadRequestException();
      await c.query(
        'UPDATE tender_app.tender SET selection_mode=$2,specification_skipped=COALESCE($3,specification_skipped),scope_status=CASE WHEN $4::boolean THEN $5 ELSE scope_status END,revision=revision+1,updated_at=now() WHERE id=$1',
        [
          id,
          mode,
          patch.specificationSkipped ?? null,
          patch.items !== undefined,
          patch.items?.length ? 'confirmed' : 'title_only',
        ],
      );
      await this.audit(c, actor, id, 'tender.scope.changed', row.revision + 1);
    });
    return this.read(actor, id);
  }
  async documents(actor: string, id: string): Promise<SpecificationDocument[]> {
    await this.read(actor, id);
    return (
      await this.pool.query<SpecificationDocument>(
        `SELECT d.id,d.original_name AS name,d.status FROM tender_app.document d JOIN tender_app.tender t ON t.id=d.tender_id WHERE t.id=$2 AND d.purpose='specification' AND (${visible}) ORDER BY d.created_at,d.id LIMIT 100`,
        [actor, id],
      )
    ).rows;
  }
  async original(actor: string, id: string, documentId: string): Promise<{ name: string; key: string }> {
    const result = await this.pool.query<{ name: string; key: string }>(
      `SELECT d.original_name AS name,b.storage_key AS key FROM tender_app.document d JOIN tender_app.blob b ON b.sha256=d.blob_sha256 JOIN tender_app.tender t ON t.id=d.tender_id WHERE t.id=$2 AND d.id=$3 AND d.purpose='specification' AND (${visible})`,
      [actor, id, documentId],
    );
    if (!result.rows[0]) throw new NotFoundException();
    return result.rows[0];
  }
  async attach(
    actor: string,
    id: string,
    key: string,
    blob: StoredBlob,
    name: string,
    mime: string,
  ): Promise<SpecificationDocument> {
    return transaction(this.pool, async (c) => {
      const row = await this.lock(c, actor, id);
      const old = await c.query(
        'SELECT id FROM tender_app.document WHERE tender_id=$1 AND blob_sha256=$2 AND purpose=$3',
        [id, blob.sha256, 'specification'],
      );
      const hash = createHash('sha256')
        .update(JSON.stringify({ sha256: blob.sha256, name, mime, purpose: 'specification' }))
        .digest('hex');
      const documentId = await receiveDocument(
        c,
        id,
        key,
        hash,
        async (doc) => {
          if (old.rows[0]) return;
          await c.query(
            'INSERT INTO tender_app.blob(sha256,storage_key,byte_size) VALUES($1,$2,$3) ON CONFLICT(sha256) DO NOTHING',
            [blob.sha256, blob.key, blob.bytes],
          );
          await c.query(
            "INSERT INTO tender_app.document(id,tender_id,purpose,original_name,mime_type,blob_sha256,uploaded_by,channel,status) VALUES($1,$2,'specification',$3,$4,$5,$6,'manual','uploaded')",
            [doc, id, name, mime, blob.sha256, actor],
          );
          await c.query(
            "UPDATE tender_app.tender SET specification_skipped=false,scope_status=CASE WHEN scope_status='title_only' THEN 'draft' ELSE scope_status END,revision=revision+1,updated_at=now() WHERE id=$1",
            [id],
          );
          await this.audit(c, actor, id, 'specification.uploaded', row.revision + 1, doc);
        },
        old.rows[0]?.id,
      );
      const r = await c.query<SpecificationDocument>(
        'SELECT id,original_name AS name,status FROM tender_app.document WHERE id=$1',
        [documentId],
      );
      return r.rows[0];
    });
  }
}
export type ScopeRepository = Pick<
  PgScopeRepository,
  'createManual' | 'read' | 'save' | 'assertWrite' | 'documents' | 'original' | 'attach'
>;
