import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { FileStore, StoredBlob } from '../storage/file-store';
import { PgScopeRepository } from '../data/scope-repository';
import { transaction } from '../data/repository';
import { PdfTextExtractionService, PdfText } from './pdf-text.service';
import { parseTzList, ParsedDraft } from './tz-list-parser';
import { ConfirmDraftDto } from './extraction.dto';
export interface TzDraft extends ParsedDraft {
  runId: string;
  documentId: string;
  sourceSha: string;
  artifactSha: string;
  status: 'draft' | 'needs_review' | 'needs_ocr' | 'failed' | 'confirmed';
  hasText: boolean;
}
const field = 'tz.result.v1';
export class TzExtractionRepository extends PgScopeRepository {
  private static flights = new Map<string, Promise<TzDraft>>();
  async latest(actor: string, tenderId: string, documentId: string): Promise<TzDraft | null> {
    await this.original(actor, tenderId, documentId);
    const confirmed = await this.pool.query(
      "SELECT value FROM tender_app.field_decision WHERE document_id=$1 AND field_key='tz.scope.confirmed.v1' ORDER BY decided_at DESC LIMIT 1",
      [documentId],
    );
    if (confirmed.rows[0]) {
      const confirmedRun = JSON.parse(confirmed.rows[0].value).runId;
      const result = await this.pool.query(
        'SELECT value FROM tender_app.extracted_field WHERE document_id=$1 AND run_id=$2 AND field_name=$3',
        [documentId, confirmedRun, field],
      );
      if (result.rows[0]) return { ...JSON.parse(result.rows[0].value), status: 'confirmed' } as TzDraft;
    }
    const r = await this.pool.query(
      `SELECT f.value FROM tender_app.extracted_field f JOIN tender_app.extraction_run r ON r.id=f.run_id WHERE f.document_id=$1 AND f.field_name=$2 ORDER BY r.started_at DESC,r.id DESC LIMIT 1`,
      [documentId, field],
    );
    if (!r.rows[0]) return null;
    const draft = JSON.parse(r.rows[0].value) as TzDraft;
    const decisions = await this.pool.query(
      "SELECT value FROM tender_app.field_decision WHERE document_id=$1 AND field_key='tz.scope.confirmed.v1'",
      [documentId],
    );
    if (decisions.rows.some((row) => JSON.parse(row.value).runId === draft.runId)) draft.status = 'confirmed';
    return draft;
  }
  async extract(actor: string, tenderId: string, documentId: string, store: FileStore): Promise<TzDraft> {
    await this.assertWrite(actor, tenderId);
    const current = await this.latest(actor, tenderId, documentId);
    if (current?.status === 'confirmed') return current;
    const key = documentId;
    const existing = TzExtractionRepository.flights.get(key);
    if (existing) return existing;
    const flight = this.perform(actor, tenderId, documentId, store);
    TzExtractionRepository.flights.set(key, flight);
    try {
      return await flight;
    } finally {
      TzExtractionRepository.flights.delete(key);
    }
  }
  private async perform(
    actor: string,
    tenderId: string,
    documentId: string,
    store: FileStore,
  ): Promise<TzDraft> {
    const runId = randomUUID();
    const source = await transaction(this.pool, async (c) => {
      await this.lock(c, actor, tenderId);
      const tender = await c.query('SELECT scope_status FROM tender_app.tender WHERE id=$1', [tenderId]);
      if (tender.rows[0].scope_status === 'confirmed') throw new ConflictException();
      const r = await c.query(
        "SELECT d.blob_sha256 AS sha,d.revision,b.storage_key AS key,d.mime_type FROM tender_app.document d JOIN tender_app.blob b ON b.sha256=d.blob_sha256 WHERE d.id=$1 AND d.tender_id=$2 AND d.purpose='specification'",
        [documentId, tenderId],
      );
      if (!r.rows[0]) throw new NotFoundException();
      if (r.rows[0].mime_type !== 'application/pdf') throw new BadRequestException();
      await c.query(
        "INSERT INTO tender_app.extraction_run(id,document_id,model_tag,prompt_version,parser_version,status,started_at) VALUES($1,$2,'pdfjs-text-6.5.438','none','tz-list-v1','processing',now())",
        [runId, documentId],
      );
      await c.query(
        "UPDATE tender_app.document SET status='processing' WHERE id=$1 AND status<>'confirmed'",
        [documentId],
      );
      await this.audit(c, actor, tenderId, 'tz.extraction.started', r.rows[0].revision, documentId);
      return r.rows[0];
    });
    let text: PdfText;
    try {
      text = await new PdfTextExtractionService().extractText(await store.get(source.key));
    } catch {
      text = { pages: [], hasText: false, diagnostics: ['extraction_unavailable'] };
    }
    const parsed = text.hasText ? parseTzList(text.pages) : { items: [], groups: [], diagnostics: [] };
    const artifact = await store.put(
      Buffer.from(
        JSON.stringify({
          documentId,
          runId,
          sourceSha: source.sha,
          extractor: 'pdfjs-text-6.5.438',
          parser: 'tz-list-v1',
          ...text,
        }),
      ),
    );
    const draft: TzDraft = {
      ...parsed,
      runId,
      documentId,
      sourceSha: source.sha,
      artifactSha: artifact.sha256,
      hasText: text.hasText,
      status: text.diagnostics.length
        ? 'failed'
        : !text.hasText
          ? 'needs_ocr'
          : parsed.diagnostics.length
            ? 'needs_review'
            : 'draft',
      diagnostics: [...text.diagnostics, ...parsed.diagnostics],
    };
    await this.persist(actor, tenderId, draft, artifact, source.revision);
    return (await this.latest(actor, tenderId, documentId)) ?? draft;
  }
  private async persist(
    actor: string,
    tenderId: string,
    draft: TzDraft,
    artifact: StoredBlob,
    revision: number,
  ) {
    await transaction(this.pool, async (c) => {
      await this.lock(c, actor, tenderId);
      await c.query(
        'INSERT INTO tender_app.blob(sha256,storage_key,byte_size) VALUES($1,$2,$3) ON CONFLICT(sha256) DO NOTHING',
        [artifact.sha256, artifact.key, artifact.bytes],
      );
      await c.query(
        'INSERT INTO tender_app.extracted_field(id,document_id,field_name,value,confidence,extractor_version,document_revision,run_id,status,source_location) VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          draft.documentId,
          field,
          JSON.stringify(draft),
          'tz-list-v1',
          revision,
          draft.runId,
          draft.items.length ? 'found' : 'missing',
          `derived-sha256:${artifact.sha256}`,
        ],
      );
      for (const item of draft.items) {
        const evidenceId = randomUUID();
        await c.query(
          'INSERT INTO tender_app.evidence_reference(id,document_id,page,excerpt,sha256) VALUES($1,$2,$3,$4,$5)',
          [evidenceId, draft.documentId, item.page, item.excerpt.slice(0, 2000), draft.sourceSha],
        );
        await c.query(
          'INSERT INTO tender_app.extracted_field(id,document_id,field_name,value,confidence,extractor_version,document_revision,run_id,evidence_id,status) VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9)',
          [
            randomUUID(),
            draft.documentId,
            `tz.item.${item.sourceIndex}`,
            JSON.stringify(item),
            'tz-list-v1',
            revision,
            draft.runId,
            evidenceId,
            item.quantity && item.unit ? 'found' : 'ambiguous',
          ],
        );
      }
      await c.query(
        'UPDATE tender_app.extraction_run SET status=$2,completed_at=now(),error_code=$3 WHERE id=$1',
        [
          draft.runId,
          draft.status === 'failed' ? 'failed' : 'completed',
          draft.status === 'failed' ? draft.diagnostics[0] : null,
        ],
      );
      await c.query("UPDATE tender_app.document SET status=$2 WHERE id=$1 AND status<>'confirmed'", [
        draft.documentId,
        draft.status === 'failed' ? 'failed' : 'needs_review',
      ]);
      await this.audit(c, actor, tenderId, 'tz.extraction.completed', revision, draft.documentId);
    });
  }
  async confirm(actor: string, tenderId: string, documentId: string, runId: string, input: ConfirmDraftDto) {
    await transaction(this.pool, async (c) => {
      const locked = await this.lock(c, actor, tenderId);
      const data = await c.query(
        'SELECT f.id,f.value FROM tender_app.extracted_field f JOIN tender_app.document d ON d.id=f.document_id WHERE f.document_id=$1 AND f.run_id=$2 AND f.field_name=$3 AND d.tender_id=$4',
        [documentId, runId, field, tenderId],
      );
      if (!data.rows[0]) throw new NotFoundException();
      const draft = JSON.parse(data.rows[0].value) as TzDraft;
      const decisions = await c.query(
        "SELECT value FROM tender_app.field_decision WHERE document_id=$1 AND field_key='tz.scope.confirmed.v1'",
        [documentId],
      );
      const prior = decisions.rows.map((r) => JSON.parse(r.value)).find((d) => d.runId === runId);
      if (prior) {
        if (JSON.stringify(prior.items) !== JSON.stringify(input.items)) throw new ConflictException();
        return;
      }
      if (locked.revision !== input.revision) throw new ConflictException();
      const state = await c.query('SELECT scope_status FROM tender_app.tender WHERE id=$1', [tenderId]);
      const contents = await c.query(
        'SELECT 1 FROM tender_app.lot l JOIN tender_app.lot_item i ON i.lot_id=l.id WHERE l.tender_id=$1 LIMIT 1',
        [tenderId],
      );
      if (state.rows[0].scope_status === 'confirmed' || contents.rowCount) throw new ConflictException();
      if (!draft.hasText || !draft.items.length || ['failed', 'needs_ocr'].includes(draft.status))
        throw new BadRequestException();
      const ids = input.items.map((i) => i.sourceIndex);
      if (new Set(ids).size !== ids.length || ids.some((n) => !draft.items.some((i) => i.sourceIndex === n)))
        throw new BadRequestException();
      await this.replaceItems(c, actor, tenderId, input.items);
      await c.query(
        "UPDATE tender_app.tender SET scope_status='confirmed',revision=revision+1,updated_at=now() WHERE id=$1",
        [tenderId],
      );
      await c.query(
        "INSERT INTO tender_app.field_decision(id,document_id,extracted_field_id,field_key,value,source_type,source_note,decided_by) VALUES($1,$2,$3,'tz.scope.confirmed.v1',$4,'document','Confirmed by buyer from PDF draft with explicit corrections',$5)",
        [
          randomUUID(),
          documentId,
          data.rows[0].id,
          JSON.stringify({ runId, sourceSha: draft.sourceSha, items: input.items }),
          actor,
        ],
      );
      await c.query("UPDATE tender_app.document SET status='confirmed' WHERE id=$1", [documentId]);
      await this.audit(c, actor, tenderId, 'tz.scope.confirmed', locked.revision + 1, documentId);
    });
    return this.read(actor, tenderId);
  }
  async page(actor: string, tenderId: string, documentId: string, page: number, store: FileStore) {
    const draft = await this.latest(actor, tenderId, documentId);
    if (!draft) throw new NotFoundException();
    const r = await this.pool.query('SELECT storage_key FROM tender_app.blob WHERE sha256=$1', [
      draft.artifactSha,
    ]);
    if (!r.rows[0]) throw new NotFoundException();
    const artifact = JSON.parse((await store.get(r.rows[0].storage_key)).toString('utf8')) as PdfText;
    const source = artifact.pages.find((p) => p.page === page);
    if (!source) throw new NotFoundException();
    return source;
  }
}
