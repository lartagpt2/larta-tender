// TASK-009A audit ONLY. No API mutations, DDL, DML, model calls, file removal or lifecycle changes.
import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { repo, workspace, checked, save, json } from '../task008-gate-d/io.mjs';
config({ path: resolve(repo, '.env'), quiet: true });
assert.equal(process.env.PGDATABASE, 'larta_test_task003', 'Only the configured approved test DB');
assert.ok(['localhost', '127.0.0.1'].includes(process.env.PGHOST));
assert.equal(process.env.PGPORT ?? '5432', '5432');
const qid = (s) => {
  assert.match(s, /^[a-z_][a-z_0-9]*$/);
  return '"' + s + '"';
};
const at = new Date().toISOString(),
  out = resolve(repo, 'docs/inventory/TASK-009A');
const client = new pg.Client({
  connectionTimeoutMillis: 5000,
  statement_timeout: 20000,
  application_name: 'task009a_readonly_inventory',
  options: '-c default_transaction_read_only=on',
});
const data = { at, database: process.env.PGDATABASE, host: process.env.PGHOST, port: 5432, readOnly: true };
let tenders, documents, blobs, artifactRefs;
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  data.snapshot = (
    await client.query(
      'SELECT now() AS at,current_database() AS database,txid_current_snapshot()::text AS snapshot',
    )
  ).rows[0];
  data.transactionReadOnly = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
  assert.equal(data.transactionReadOnly, 'on');
  tenders = (
    await client.query(
      'SELECT id,title,created_at,updated_at,revision,created_by,owner_id,scope_status FROM tender_app.tender ORDER BY created_at,id',
    )
  ).rows;
  documents = (
    await client.query(
      'SELECT id,tender_id,blob_sha256::text,original_name,purpose,status,parent_document_id FROM tender_app.document',
    )
  ).rows;
  blobs = (await client.query('SELECT sha256::text,storage_key,byte_size::text FROM tender_app.blob')).rows;
  const columns = (
    await client.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='tender_app' ORDER BY table_name,ordinal_position",
    )
  ).rows;
  data.tenderColumns = columns.filter((c) => c.table_name === 'tender').map((c) => c.column_name);
  const direct = [...new Set(columns.filter((c) => c.column_name === 'tender_id').map((c) => c.table_name))];
  const related = new Map(tenders.map((t) => [t.id, {}]));
  for (const table of direct) {
    const rows = (
      await client.query(
        `SELECT tender_id,count(*)::int AS count FROM tender_app.${qid(table)} GROUP BY tender_id`,
      )
    ).rows;
    for (const r of rows) if (related.has(r.tender_id)) related.get(r.tender_id)[table] = r.count;
  }
  const joins = {
    lot_item: 'JOIN tender_app.lot p ON p.id=x.lot_id',
    extracted_field: 'JOIN tender_app.document p ON p.id=x.document_id',
    extraction_run: 'JOIN tender_app.document p ON p.id=x.document_id',
    evidence_reference: 'JOIN tender_app.document p ON p.id=x.document_id',
    field_decision: 'JOIN tender_app.document p ON p.id=x.document_id',
    offer_item: 'JOIN tender_app.offer_version p ON p.id=x.offer_version_id',
    cost_component: 'JOIN tender_app.offer_version p ON p.id=x.offer_version_id',
    comparison_offer: 'JOIN tender_app.comparison p ON p.id=x.comparison_id',
  };
  for (const [table, join] of Object.entries(joins)) {
    const rows = (
      await client.query(
        `SELECT p.tender_id,count(*)::int AS count FROM tender_app.${qid(table)} x ${join} GROUP BY p.tender_id`,
      )
    ).rows;
    for (const r of rows) if (related.has(r.tender_id)) related.get(r.tender_id)[table] = r.count;
  }
  const allTables = [...new Set(columns.map((c) => c.table_name))],
    global = ['app_user', 'supplier', 'blob', 'schema_migrations'];
  data.unmappedTables = allTables.filter(
    (t) => t !== 'tender' && !direct.includes(t) && !joins[t] && !global.includes(t),
  );
  const receipts = (
    await client.query(
      "SELECT d.tender_id,count(*)::int count FROM tender_app.field_decision f JOIN tender_app.document d ON d.id=f.document_id WHERE f.field_key='offer.received.v1' GROUP BY d.tender_id",
    )
  ).rows;
  const confirmations = (
    await client.query(
      "SELECT tender_id,count(*)::int count FROM tender_app.offer WHERE verification_status='confirmed' GROUP BY tender_id",
    )
  ).rows;
  const accreditation = (
    await client.query(
      "SELECT d.tender_id,count(*)::int count FROM tender_app.field_decision f JOIN tender_app.document d ON d.id=f.document_id WHERE f.field_key='accreditation.file.v1' GROUP BY d.tender_id",
    )
  ).rows;
  const extractionStates = (
    await client.query(
      'SELECT d.tender_id,r.status,count(*)::int AS count FROM tender_app.extraction_run r JOIN tender_app.document d ON d.id=r.document_id GROUP BY d.tender_id,r.status',
    )
  ).rows;
  for (const t of tenders) {
    t.related = related.get(t.id);
    t.dbExtractionStates = Object.fromEntries(
      extractionStates.filter((r) => r.tender_id === t.id).map((r) => [r.status, r.count]),
    );
    t.receivedEvents = receipts.find((r) => r.tender_id === t.id)?.count ?? 0;
    t.confirmedOffers = confirmations.find((r) => r.tender_id === t.id)?.count ?? 0;
    t.accreditationFileEvents = accreditation.find((r) => r.tender_id === t.id)?.count ?? 0;
  }
  const fk = (
    await client.query(`SELECT c.conname,ns.nspname AS child_schema,cl.relname AS child_table,ps.nspname AS parent_schema,pl.relname AS parent_table,c.confdeltype,c.convalidated,c.condeferrable,pg_get_constraintdef(c.oid) AS definition,
 ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,pos) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.pos) AS child_columns,
 ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,pos) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.pos) AS parent_columns
 FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace JOIN pg_class pl ON pl.oid=c.confrelid JOIN pg_namespace ps ON ps.oid=pl.relnamespace
 WHERE c.contype='f' AND (ns.nspname='tender_app' OR ps.nspname='tender_app') ORDER BY ns.nspname,cl.relname,c.conname`)
  ).rows;
  for (const f of fk) {
    if (f.child_schema !== 'tender_app' || f.parent_schema !== 'tender_app') {
      f.orphans = null;
      continue;
    }
    const on = f.child_columns.map((c, i) => `c.${qid(c)}=p.${qid(f.parent_columns[i])}`).join(' AND '),
      present = f.child_columns.map((c) => `c.${qid(c)} IS NOT NULL`).join(' AND ');
    f.orphans = Number(
      (
        await client.query(
          `SELECT count(*) AS count FROM tender_app.${qid(f.child_table)} c LEFT JOIN tender_app.${qid(f.parent_table)} p ON ${on} WHERE ${present} AND p.${qid(f.parent_columns[0])} IS NULL`,
        )
      ).rows[0].count,
    );
  }
  data.foreignKeys = fk;
  data.triggers = (
    await client.query(
      "SELECT c.relname AS table_name,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='tender_app' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname",
    )
  ).rows;
  data.crossTenderReferences = {
    comparisons: Number(
      (
        await client.query(
          'SELECT count(*) count FROM tender_app.comparison_offer x JOIN tender_app.comparison c ON c.id=x.comparison_id JOIN tender_app.offer_version v ON v.id=x.offer_version_id WHERE c.tender_id<>v.tender_id',
        )
      ).rows[0].count,
    ),
    audits: Number(
      (
        await client.query(
          'SELECT count(*) count FROM tender_app.audit_event a JOIN tender_app.document d ON d.id=a.document_id WHERE a.tender_id<>d.tender_id',
        )
      ).rows[0].count,
    ),
  };
  artifactRefs = (
    await client.query(
      "SELECT d.tender_id,f.document_id,f.value FROM tender_app.extracted_field f JOIN tender_app.document d ON d.id=f.document_id WHERE f.field_name='tz.result.v1'",
    )
  ).rows.flatMap((r) => {
    try {
      const x = JSON.parse(r.value);
      return /^[a-f0-9]{64}$/.test(x.artifactSha)
        ? [{ tenderId: r.tender_id, documentId: r.document_id, sha256: x.artifactSha }]
        : [];
    } catch {
      return [];
    }
  });
  await client.query('ROLLBACK');
} catch (e) {
  console.error(
    JSON.stringify({
      inventoryFailed: true,
      code: e.code ?? e.name,
      detail: e instanceof TypeError ? e.message : undefined,
      message: 'Read-only inventory could not complete; no cleanup attempted',
    }),
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
if (process.exitCode) process.exit(process.exitCode);
// Only explicitly known project OCR roots; never inspect dependency caches or follow links.
const roots = [
  resolve(process.env.STORAGE_ROOT),
  ...[
    'task008',
    'task008-e2e',
    'task008-gate-d',
    'task008-integration',
    'task008-tests',
    'task008e',
    'task008f',
    'task008g',
    'storage',
  ].map((p) => resolve(workspace, 'temp', p)),
];
const jobs = new Map(),
  submissions = new Map(),
  fsIssues = [];
let visited = 0;
const rel = (p) => relative(workspace, p).replaceAll('\\', '/');
async function walk(root) {
  try {
    await checked(root);
    const stat = await lstat(root);
    if (!stat.isDirectory()) return;
  } catch (e) {
    if (e.code === 'ENOENT') return;
    fsIssues.push({ path: rel(root), error: 'unsafe_or_unreadable_root' });
    return;
  }
  if (++visited > 20000) throw Error('bounded_inventory_limit');
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.isSymbolicLink()) {
      fsIssues.push({ path: rel(resolve(root, e.name)), error: 'link_not_followed' });
      continue;
    }
    const p = await checked(resolve(root, e.name));
    if (e.isDirectory()) {
      if (['frozen-production', 'node_modules', 'frozen-code'].includes(e.name)) continue;
      await walk(p);
      continue;
    }
    if (!e.isFile()) continue;
    const canonical = /[\\/]document-ai[\\/][a-f0-9]{64}\.json$/.test(p),
      submission = e.name === 'submission.json';
    if (!canonical && !submission) continue;
    if ((await lstat(p)).size > 4 * 1024 * 1024) {
      fsIssues.push({ path: rel(p), error: 'json_too_large' });
      continue;
    }
    try {
      const x = JSON.parse(await readFile(p, 'utf8'));
      if (canonical && typeof x.tenderId === 'string' && /^[a-f0-9]{64}$/.test(x.id)) {
        if (x.id !== e.name.slice(0, -5)) {
          fsIssues.push({ path: rel(p), error: 'job_filename_mismatch' });
          continue;
        }
        const entry = jobs.get(x.id) ?? {
          id: x.id,
          tenderId: x.tenderId,
          documentId: x.documentId,
          sourceSha: x.sourceSha,
          status: x.status,
          createdBy: x.createdBy,
          revision: x.revision,
          reviews: x.reviews?.length ?? 0,
          paths: [],
        };
        if (entry.tenderId !== x.tenderId || entry.documentId !== x.documentId)
          fsIssues.push({ path: rel(p), error: 'job_identity_conflict' });
        entry.paths.push(rel(p));
        jobs.set(x.id, entry);
      }
      if (submission) {
        const id = x.base?.match(/^\/api\/tenders\/([a-f0-9-]{36})$/)?.[1];
        if (id) {
          const evidence = submissions.get(id) ?? [];
          evidence.push(rel(p));
          submissions.set(id, evidence);
        }
      }
    } catch {
      fsIssues.push({ path: rel(p), error: 'invalid_json' });
    }
  }
}
for (const root of [...new Set(roots)]) await walk(root);
const retained = new Set();
for (const name of ['TASK-008F-primary.json', 'TASK-008G-primary.json', 'TASK-008-GATE-D-summary.json']) {
  try {
    const x = JSON.parse(await readFile(resolve(repo, 'docs/evaluations', name), 'utf8'));
    const id = x.base?.match(/^\/api\/tenders\/([a-f0-9-]{36})$/)?.[1];
    if (id) retained.add(id);
  } catch {
    /* Optional research summary absent; no write or cleanup. */
  }
}
for (const id of submissions.keys()) retained.add(id); // All recorded research runs remain on hold until evidence retention is agreed.
const activeTender = 'f768e259-c0fe-4819-a62b-28d5630025c6';
const docMap = new Map(documents.map((d) => [d.id, d]));
const countsByHash = new Map();
for (const d of documents) {
  const xs = countsByHash.get(d.blob_sha256) ?? [];
  xs.push({ tenderId: d.tender_id, documentId: d.id });
  countsByHash.set(d.blob_sha256, xs);
}
const allJobs = [...jobs.values()];
const ocrLinkIssues = allJobs
  .filter(
    (j) =>
      !docMap.has(j.documentId) ||
      docMap.get(j.documentId).tender_id !== j.tenderId ||
      docMap.get(j.documentId).blob_sha256 !== j.sourceSha,
  )
  .map((j) => ({
    id: j.id,
    tenderId: j.tenderId,
    documentId: j.documentId,
    issue: 'document/tender/source SHA mismatch',
  }));
