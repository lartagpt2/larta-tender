import { VerificationDto } from '../comparison/verification.dto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { PgScopeRepository } from '../data/scope-repository';
import { FileStore } from '../storage/file-store';
import { parseTzList } from '../extraction/tz-list-parser';
import { CreateAIDto, ReviewAIDto } from './ai.dto';
import {
  AIResult,
  LocalDocumentAI,
  emptyDraft,
  emptyField,
  fieldNames,
  promptVersion,
  schemaVersion,
} from './contracts';
import { JobStore } from './job-store';
import { documentPages } from './pages';
import { OllamaDocumentAI } from './ollama';
export interface AIOptions {
  enabled: boolean;
  storageRoot: string;
  jobRoot?: string;
  workspace: string;
  syntheticHashes: string[];
  provider?: LocalDocumentAI;
  model?: string;
  digest?: string;
  baseUrl?: string;
  timeoutMs?: number;
}
export interface AIJob {
  id: string;
  tenderId: string;
  documentId: string;
  receiptId: string | null;
  supplierId: string | null;
  lotId: string | null;
  stageId: string | null;
  kind: 'offer' | 'specification';
  sourceSha: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  status: 'pending' | 'running' | 'needs_review' | 'failed' | 'unsupported';
  revision: number;
  attempts: number;
  name: string;
  error: string | null;
  configuration: { model: string; digest: string | null };
  parserVersion: string;
  schemaVersion: string;
  promptVersion: string;
  result?: AIResult;
  matches?: { id: string; name: string; reason: string }[];
  warnings: string[];
  events: { status: string; at: string; actorId: string }[];
  reviews: {
    fields: Record<string, string | null>;
    verification?: VerificationDto;
    note: string;
    actorId: string;
    at: string;
    revision: number;
  }[];
}
export class PgAIRepository extends PgScopeRepository {
  private readonly store: JobStore<AIJob>;
  private readonly files: FileStore;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private closed = false;
  private enqueuedAt = 0;
  private enqueueTail: Promise<void> = Promise.resolve();
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.enqueueTail.then(work);
    this.enqueueTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  constructor(
    pool: Pool,
    private readonly options: AIOptions,
  ) {
    super(pool);
    this.store = new JobStore(options.jobRoot ?? options.storageRoot, options.workspace);
    this.files = new FileStore(options.storageRoot, options.workspace);
  }
  async start() {
    if (this.options.enabled) {
      this.timer = setInterval(() => this.kick(), 2000);
      this.timer.unref();
      this.kick();
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.running;
  }
  private kick() {
    if (this.closed || this.running) return;
    this.running = this.pump()
      .catch(() => undefined)
      .finally(() => {
        this.running = undefined;
      });
  }
  private async context(actor: string, id: string, input: CreateAIDto) {
    await this.read(actor, id);
    const document = (
      await this.pool.query(
        'SELECT d.id,d.purpose,d.mime_type,d.original_name,d.blob_sha256,b.storage_key FROM tender_app.document d JOIN tender_app.blob b ON b.sha256=d.blob_sha256 WHERE d.tender_id=$1 AND d.id=$2 AND d.purpose=$3',
        [id, input.documentId, input.kind],
      )
    ).rows[0];
    if (!document) throw new NotFoundException();
    let stageId: string | null = null;
    if (input.kind === 'offer') {
      if (!input.receiptId || !input.lotId) throw new BadRequestException('Receipt and lot required');
      const receipt = (
        await this.pool.query(
          "SELECT value::jsonb AS value FROM tender_app.field_decision WHERE id=$1 AND document_id=$2 AND field_key='offer.received.v1'",
          [input.receiptId, input.documentId],
        )
      ).rows[0];
      if (!receipt) throw new BadRequestException('Explicit intake required');
      stageId = receipt.value.stageId ?? null;
      if (
        !(
          await this.pool.query('SELECT 1 FROM tender_app.lot WHERE id=$1 AND tender_id=$2', [
            input.lotId,
            id,
          ])
        ).rowCount
      )
        throw new BadRequestException();
      if (
        input.supplierId &&
        !(
          await this.pool.query(
            'SELECT 1 FROM tender_app.tender_supplier WHERE tender_id=$1 AND supplier_id=$2',
            [id, input.supplierId],
          )
        ).rowCount
      )
        throw new BadRequestException();
    } else if (input.receiptId || input.lotId || input.supplierId) throw new BadRequestException();
    return { document, stageId };
  }
  async list(actor: string, id: string) {
    await this.read(actor, id);
    const jobs = [];
    for await (const job of this.store.scan()) {
      if (job.tenderId !== id) continue;
      jobs.push({
        id: job.id,
        documentId: job.documentId,
        receiptId: job.receiptId,
        supplierId: job.supplierId,
        lotId: job.lotId,
        stageId: job.stageId,
        kind: job.kind,
        name: job.name,
        status: job.status,
        revision: job.revision,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        warnings: [],
        events: [],
        reviews: [],
      });
    }
    return {
      enabled: this.options.enabled,
      syntheticOnly: true,
      jobs: jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100),
    };
  }
  async get(actor: string, id: string, jobId: string) {
    await this.read(actor, id);
    if (!/^[a-f0-9]{64}$/.test(jobId)) throw new BadRequestException();
    const job = await this.store.read(jobId);
    if (!job || job.tenderId !== id) throw new NotFoundException();
    return job;
  }
  async create(actor: string, id: string, input: CreateAIDto) {
    await this.assertWrite(actor, id);
    if (!this.options.enabled) throw new ServiceUnavailableException('Document AI disabled');
    if (!this.options.provider && !/^[a-f0-9]{64}$/.test(this.options.digest ?? ''))
      throw new ServiceUnavailableException('Pinned model digest required');
    const { document, stageId } = await this.context(actor, id, input);
    if (!this.options.syntheticHashes.includes(document.blob_sha256))
      throw new BadRequestException('Original is not on the approved synthetic SHA allowlist');
    if (input.retryOf) {
      const prior = await this.get(actor, id, input.retryOf);
      if (
        prior.documentId !== input.documentId ||
        prior.receiptId !== (input.receiptId ?? null) ||
        prior.supplierId !== (input.supplierId ?? null) ||
        prior.lotId !== (input.lotId ?? null)
      )
        throw new BadRequestException();
      if (prior.status === 'running' || prior.status === 'pending') throw new ConflictException();
    }
    const jobId = createHash('sha256')
      .update(
        JSON.stringify({
          id,
          documentId: input.documentId,
          receiptId: input.receiptId ?? null,
          supplierId: input.supplierId ?? null,
          lotId: input.lotId ?? null,
          stageId,
          sourceSha: document.blob_sha256,
          model: this.options.model ?? 'qwen3-vl:8b-instruct',
          digest: this.options.digest ?? null,
          promptVersion,
          schemaVersion,
          parserVersion: 'document-pages-v2',
          retryOf: input.retryOf ?? null,
        }),
      )
      .digest('hex');
    const replay = await this.store.read(jobId);
    if (replay) return replay;
    const release = await this.store.claim(jobId);
    if (!release) {
      const replay = await this.store.read(jobId);
      if (replay) return replay;
      throw new ConflictException();
    }
    try {
      return await this.enqueue(async () => {
        const existing = await this.store.read(jobId);
        if (existing) return existing;
        this.enqueuedAt = Math.max(Date.now(), this.enqueuedAt + 1);
        const at = new Date(this.enqueuedAt).toISOString();
        const job: AIJob = {
          id: jobId,
          tenderId: id,
          documentId: input.documentId,
          receiptId: input.receiptId ?? null,
          supplierId: input.supplierId ?? null,
          lotId: input.lotId ?? null,
          stageId,
          kind: input.kind,
          sourceSha: document.blob_sha256,
          createdBy: actor,
          createdAt: at,
          updatedAt: at,
          status: 'pending',
          revision: 1,
          attempts: 0,
          name: document.original_name,
          error: null,
          configuration: {
            model: this.options.model ?? 'qwen3-vl:8b-instruct',
            digest: this.options.digest ?? null,
          },
          parserVersion: 'document-pages-v2',
          schemaVersion,
          promptVersion,
          warnings: [],
          events: [{ status: 'pending', at, actorId: actor }],
          reviews: [],
        };
        await this.activeFence(job.tenderId, () => this.store.write(job));
        return job;
      });
    } finally {
      await release();
      this.kick();
    }
  }
  async review(actor: string, id: string, jobId: string, input: ReviewAIDto) {
    await this.assertWrite(actor, id);
    await this.get(actor, id, jobId);
    const release = await this.store.claim(jobId);
    if (!release) throw new ConflictException();
    try {
      const job = await this.get(actor, id, jobId);
      if (job.status !== 'needs_review' || job.revision !== input.revision) throw new ConflictException();
      if (
        !input.note.trim() ||
        job.reviews.length >= 100 ||
        Object.entries(input.fields).some(
          ([k, v]) =>
            !fieldNames.includes(k as (typeof fieldNames)[number]) ||
            (v !== null && (typeof v !== 'string' || v.length > 2000)),
        )
      )
        throw new BadRequestException();
      if (input.verification) {
        const v = input.verification;
        if (
          v.documentId !== job.documentId ||
          v.receiptId !== job.receiptId ||
          v.lotId !== job.lotId ||
          (job.supplierId && v.supplierId !== job.supplierId) ||
          v.intent !== 'draft'
        )
          throw new BadRequestException();
        if (
          !(
            await this.pool.query(
              'SELECT 1 FROM tender_app.tender_supplier WHERE tender_id=$1 AND supplier_id=$2',
              [id, v.supplierId],
            )
          ).rowCount
        )
          throw new BadRequestException();
      }
      const at = new Date().toISOString();
      job.revision++;
      job.updatedAt = at;
      job.reviews.push({
        fields: input.fields,
        ...(input.verification ? { verification: input.verification } : {}),
        note: input.note.trim(),
        actorId: actor,
        at,
        revision: job.revision,
      });
      await this.activeFence(job.tenderId, () => this.store.write(job));
      return job;
    } finally {
      await release();
    }
  }
  private async pump() {
    for (const pending of await this.store.pending()) {
      if (this.closed) return;
      const release = await this.store.claim(pending.id);
      if (!release) return;
      try {
        const job = await this.store.read(pending.id);
        if (!job || !['pending', 'running'].includes(job.status)) continue;
        const mark = async (status: AIJob['status']) => {
          job.status = status;
          job.updatedAt = new Date().toISOString();
          job.revision++;
          job.events.push({ status, at: job.updatedAt, actorId: job.createdBy });
          await this.activeFence(job.tenderId, () => this.store.write(job));
        };
        job.attempts++;
        await mark('running');
        try {
          if (job.attempts > 3) throw new Error('restart_attempt_limit');
          if (
            job.configuration?.model !== (this.options.model ?? 'qwen3-vl:8b-instruct') ||
            job.configuration?.digest !== (this.options.digest ?? null) ||
            job.schemaVersion !== schemaVersion ||
            job.promptVersion !== promptVersion ||
            job.parserVersion !== 'document-pages-v2'
          )
            throw new Error('ai_configuration_changed');
          const { document } = await this.context(job.createdBy, job.tenderId, {
            documentId: job.documentId,
            kind: job.kind,
            receiptId: job.receiptId ?? undefined,
            supplierId: job.supplierId ?? undefined,
            lotId: job.lotId ?? undefined,
          });
          if (document.blob_sha256 !== job.sourceSha || !this.options.syntheticHashes.includes(job.sourceSha))
            throw new Error('synthetic_policy_changed');
          const pages = await documentPages(await this.files.get(document.storage_key), document.mime_type);
          const parsed =
            job.kind === 'specification' && pages.every((p) => !p.image) ? parseTzList(pages) : null;
          if (parsed?.items.length && !parsed.diagnostics.length) {
            const draft = emptyDraft();
            draft.items = parsed.items.map((item) => {
              const f = (raw: string | null) => ({
                ...emptyField(),
                rawValue: raw,
                value: raw,
                page: item.page,
                evidenceSnippet: item.excerpt,
              });
              return {
                description: f(item.name),
                technicalRequirements: f(item.technicalRequirements),
                sku: emptyField(),
                quantity: f(item.quantity),
                unit: f(item.unit),
                unitPrice: emptyField(),
                lineTotal: emptyField(),
                currency: emptyField(),
                delivery: emptyField(),
              };
            });
            job.result = {
              draft,
              model: 'native-pdfjs-6.5.438',
              digest: null,
              warnings: ['native_text_draft_requires_review'],
              durationMs: 0,
            };
          } else {
            const provider =
              this.options.provider ??
              new OllamaDocumentAI({
                baseUrl: this.options.baseUrl ?? 'http://127.0.0.1:11434',
                model: this.options.model ?? 'qwen3-vl:8b-instruct',
                digest: this.options.digest,
                timeoutMs: this.options.timeoutMs ?? 90000,
              });
            job.result = await provider.extract(pages);
          }
          const draft = job.result.draft;
          for (const field of [
            ...fieldNames.map((k) => draft[k]),
            ...draft.items.flatMap((item) => Object.values(item)),
          ]) {
            field.sourceDocumentId = job.documentId;
            if (field.currencySource) field.currencySource.sourceDocumentId = job.documentId;
          }
          job.warnings = [...job.result.warnings];
          const suppliers = (
            await this.pool.query(
              'SELECT s.id,s.legal_name AS name,s.tax_id FROM tender_app.tender_supplier ts JOIN tender_app.supplier s ON s.id=ts.supplier_id WHERE ts.tender_id=$1',
              [job.tenderId],
            )
          ).rows;
          const tax = draft.taxId.value?.replace(/[\s-]/g, '');
          job.matches = suppliers
            .filter((s) =>
              tax
                ? s.tax_id?.replace(/[\s-]/g, '') === tax
                : draft.supplierName.value &&
                  s.name.trim().toLowerCase() === draft.supplierName.value.trim().toLowerCase(),
            )
            .map((s) => ({
              id: s.id,
              name: s.name,
              reason: tax
                ? 'Совпадение регистрационного номера — требует подтверждения'
                : 'Совпадение имени — кандидат, не подтверждение',
            }));
          if (job.kind === 'offer' && job.matches.length !== 1)
            job.warnings.push('supplier_unresolved_or_ambiguous');
          if (job.supplierId && job.matches.some((m) => m.id !== job.supplierId))
            job.warnings.push('candidate_differs_selected_supplier');
          await mark('needs_review');
        } catch (error) {
          const code = (error as Error).message;
          const allowed =
            /^(cloud_|local_ai_|model_|incomplete_ai_|invalid_ai_|ai_|document_|page_limit|text_limit|image_limit|xlsx_|unsafe_xlsx|unsupported_|synthetic_|restart_)/;
          job.error = allowed.test(code) ? code : 'document_ai_failed';
          await mark(/unsupported|xlsx_formula/.test(job.error) ? 'unsupported' : 'failed');
        }
      } finally {
        await release();
      }
    }
  }
}
export function aiOptions(): AIOptions | undefined {
  const storageRoot = process.env.STORAGE_ROOT;
  if (!storageRoot) return;
  return {
    enabled: process.env.DOCUMENT_AI_ENABLED === 'true',
    storageRoot,
    workspace: resolve(__dirname, '../../../../..'),
    syntheticHashes: (process.env.DOCUMENT_AI_SYNTHETIC_SHA256 ?? '')
      .split(',')
      .filter((x) => /^[a-f0-9]{64}$/.test(x)),
    baseUrl: process.env.OLLAMA_BASE_URL,
    model: process.env.OLLAMA_MODEL,
    digest: process.env.OLLAMA_MODEL_DIGEST,
    timeoutMs: Number(process.env.DOCUMENT_AI_TIMEOUT_MS ?? 90000),
  };
}
