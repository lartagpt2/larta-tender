import { stagePrice, CommercialPrice } from '../stages/stage-calculation';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { PgScopeRepository } from '../data/scope-repository';
import { transaction } from '../data/repository';
import { PgOfferRepository } from '../data/offer-repository';
import { VerificationDto } from './verification.dto';
import {
  calculate,
  ComparisonRow,
  csv,
  discount,
  Fields,
  PriceSnapshot,
  ranks,
  RequiredItem,
} from './calculation';
function canonical(value: unknown): string {
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
  return JSON.stringify(value) ?? 'undefined';
}
interface Provenance {
  type: string;
  note: string;
  actorId: string;
  at: string;
}
export interface VerificationMeta extends PriceSnapshot {
  offerId: string;
  versionId: string;
  documentId: string;
  receiptId: string;
  supplierId: string;
  lotId: string;
  original: Fields;
  sources: Record<string, Provenance>;
  actorId: string;
  at: string;
}
interface Version {
  id: string;
  version: number;
  amount: string | null;
  currency: string | null;
  isInitial: boolean;
  metadata: VerificationMeta | null;
  actorName: string;
  createdAt: string;
  documentName: string;
  sha256: string;
  stage: string | null;
  stageId: string | null;
}
interface VerifiedOffer {
  id: string;
  supplierId: string;
  supplierName: string;
  lotId: string;
  status: string;
  versions: Version[];
}
export class PgVerificationRepository extends PgScopeRepository {
  constructor(pool: Pool) {
    super(pool);
  }
  private async required(c: Pool | PoolClient, lotId: string): Promise<RequiredItem[]> {
    return (
      await c.query<RequiredItem>(
        'SELECT id,item_name AS name,quantity::text,unit FROM tender_app.lot_item WHERE lot_id=$1 ORDER BY ordinal',
        [lotId],
      )
    ).rows;
  }
  async offers(actor: string, id: string): Promise<VerifiedOffer[]> {
    await this.read(actor, id);
    const offers = (
      await this.pool.query<VerifiedOffer>(
        'SELECT o.id,o.supplier_id AS "supplierId",s.legal_name AS "supplierName",o.lot_id AS "lotId",o.verification_status AS status FROM tender_app.offer o JOIN tender_app.supplier s ON s.id=o.supplier_id WHERE o.tender_id=$1 ORDER BY o.created_at,o.id',
        [id],
      )
    ).rows;
    const versions = (
      await this.pool.query<Version & { offerId: string }>(
        `SELECT v.id,v.offer_id AS "offerId",v.version,v.amount::text,v.currency,v.is_initial AS "isInitial",fd.value::jsonb AS metadata,u.display_name AS "actorName",v.created_at AS "createdAt",d.original_name AS "documentName",d.blob_sha256 AS sha256,st.label AS stage,v.stage_id AS "stageId" FROM tender_app.offer_version v JOIN tender_app.document d ON d.id=v.source_document_id JOIN tender_app.app_user u ON u.id=v.created_by LEFT JOIN tender_app.tender_stage st ON st.id=v.stage_id LEFT JOIN tender_app.field_decision fd ON fd.document_id=v.source_document_id AND fd.field_key='offer.verification.v1' AND (CASE WHEN fd.field_key='offer.verification.v1' THEN fd.value::jsonb END)->>'versionId'=v.id::text WHERE v.tender_id=$1 ORDER BY v.version`,
        [id],
      )
    ).rows;
    return offers.map((o) => ({ ...o, versions: versions.filter((v) => v.offerId === o.id) }));
  }
  async context(actor: string, id: string) {
    const scope = await this.read(actor, id),
      registry = new PgOfferRepository(this.pool);
    const lots = (
      await this.pool.query<{ id: string; name: string }>(
        'SELECT id,name FROM tender_app.lot WHERE tender_id=$1 ORDER BY ordinal',
        [id],
      )
    ).rows;
    const lotItems: Record<string, RequiredItem[]> = {};
    for (const lot of lots) lotItems[lot.id] = await this.required(this.pool, lot.id);
    return {
      scope,
      lots,
      lotItems,
      suppliers: await registry.suppliers(actor, id),
      documents: await registry.list(actor, id),
      offers: (await this.offers(actor, id)).map((o) => {
        const meta = o.versions.filter((v) => v.metadata).at(-1)?.metadata;
        return { ...o, warnings: meta ? calculate(meta, lotItems[o.lotId] ?? [], 'lot').warnings : [] };
      }),
    };
  }
  async createDefaultLot(actor: string, id: string, revision: number) {
    return transaction(this.pool, async (c) => {
      const t = await this.lock(c, actor, id, revision);
      if ((await c.query('SELECT 1 FROM tender_app.lot WHERE tender_id=$1 LIMIT 1', [id])).rowCount)
        throw new ConflictException();
      const lotId = randomUUID();
      await c.query(
        "INSERT INTO tender_app.lot(id,tender_id,name,ordinal,created_by) VALUES($1,$2,'Основной лот',1,$3)",
        [lotId, id, actor],
      );
      await c.query(
        "UPDATE tender_app.tender SET revision=revision+1,scope_status=CASE WHEN scope_status='title_only' THEN 'draft' ELSE scope_status END,updated_at=now() WHERE id=$1",
        [id],
      );
      await this.audit(c, actor, id, 'tender.lot.created', t.revision + 1);
      return { id: lotId, name: 'Основной лот', revision: t.revision + 1 };
    });
  }
  async saveVerification(actor: string, id: string, input: VerificationDto) {
    return transaction(this.pool, async (c) => {
      const tender = await this.lock(c, actor, id);
      if (
        !(
          await c.query('SELECT 1 FROM tender_app.tender_supplier WHERE tender_id=$1 AND supplier_id=$2', [
            id,
            input.supplierId,
          ])
        ).rowCount
      )
        throw new BadRequestException();
      if (
        !(await c.query('SELECT 1 FROM tender_app.lot WHERE tender_id=$1 AND id=$2', [id, input.lotId]))
          .rowCount
      )
        throw new BadRequestException();
      const document = (
        await c.query(
          "SELECT id,stage_id,batch_id FROM tender_app.document d WHERE tender_id=$1 AND id=$2 AND purpose='offer' AND (NOT EXISTS(SELECT 1 FROM tender_app.field_decision role WHERE role.document_id=d.id AND role.field_key='accreditation.file.v1') OR EXISTS(SELECT 1 FROM tender_app.field_decision rr WHERE rr.document_id=d.id AND rr.field_key='offer.received.v1'))",
          [id, input.documentId],
        )
      ).rows[0];
      if (!document) throw new NotFoundException();
      const receipt = (
        await c.query(
          "SELECT value::jsonb AS value FROM tender_app.field_decision WHERE id=$1 AND document_id=$2 AND field_key='offer.received.v1'",
          [input.receiptId, input.documentId],
        )
      ).rows[0];
      // A legacy original can stand for its one known first intake, but only until explicit receipts exist.
      const legacy =
        input.receiptId === input.documentId &&
        !(
          await c.query(
            "SELECT 1 FROM tender_app.field_decision WHERE document_id=$1 AND field_key='offer.received.v1' LIMIT 1",
            [input.documentId],
          )
        ).rowCount;
      if (!receipt && !legacy) throw new BadRequestException();
      const stageId = receipt ? (receipt.value.stageId ?? null) : (document.stage_id ?? null);
      if (
        stageId &&
        !(await c.query('SELECT 1 FROM tender_app.tender_stage WHERE tender_id=$1 AND id=$2', [id, stageId]))
          .rowCount
      )
        throw new BadRequestException();
      const required = await this.required(c, input.lotId);
      if (
        new Set(input.items.map((i) => i.lotItemId)).size !== input.items.length ||
        input.items.some((i) => !required.some((r) => r.id === i.lotItemId))
      )
        throw new BadRequestException();
      if (
        input.costs.some(
          (cost) => cost.treatment !== 'unknown' && (cost.amount === null || cost.currency === null),
        )
      )
        throw new BadRequestException();
      if (
        input.intent === 'confirm' &&
        (!input.fields.currency ||
          !input.fields.paymentTerms?.trim() ||
          !input.fields.deliveryTerms?.trim() ||
          (!required.length && input.fields.amount === null))
      )
        throw new BadRequestException('Mandatory commercial fields missing');
      const existing = (
        await c.query(
          'SELECT id,offer_package_id FROM tender_app.offer WHERE tender_id=$1 AND supplier_id=$2 AND lot_id=$3 FOR UPDATE',
          [id, input.supplierId, input.lotId],
        )
      ).rows[0];
      const latest = existing
        ? (
            await c.query(
              'SELECT id,version FROM tender_app.offer_version WHERE offer_id=$1 ORDER BY version DESC LIMIT 1',
              [existing.id],
            )
          ).rows[0]
        : undefined;
      if ((latest?.version ?? 0) !== input.expectedVersion) throw new ConflictException();
      const previous: VerificationMeta | undefined = latest
        ? (
            await c.query(
              "SELECT value::jsonb AS value FROM tender_app.field_decision WHERE document_id IN (SELECT source_document_id FROM tender_app.offer_version WHERE id=$1) AND field_key='offer.verification.v1' AND (CASE WHEN field_key='offer.verification.v1' THEN value::jsonb END)->>'versionId'=$1::text",
              [latest.id],
            )
          ).rows[0]?.value
        : undefined;
      if (existing && !previous)
        throw new ConflictException('Legacy offer requires explicit migration review');
      if (!existing && !input.original) throw new BadRequestException('Original transcription required');
      if (previous && input.original && canonical(input.original) !== canonical(previous.original))
        throw new ConflictException('Original transcription is immutable');
      const original = previous?.original ?? input.original!;
      const questions = (previous?.questions ?? []).map((q) => ({ ...q }));
      if (
        new Set(input.resolveQuestionIds).size !== input.resolveQuestionIds.length ||
        input.resolveQuestionIds.some((qid) => !questions.some((q) => q.id === qid && !q.resolved))
      )
        throw new BadRequestException();
      for (const q of questions) if (input.resolveQuestionIds.includes(q.id)) q.resolved = true;
      for (const text of input.newQuestions)
        questions.push({ id: randomUUID(), text: text.trim(), resolved: false });
      if (questions.length > 100) throw new BadRequestException();
      const at = new Date().toISOString(),
        offerId = existing?.id ?? randomUUID(),
        packageId = existing?.offer_package_id ?? randomUUID();
      if (!existing) {
        await c.query('INSERT INTO tender_app.offer_package(id,tender_id,supplier_id) VALUES($1,$2,$3)', [
          packageId,
          id,
          input.supplierId,
        ]);
        await c.query(
          'INSERT INTO tender_app.offer(id,tender_id,supplier_id,lot_id,offer_package_id,created_by) VALUES($1,$2,$3,$4,$5,$6)',
          [offerId, id, input.supplierId, input.lotId, packageId, actor],
        );
      }
      const writeVersion = async (fields: Fields, version: number, isInitial: boolean) => {
        const versionId = randomUUID();
        await c.query(
          `INSERT INTO tender_app.offer_version(id,offer_package_id,version,created_by,offer_id,lot_id,tender_id,stage_id,amount,currency,vat_mode,payment_terms,delivery_terms,is_initial,source_document_id,submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())`,
          [
            versionId,
            packageId,
            version,
            actor,
            offerId,
            input.lotId,
            id,
            stageId,
            fields.amount,
            fields.currency,
            fields.vatMode,
            fields.paymentTerms,
            fields.deliveryTerms,
            isInitial,
            input.documentId,
          ],
        );
        return versionId;
      };
      if (!existing) await writeVersion(original, 1, true);
      const version = (latest?.version ?? 1) + 1,
        fields = { ...input.fields, ...(required.length ? { amount: null } : {}) };
      const versionId = await writeVersion(fields, version, false);
      const snapshot = {
        fields,
        items: input.items,
        costs: input.costs,
        costsEnabled: input.costsEnabled,
        intent: input.intent,
        questions,
      };
      const sources = { ...(previous?.sources ?? {}) };
      const changed: Record<string, unknown> = {
        ...fields,
        items: input.items,
        costs: input.costs,
        costsEnabled: input.costsEnabled,
      };
      const prior: Record<string, unknown> = {
        ...previous?.fields,
        items: previous?.items,
        costs: previous?.costs,
        costsEnabled: previous?.costsEnabled,
      };
      for (const [key, value] of Object.entries(changed))
        if (!previous || canonical(value) !== canonical(prior[key]))
          sources[key] = { type: input.sourceType, note: input.sourceNote.trim(), actorId: actor, at };
      const meta: VerificationMeta = {
        ...snapshot,
        offerId,
        versionId,
        documentId: input.documentId,
        receiptId: input.receiptId,
        supplierId: input.supplierId,
        lotId: input.lotId,
        original,
        sources,
        actorId: actor,
        at,
      };
      const result = calculate(meta, required, 'lot');
      for (const item of input.items)
        await c.query(
          'INSERT INTO tender_app.offer_item(id,offer_version_id,lot_item_id,lot_id,quantity,unit_price,currency) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            randomUUID(),
            versionId,
            item.lotItemId,
            input.lotId,
            item.quantity,
            item.unitPrice,
            fields.currency,
          ],
        );
      for (const cost of input.costs)
        await c.query(
          'INSERT INTO tender_app.cost_component(id,offer_version_id,name,amount,currency,treatment,source,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            randomUUID(),
            versionId,
            cost.name.trim(),
            cost.amount,
            cost.currency,
            cost.treatment,
            (sources.costs?.type ?? input.sourceType) +
              ': ' +
              (sources.costs?.note ?? input.sourceNote.trim()),
            actor,
          ],
        );
      await c.query(
        `INSERT INTO tender_app.field_decision(id,document_id,field_key,value,source_type,source_note,decided_by) VALUES($1,$2,'offer.verification.v1',$3,$4,$5,$6)`,
        [
          randomUUID(),
          input.documentId,
          JSON.stringify(meta),
          input.sourceType,
          input.sourceNote.trim(),
          actor,
        ],
      );
      await c.query('UPDATE tender_app.offer SET verification_status=$2 WHERE id=$1', [
        offerId,
        result.warnings.length ? 'needs_review' : 'confirmed',
      ]);
      await c.query('UPDATE tender_app.tender SET revision=revision+1,updated_at=now() WHERE id=$1', [id]);
      await c.query(
        `INSERT INTO tender_app.audit_event(id,actor_id,tender_id,document_id,action,entity_revision,entity,entity_id) VALUES($1,$2,$3,$4,'offer.fields.saved',$5,'offer_version',$6)`,
        [randomUUID(), actor, id, input.documentId, version, versionId],
      );
      return {
        offerId,
        versionId,
        version,
        status: result.warnings.length ? 'needs_review' : 'confirmed',
        warnings: result.warnings,
        tenderRevision: tender.revision + 1,
      };
    });
  }
  async comparison(actor: string, id: string, lotId?: string, mode?: 'lot' | 'items', itemId?: string) {
    const scope = await this.read(actor, id);
    const lots = (
      await this.pool.query<{ id: string; name: string }>(
        'SELECT id,name FROM tender_app.lot WHERE tender_id=$1 ORDER BY ordinal',
        [id],
      )
    ).rows;
    const chosen = lotId ? lots.find((l) => l.id === lotId) : lots[0];
    if (lotId && !chosen) throw new BadRequestException();
    const required = chosen ? await this.required(this.pool, chosen.id) : [];
    const selectedMode = mode ?? scope.selectionMode;
    if (selectedMode === 'items' && !required.length) throw new BadRequestException();
    const selectedItem = itemId ?? required[0]?.id;
    if (itemId && !required.some((i) => i.id === itemId)) throw new BadRequestException();
    const offers = (await this.offers(actor, id)).filter(
      (o) => o.lotId === chosen?.id && o.versions.some((v) => v.metadata),
    );
    const stages = (
      await this.pool.query<{ id: string; label: string; ordinal: number }>(
        'SELECT id,label,ordinal FROM tender_app.tender_stage WHERE tender_id=$1 ORDER BY ordinal',
        [id],
      )
    ).rows;
    const responses = (
      await this.pool.query<{
        stage_id: string;
        offer_id: string;
        response_status: 'received' | 'no_reply' | 'withdrawn';
        offer_version_id: string | null;
      }>(
        'SELECT stage_id,offer_id,response_status,offer_version_id FROM tender_app.stage_response WHERE tender_id=$1',
        [id],
      )
    ).rows;
    const baselines = (
      await this.pool.query<{ value: { offerId: string; versionId: string; stageId: string } }>(
        `SELECT fd.value::jsonb AS value FROM tender_app.field_decision fd JOIN tender_app.document d ON d.id=fd.document_id WHERE d.tender_id=$1 AND fd.field_key='stage.baseline.v1'`,
        [id],
      )
    ).rows;
    const current = offers.map((o) => {
      if (!stages.length) return o.versions.filter((v) => v.metadata).at(-1)!;
      const baselineId = baselines.find((b) => b.value.offerId === o.id)?.value.versionId;
      let version = o.versions.find((v) => v.id === baselineId && v.metadata);
      for (const stage of stages) {
        const response = responses.find((r) => r.stage_id === stage.id && r.offer_id === o.id);
        if (response?.response_status === 'received')
          version = o.versions.find((v) => v.id === response.offer_version_id && v.metadata);
      }
      // An unregistered technical snapshot is visible for review but never treated as a confirmed commercial baseline.
      return version ?? o.versions.filter((v) => v.metadata).at(-1)!;
    });
    const results = current.map((v) => calculate(v.metadata!, required, selectedMode, selectedItem));
    if (stages.length)
      for (let i = 0; i < offers.length; i++) {
        const registered =
          baselines.some((b) => b.value.offerId === offers[i].id) ||
          responses.some((r) => r.offer_id === offers[i].id && r.response_status === 'received');
        const lastResponse = [...stages]
          .reverse()
          .map((s) => responses.find((r) => r.stage_id === s.id && r.offer_id === offers[i].id))
          .find((r) => r && r.response_status !== 'no_reply');
        if (!registered || lastResponse?.response_status === 'withdrawn') {
          results[i] = {
            ...results[i],
            base: null,
            comparable: null,
            rankable: false,
            warnings: [
              ...results[i].warnings,
              {
                code: 'commercial_price_missing',
                message: 'Нет действующей подтверждённой коммерческой цены',
              },
            ],
          };
        }
      }
    const places = ranks(
      results.map((r, i) => ({
        value: r.comparable,
        rankable: r.rankable,
        currency: current[i].metadata!.fields.currency,
        vatMode: current[i].metadata!.fields.vatMode,
      })),
    );
    const reports = (
      await this.pool.query<{ supplier_id: string; status: string }>(
        `SELECT DISTINCT ON (a.supplier_id) a.supplier_id,a.status FROM tender_app.accreditation_report a JOIN tender_app.document d ON d.id=a.document_id AND d.tender_id=a.tender_id WHERE a.tender_id=$1 ORDER BY a.supplier_id,a.assessed_at DESC,a.created_at DESC,a.id`,
        [id],
      )
    ).rows;
    const accreditationLabels: Record<string, string> = {
      passed: 'Аккредитован',
      conditional: 'Условно',
      pending: 'На проверке',
      failed: 'Не пройдена',
      no_conclusion: 'Нет заключения',
    };
    const labels = { included: 'Включён', excluded: 'Без НДС', unknown: 'Не уточнён' };
    const fieldLabels: Record<string, string> = {
      amount: 'Цена',
      currency: 'Валюта',
      vatMode: 'НДС',
      paymentTerms: 'Оплата',
      deliveryTerms: 'Срок поставки',
      compliance: 'Соответствие ТЗ',
      items: 'Позиции',
      costs: 'Расходы',
      costsEnabled: 'Учёт расходов',
    };
    const sourceLabels: Record<string, string> = {
      document: 'Документ',
      phone: 'Телефон',
      email: 'Письмо',
      other: 'Другое',
    };
    const rows: ComparisonRow[] = [];
    const add = (key: string, label: string, values: string[], tone?: string) =>
      rows.push({ key, label, values, ...(tone ? { tone } : {}) });
    const display = (amount: string | null, currency: string | null) =>
      amount === null ? 'Не определено' : amount + ' ' + (currency ?? 'Валюта не указана');
    add(
      'original',
      'Цена исходная (документ)',
      offers.map((o) => {
        const initial = o.versions.find((v) => v.isInitial);
        return display(initial?.amount ?? null, initial?.currency ?? null);
      }),
    );
    add(
      'current',
      'Цена актуальная',
      results.map((r, i) => display(r.base, current[i].metadata!.fields.currency)),
    );
    add(
      'currency',
      'Валюта',
      current.map((v) => v.metadata!.fields.currency ?? 'Не указана'),
    );
    add(
      'vat',
      'НДС',
      current.map((v) => labels[v.metadata!.fields.vatMode as keyof typeof labels]),
    );
    add(
      'payment',
      'Оплата',
      current.map((v) => v.metadata!.fields.paymentTerms ?? 'Не указана'),
    );
    add(
      'delivery',
      'Срок поставки',
      current.map((v) => v.metadata!.fields.deliveryTerms ?? 'Не указан'),
    );
    add(
      'compliance',
      'Соответствие ТЗ',
      current.map((v) =>
        v.metadata!.fields.compliance === 'matches'
          ? 'Соответствует'
          : v.metadata!.fields.compliance === 'partial'
            ? 'Частично'
            : 'Не уточнено',
      ),
    );
    add(
      'accreditation',
      'Аккредитация',
      offers.map((o) => {
        const report = reports.find((r) => r.supplier_id === o.supplierId);
        return report ? accreditationLabels[report.status] : 'Нет проверки';
      }),
      'danger',
    );
    add(
      'costs',
      'Дополнительные расходы',
      current.map((v) => {
        const m = v.metadata!;
        return (
          (m.costsEnabled ? 'Учёт включён: ' : 'Учёт выключен: ') +
          (m.costs.length
            ? m.costs
                .map(
                  (c) =>
                    `${c.name}: ${display(c.amount, c.currency)} (${c.treatment === 'add' ? 'добавить' : c.treatment === 'included' ? 'включено' : 'не уточнено'})`,
                )
                .join('; ')
            : 'не заданы')
        );
      }),
    );
    add(
      'comparable',
      'Сопоставимая стоимость',
      results.map((r, i) => display(r.comparable, current[i].metadata!.fields.currency)),
    );
    add(
      'rank',
      'Место',
      places.map((p) => (p === null ? 'Не ранжируется' : String(p))),
    );
    if (selectedMode === 'items')
      for (const item of required) {
        const lines = current.map((v) => calculate(v.metadata!, required, 'items', item.id));
        add(
          'item:' + item.id,
          item.name + ' · стоимость',
          lines.map((r, i) => display(r.base, current[i].metadata!.fields.currency)),
        );
      }
    if (stages.length) {
      const chains = offers.map((o) => {
        const baselineId = baselines.find((b) => b.value.offerId === o.id)?.value.versionId;
        const baseline = o.versions.find((v) => v.id === baselineId)?.metadata;
        const startingPrice: CommercialPrice | null = baseline
          ? {
              amount: calculate(baseline, required, selectedMode, selectedItem).comparable,
              currency: baseline.fields.currency,
              vatMode: baseline.fields.vatMode,
            }
          : null;
        let previous: CommercialPrice | null = null;
        return stages.map((stage) => {
          if (stage.id === baselines.find((b) => b.value.offerId === o.id)?.value.stageId)
            previous = startingPrice;
          const response = responses.find((r) => r.stage_id === stage.id && r.offer_id === o.id);
          const version = o.versions.find((v) => v.id === response?.offer_version_id);
          const m = version?.metadata;
          const next = stagePrice(previous, {
            status: response?.response_status ?? 'pending',
            price: m
              ? {
                  amount: calculate(m, required, selectedMode, selectedItem).comparable,
                  currency: m.fields.currency,
                  vatMode: m.fields.vatMode,
                }
              : undefined,
          });
          previous = next.current;
          const original = current[offers.indexOf(o)].metadata!.original;
          const overall =
            next.current &&
            next.current.currency === original.currency &&
            next.current.vatMode === original.vatMode
              ? discount(selectedMode === 'lot' ? original.amount : null, next.current.amount)
              : null;
          return { ...next, overall, version: version?.version };
        });
      });
      for (let n = 0; n < stages.length; n++) {
        const stage = stages[n],
          label = `Этап ${stage.ordinal}: ${stage.label}`;
        add(
          'stage:' + stage.id,
          label + ' · цена',
          chains.map((c) =>
            c[n].current ? display(c[n].current!.amount, c[n].current!.currency) : 'Не определено',
          ),
        );
        add(
          'stage_discount:' + stage.id,
          label + ' · скидка, %',
          chains.map((c) => c[n].discount ?? 'Не определено'),
        );
        add(
          'stage_overall:' + stage.id,
          label + ' · общее снижение, %',
          chains.map((c) => c[n].overall ?? 'Не определено'),
        );
        const statuses = {
          received: 'Ответ получен',
          no_reply: 'Нет ответа — сохранена предыдущая цена',
          withdrawn: 'Предложение отозвано',
          pending: 'Ответ ещё не зафиксирован',
        };
        add(
          'stage_response:' + stage.id,
          label + ' · ответ',
          chains.map(
            (c) => statuses[c[n].status] + (c[n].version ? ' · техническая версия ' + c[n].version : ''),
          ),
        );
      }
    }
    for (const version of [
      ...new Set(offers.flatMap((o) => o.versions.filter((v) => !v.isInitial).map((v) => v.version))),
    ].sort((a, b) => a - b)) {
      add(
        'version:' + version,
        'Техническое сохранение ' + version,
        offers.map((o) => {
          const v = o.versions.find((v) => v.version === version);
          if (!v?.metadata) return 'Нет версии';
          const r = calculate(v.metadata, required, 'lot');
          return (
            display(r.comparable, v.metadata.fields.currency) +
            (v.metadata.intent === 'draft' ? ' · черновик' : '') +
            (v.stage ? ' · ' + v.stage : '')
          );
        }),
      );
      add(
        'discount:' + version,
        'Изменение между сохранениями ' + version + ', %',
        offers.map((o) => {
          const v = o.versions.find((v) => v.version === version);
          if (!v?.metadata || !calculate(v.metadata, required, 'lot').rankable) return 'Не определено';
          const previous = o.versions
            .filter(
              (x) => x.version < version && x.metadata && calculate(x.metadata, required, 'lot').rankable,
            )
            .at(-1);
          const initial = o.versions.find((x) => x.isInitial);
          const previousPrice = previous
            ? calculate(previous.metadata!, required, 'lot').comparable
            : (initial?.amount ?? null);
          const sameBasis = previous
            ? previous.metadata!.fields.currency === v.metadata.fields.currency &&
              previous.metadata!.fields.vatMode === v.metadata.fields.vatMode
            : initial?.currency === v.metadata.fields.currency &&
              v.metadata.original.vatMode === v.metadata.fields.vatMode;
          return (
            (sameBasis ? discount(previousPrice, calculate(v.metadata, required, 'lot').comparable) : null) ??
            'Не определено'
          );
        }),
      );
    }
    add(
      'overall_discount',
      'Общее снижение, %',
      offers.map((o, i) => {
        const original = current[i].metadata!.original,
          now = current[i].metadata!;
        return original.currency === now.fields.currency &&
          original.vatMode === now.fields.vatMode &&
          results[i].rankable
          ? (discount(original.amount, calculate(now, required, 'lot').comparable) ?? 'Не определено')
          : 'Не определено';
      }),
    );
    add(
      'questions',
      'Открытые вопросы',
      results.map((r) => r.warnings.map((w) => w.message).join('; ') || 'Нет'),
    );
    add(
      'status',
      'Проверка',
      results.map((r) => (r.warnings.length ? 'Есть вопросы / Требует проверки' : 'Проверено')),
    );
    add(
      'source',
      'Источники подтверждённых полей',
      current.map((v) =>
        Object.entries(v.metadata!.sources)
          .map(
            ([field, s]) =>
              `${fieldLabels[field] ?? field}: ${sourceLabels[s.type]} · ${s.note} · ${s.actorId} · ${s.at}`,
          )
          .join('; '),
      ),
    );
    add(
      'actor',
      'Подтвердил / дата',
      current.map((v) => `${v.actorName} · ${v.metadata!.actorId} · ${v.metadata!.at}`),
    );
    add(
      'context',
      'Поставщик / лот / поступление',
      current.map((v) => `${v.metadata!.supplierId} / ${v.metadata!.lotId} / ${v.metadata!.receiptId}`),
    );
    add(
      'document',
      'Оригинал / SHA-256',
      current.map((v) => `${v.documentName} · ${v.sha256}`),
    );
    const basis = new Set(current.map((v) => `${v.metadata!.fields.currency}:${v.metadata!.fields.vatMode}`));
    return {
      tenderId: id,
      title: scope.title,
      revision: scope.revision,
      lotId: chosen?.id ?? null,
      lots,
      mode: selectedMode,
      itemId: selectedItem ?? null,
      items: required,
      columns: offers.map((o) => ({ offerId: o.id, supplierId: o.supplierId, name: o.supplierName })),
      rows,
      warnings: [
        ...(basis.size > 1 ? ['Разные валюты или базы НДС: общего рейтинга нет.'] : []),
        ...(!chosen ? ['Сначала задайте лот в составе закупки.'] : []),
      ],
    };
  }
  async export(actor: string, id: string, lotId?: string, mode?: 'lot' | 'items', itemId?: string) {
    const model = await this.comparison(actor, id, lotId, mode, itemId);
    return csv(
      model.rows,
      model.columns.map((c) => c.name),
    );
  }
}