const knownTitle =
  /^Synthetic (?:TASK00[5-8](?:B)?(?: |$)|task004 persisted scope$|PDF extraction test$|PDF draft \d{13}$|scan \d{13}$|legacy original 005B$|position comparison$)/;
const browser004 = /^(Только название|Три позиции|Через ТЗ) \d{13}-[0-9a-f]{4}$/u;
const researchTitle = /^СИНТЕТИЧЕСКИЙ (?:Gate D|TASK-008[FG]) — пакет русских КП [0-9TZ.:-]+-[a-f0-9]{8}$/u;
const candidates = [],
  suspected = [],
  protectedRows = [];
for (const t of tenders) {
  const docs = documents.filter((d) => d.tender_id === t.id),
    js = allJobs.filter((j) => j.tenderId === t.id);
  const validJobs = js.filter(
    (j) =>
      docMap.get(j.documentId)?.tender_id === t.id && docMap.get(j.documentId)?.blob_sha256 === j.sourceSha,
  );
  const evidence =
    t.title === 'Synthetic integration tender'
      ? 'exact legacy fixture title from scripts/verify-test-db.mjs'
      : validJobs.length
        ? 'canonical OCR jobs with matching tender/document/SHA'
        : submissions.has(t.id)
          ? 'recorded benchmark submission'
          : researchTitle.test(t.title)
            ? 'exact benchmark title/run-id pattern'
            : knownTitle.test(t.title)
              ? 'known automation title pattern'
              : browser004.test(t.title)
                ? 'exact TASK004 browser title pattern'
                : null;
  const hint = /^(?:Synthetic|СИНТЕТ|TASK[- ]?00|Тест)/iu.test(t.title);
  const shared = docs.filter((d) => countsByHash.get(d.blob_sha256).some((r) => r.tenderId !== t.id));
  const hold = [];
  if (
    docs.some(
      (d) =>
        !/^([a-f0-9]{2})\/[a-f0-9]{64}$/.test(
          blobs.find((b) => b.sha256 === d.blob_sha256)?.storage_key ?? '',
        ),
    )
  )
    hold.push('noncanonical-legacy-blob-key');
  if (retained.has(t.id)) hold.push('research-evidence-retention');
  if (t.id === activeTender) hold.push('currently-shared-portal-tender');
  if (
    js.some((j) => ['pending', 'running'].includes(j.status)) ||
    t.dbExtractionStates.queued ||
    t.dbExtractionStates.processing
  )
    hold.push('active-OCR');
  if (t.confirmedOffers) hold.push('confirmed-test-commercial-data');
  const row = {
    id: t.id,
    title: t.title,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    revision: t.revision,
    classification: evidence
      ? 'automation-candidate'
      : hint
        ? 'synthetic-hint-only'
        : 'protected-unclassified',
    evidence,
    provenanceVerified: !!validJobs.length || submissions.has(t.id),
    requiresOwnerAttestation: true,
    cleanupAuthorized: false,
    documents: docs.length,
    documentsByPurpose: {
      offer: docs.filter((d) => d.purpose === 'offer').length,
      specification: docs.filter((d) => d.purpose === 'specification').length,
    },
    databaseExtractionStatuses: t.dbExtractionStates,
    receivedEvents: t.receivedEvents,
    confirmedOffers: t.confirmedOffers,
    accreditationFileEvents: t.accreditationFileEvents,
    related: t.related,
    ocr: {
      jobs: js.length,
      statuses: Object.fromEntries(
        [...new Set(js.map((j) => j.status))].map((s) => [s, js.filter((j) => j.status === s).length]),
      ),
      reviews: js.reduce((n, j) => n + j.reviews, 0),
    },
    sharedDocumentRefs: shared.length,
    sharedBlobHashes: [...new Set(shared.map((d) => d.blob_sha256))],
    holds: hold,
    nextAction: hold.length
      ? 'retain pending individual owner decision'
      : 'review for reversible archive/trash only',
  };
  if (evidence) candidates.push(row);
  else if (hint) suspected.push(row);
  else
    protectedRows.push({
      id: t.id,
      reason: 'no reliable automation provenance; protected; title not exported',
    });
}
const blobChecks = [];
for (const b of blobs) {
  const storageKeyValid =
    /^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(b.storage_key) &&
    b.storage_key === b.sha256.slice(0, 2) + '/' + b.sha256;
  let present = false,
    sizeMatches = false;
  if (storageKeyValid) {
    const p = await checked(resolve(process.env.STORAGE_ROOT, ...b.storage_key.split('/')));
    try {
      const s = await lstat(p);
      present = s.isFile();
      sizeMatches = String(s.size) === b.byte_size;
    } catch (e) {
      if (e.code !== 'ENOENT') fsIssues.push({ path: rel(p), error: 'blob_stat_failed' });
    }
  }
  const refs = countsByHash.get(b.sha256) ?? [],
    tenderIds = [...new Set(refs.map((r) => r.tenderId))];
  blobChecks.push({
    sha256: b.sha256,
    storageKey: b.storage_key,
    bytes: b.byte_size,
    storageKeyValid,
    present,
    sizeMatches,
    documentRefs: refs.length,
    tenderIds,
    tzArtifactRefs: artifactRefs.filter((r) => r.sha256 === b.sha256).length,
    ocrSourceRefs: allJobs.filter((j) => j.sourceSha === b.sha256).length,
    sharedAcrossTenders: tenderIds.length > 1,
    physicalDeletionAllowed: false,
  });
}
Object.assign(data, {
  scope: 'configured project DB only; no other databases or external storage queried',
  fileSystemScan: {
    roots: roots.map(rel),
    visitedDirectories: visited,
    canonicalJobs: allJobs.length,
    issues: fsIssues,
    atEnd: new Date().toISOString(),
  },
  totals: {
    tenders: tenders.length,
    documents: documents.length,
    blobs: blobs.length,
    candidates: candidates.length,
    syntheticHints: suspected.length,
    protectedUnclassified: protectedRows.length,
    sharedBlobs: blobChecks.filter((b) => b.sharedAcrossTenders).length,
    missingBlobFiles: blobChecks.filter((b) => b.storageKeyValid && !b.present).length,
    invalidStorageKeys: blobChecks.filter((b) => !b.storageKeyValid).length,
    sizeMismatches: blobChecks.filter((b) => b.present && !b.sizeMatches).length,
    orphanForeignKeys: data.foreignKeys.reduce((n, f) => n + (f.orphans ?? 0), 0),
    filesystemJobsWithoutTender: allJobs.filter((j) => !tenders.some((t) => t.id === j.tenderId)).length,
  },
  candidates,
  suspected,
  protected: protectedRows,
  blobReferences: blobChecks,
  ocrJobIndex: allJobs,
  ocrLinkIssues,
  retainedResearchTenderIds: [...retained],
  storageRoot: rel(process.env.STORAGE_ROOT),
  tzArtifactReferences: artifactRefs,
  exclusions: [
    'No deletes/truncates/cascades, no migrations, no backups/dumps or restore attempted',
    'Title/prefix is not authorization or proof of exclusive synthetic contents',
    'DB snapshot and filesystem inventory are not atomic; must re-preview before any approved action',
    'All physical binaries retained; unknown external DB and research references block physical GC',
  ],
});
await json(resolve(out, 'inventory.json'), data);
const headers = [
  'database',
  'id',
  'title',
  'createdAt',
  'documents',
  'receivedEvents',
  'confirmedOffers',
  'ocrJobs',
  'ocrReviews',
  'sharedDocumentRefs',
  'holds',
  'evidence',
  'related',
  'cleanupAuthorized',
];
const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
const rows = candidates.map((t) => [
  data.database,
  t.id,
  t.title,
  new Date(t.createdAt).toISOString(),
  t.documents,
  t.receivedEvents,
  t.confirmedOffers,
  t.ocr.jobs,
  t.ocr.reviews,
  t.sharedDocumentRefs,
  t.holds.join('|'),
  t.evidence,
  JSON.stringify(t.related),
  false,
]);
await save(
  resolve(out, 'candidates.csv'),
  '\uFEFF' + [headers, ...rows].map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n',
);
await json(resolve(out, 'integrity.json'), {
  at,
  inventorySha256: createHash('sha256')
    .update(await readFile(resolve(out, 'inventory.json')))
    .digest('hex'),
  candidatesSha256: createHash('sha256')
    .update(await readFile(resolve(out, 'candidates.csv')))
    .digest('hex'),
  cleanupPerformed: false,
});
console.log(
  JSON.stringify({
    database: data.database,
    readOnly: data.transactionReadOnly,
    totals: data.totals,
    candidateHolds: Object.fromEntries(
      [...new Set(candidates.flatMap((c) => c.holds))].map((h) => [
        h,
        candidates.filter((c) => c.holds.includes(h)).length,
      ]),
    ),
    foreignKeys: data.foreignKeys.length,
    triggers: data.triggers.length,
    crossTenderReferences: data.crossTenderReferences,
    unmappedTables: data.unmappedTables,
    out,
  }),
);
