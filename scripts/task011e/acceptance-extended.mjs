import { multipart } from '../task011d/fixtures.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { json } from '../task008-gate-d/io.mjs';
import { verifyIdentity } from '../testing/isolated-run.mjs';
export async function extended(c) {
  const {
    run,
    pool,
    tender,
    receipt,
    company,
    supplier,
    lot,
    verificationBody,
    transfer,
    saved,
    fixtures,
    make,
    upload,
    post,
    get,
    request,
    ro,
    foreign,
    until,
    base,
    count,
    ok,
  } = c;
  await verifyIdentity(pool, run.identity);
  const B = base(tender),
    detailPath = (r) => B + '/receipts/' + r + '/review',
    companyPath = (id) => B + '/companies/' + id + '/decisions',
    classPath = (r) => B + '/receipts/' + r + '/classification-decisions';
  const checkpoint = (id, proof) => ok(id + ': ' + proof);
  let ws = await get(B + '/workspace?pageSize=100');
  const beforeNoWrites = await count('intake_review_decision');
  const detached = await get(detailPath(receipt));
  assert.equal(detached.receipt.name, 'offer.txt');
  assert.equal(detached.receipt.receiptId, receipt);
  const sorted = await get(B + '/workspace?pageSize=100&sort=name');
  assert.deepEqual(
    sorted.items.map((x) => x.name),
    [...sorted.items.map((x) => x.name)].sort((a, b) => a.localeCompare(b)),
  );
  await get(detailPath(receipt));
  assert.equal(await count('intake_review_decision'), beforeNoWrites);
  checkpoint('E-T02', 'detached receipt survives list page/filter and GET has no writes');
  const beta = await get(B + '/companies/' + company.preliminaryCompanyId);
  const rejected = await post(companyPath(company.preliminaryCompanyId), {
    action: 'reject',
    expectedRevision: beta.stateRevision,
    note: 'Synthetic manual rejection before explicit existing selection',
  });
  const countBeforeExisting = await count('supplier');
  const chosen = await post(companyPath(company.preliminaryCompanyId), {
    action: 'choose_existing',
    expectedRevision: rejected.revision,
    existingSupplierId: supplier,
    note: 'Human chooses already existing participant',
  });
  assert.equal(chosen.supplierId, supplier);
  assert.equal(await count('supplier'), countBeforeExisting);
  const bc = await get(B + '/companies/' + company.preliminaryCompanyId);
  assert.ok(bc.revisions.length >= 4);
  assert.ok(bc.evidence.length);
  assert.equal(bc.requisites.addresses[0], 'Synthetic Manual Address');
  checkpoint('E-T05', 'choose_existing reuses actual participant and retains company/evidence history');
  await post(
    companyPath(company.preliminaryCompanyId),
    {
      action: 'choose_existing',
      expectedRevision: chosen.revision,
      existingSupplierId: randomUUID(),
      note: 'Foreign participant must not disclose identity',
    },
    404,
  );
  const alpha = ws.companies.items.find((x) => x.requisites.names.includes('Synthetic Alpha'));
  await post(
    companyPath(alpha.preliminaryCompanyId),
    {
      action: 'edit',
      expectedRevision: alpha.stateRevision,
      changes: { registrationNumber: '0000000000' },
      note: 'Invalid checksum must be rejected',
    },
    400,
  );
  await post(
    companyPath(alpha.preliminaryCompanyId),
    {
      action: 'edit',
      expectedRevision: alpha.stateRevision,
      changes: { country: 'GB' },
      note: 'Country change cannot retain invalid registration scheme',
    },
    400,
  );
  const race = await Promise.all([
    request(
      'POST',
      companyPath(alpha.preliminaryCompanyId),
      {
        action: 'confirm',
        expectedRevision: alpha.stateRevision,
        createFromRevision: true,
        note: 'Concurrent explicit new company',
      },
      undefined,
      randomUUID(),
    ),
    request(
      'POST',
      companyPath(alpha.preliminaryCompanyId),
      {
        action: 'choose_existing',
        expectedRevision: alpha.stateRevision,
        existingSupplierId: supplier,
        note: 'Conflicting explicit participant',
      },
      undefined,
      randomUUID(),
    ),
  ]);
  assert.deepEqual(race.map((r) => r.statusCode).sort(), [201, 409]);
  const ac = await get(B + '/companies/' + alpha.preliminaryCompanyId);
  assert.ok(ac.confirmedSupplierId);
  assert.notEqual(ac.confirmedSupplierId, supplier);
  checkpoint(
    'E-T07',
    'different-key create/choose race preserves one mapping; invalid country/registration rejected',
  );
  const q = ws.items.find((x) => x.name === 'quality.txt'),
    qd = await get(detailPath(q.receiptId)),
    observation = qd.organizations.find((x) => x.role === 'supplier');
  assert.ok(observation);
  const op = B + '/receipts/' + q.receiptId + '/observations/' + observation.id + '/decisions',
    input = {
      action: 'reject',
      expectedRevision: 0,
      note: 'Human rejects this synthetic organization observation only',
    },
    key = randomUUID();
  const frozen = JSON.stringify(
    (
      await pool.query('SELECT * FROM tender_app.intake_organization_observation WHERE id=$1', [
        observation.id,
      ])
    ).rows[0],
  );
  const parallel = await Promise.all([post(op, input, 201, key), post(op, input, 201, key)]);
  assert.deepEqual(parallel[0], parallel[1]);
  assert.equal(parallel[0].revision, 1);
  await post(op, input, 409);
  await post(op, { ...input, note: 'different payload' }, 409, key);
  await post(op, { ...input, expectedRevision: 1, actorId: randomUUID() }, 400);
  await post(op, { ...input, expectedRevision: 1 }, 403, randomUUID(), ro);
  await post(op, { ...input, expectedRevision: 1 }, 404, randomUUID(), foreign);
  await post(B + '/receipts/' + receipt + '/observations/' + observation.id + '/decisions', input, 404);
  assert.equal(
    JSON.stringify(
      (
        await pool.query('SELECT * FROM tender_app.intake_organization_observation WHERE id=$1', [
          observation.id,
        ])
      ).rows[0],
    ),
    frozen,
  );
  const rejectedDetail = await get(detailPath(q.receiptId));
  assert.equal(rejectedDetail.observationDecisions.length, 1);
  assert.equal(rejectedDetail.organizations.length, qd.organizations.length);
  assert.deepEqual(rejectedDetail.evidence, qd.evidence);
  assert.equal((await get(B + '/companies/' + alpha.preliminaryCompanyId)).stateRevision, ac.stateRevision);
  await assert.rejects(
    pool.query("UPDATE tender_app.intake_observation_decision SET note='forbidden' WHERE observation_id=$1", [
      observation.id,
    ]),
    (e) => e.code === '55000',
  );
  await assert.rejects(
    pool.query('DELETE FROM tender_app.intake_observation_decision WHERE observation_id=$1', [
      observation.id,
    ]),
    (e) => e.code === '55000',
  );
  const fk = (
    await pool.query(
      "SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='tender_app.intake_observation_decision'::regclass AND contype='f'",
    )
  ).rows;
  assert.ok(fk.some((x) => x.d.includes('observation_id, result_id, receipt_id, tender_id')));
  assert.ok(fk.some((x) => x.d.includes('review_decision_id, tender_id, result_id, receipt_id')));
  await assert.rejects(
    pool.query(
      'INSERT INTO tender_app.intake_observation_decision SELECT $1,tender_id,observation_id,result_id,receipt_id,revision+2,action,$2,actor_id,note,now() FROM tender_app.intake_observation_decision WHERE observation_id=$3',
      [randomUUID(), randomUUID(), observation.id],
    ),
    (e) => e.code === '55000',
  );
  const fkClient = await pool.connect();
  try {
    await fkClient.query('BEGIN');
    const fakeObservation = randomUUID(),
      reviewId = randomUUID();
    await fkClient.query(
      'INSERT INTO tender_app.intake_review_decision(id,tender_id,operation_key,request_hash,subject_type,receipt_id,company_id,expected_revision,action,before_state,after_state,reason,actor_id,source,result_id) SELECT $1,tender_id,$2,request_hash,subject_type,receipt_id,company_id,0,action,before_state,$3,reason,actor_id,source,result_id FROM tender_app.intake_review_decision WHERE id=(SELECT review_decision_id FROM tender_app.intake_observation_decision WHERE observation_id=$4 LIMIT 1)',
      [
        reviewId,
        randomUUID(),
        JSON.stringify({ observationId: fakeObservation, revision: 1, state: 'rejected' }),
        observation.id,
      ],
    );
    await assert.rejects(
      fkClient.query(
        'INSERT INTO tender_app.intake_observation_decision(id,tender_id,observation_id,result_id,receipt_id,revision,action,review_decision_id,actor_id,note) SELECT $1,tender_id,$2,result_id,receipt_id,1,action,$3,actor_id,note FROM tender_app.intake_observation_decision WHERE observation_id=$4',
        [randomUUID(), fakeObservation, reviewId, observation.id],
      ),
      (e) => e.code === '23503',
    );
  } finally {
    await fkClient.query('ROLLBACK');
    fkClient.release();
  }
  const qClass = await post(classPath(q.receiptId), {
    action: 'confirm',
    expectedRevision: q.classificationRevision,
    note: 'Independent quality confirmation after observation rejection',
  });
  assert.equal(qClass.legacyDocumentId, null);
  ws = await get(B + '/workspace?pageSize=100');
  const qa = ws.items
    .find((x) => x.receiptId === q.receiptId)
    .associations.find((x) => x.kind === 'supplier_of');
  await post(
    B + '/receipts/' + q.receiptId + '/associations/' + qa.id + '/decisions',
    {
      action: 'confirm',
      expectedRevision: qa.revision,
      note: 'Rejected observation cannot confirm relationship',
    },
    409,
  );
  checkpoint(
    'E2/009',
    'observation rejection real API CAS/replay/auth/scope, immutable evidence/history, typed FK and SQL revision guards',
  );
  const betaFile = fixtures.find((f) => f.name === 'offer.txt');
  const arrivals = await upload(tender, [betaFile, betaFile]);
  const ids = arrivals.outcomes.flatMap((x) => x.receiptIds);
  assert.equal(new Set(ids).size, 2);
  assert.equal(new Set(arrivals.outcomes.flatMap((x) => x.originalIds)).size, 1);
  await until(
    async () =>
      Number(
        (
          await pool.query(
            "SELECT count(*) n FROM tender_app.intake_processing_run WHERE receipt_id=ANY($1::uuid[]) AND status='completed'",
            [ids],
          )
        ).rows[0].n,
      ) === 2,
    'duplicate receipts',
  );
  const projections = [];
  for (const [index, r] of ids.entries()) {
    const before = await get(detailPath(r));
    const cp = await post(classPath(r), {
      action: 'confirm',
      expectedRevision: before.receipt.classificationRevision,
      note: 'Human type confirmation of independent arrival',
    });
    projections.push(cp);
    const now = await get(detailPath(r)),
      a = now.receipt.associations.find((x) => x.kind === 'supplier_of');
    await post(B + '/receipts/' + r + '/associations/' + a.id + '/decisions', {
      action: index === 0 ? 'confirm' : 'change',
      ...(index ? { companyId: alpha.preliminaryCompanyId } : {}),
      expectedRevision: a.revision,
      note: 'Explicit independent receipt supplier selection',
    });
  }
  assert.equal(projections[0].legacyDocumentId, projections[1].legacyDocumentId);
  assert.equal(projections[0].legacyDocumentId, c.classify.legacyDocumentId);
  assert.notEqual(projections[0].legacyReceiptId, projections[1].legacyReceiptId);
  const contexts = await Promise.all(ids.map(async (r) => (await get(detailPath(r))).intakeContext));
  assert.equal(contexts[0].supplierId, supplier);
  assert.equal(contexts[1].supplierId, ac.confirmedSupplierId);
  const events = await pool.query(
    "SELECT value::jsonb->>'intakeReceiptId' r,count(*)::int n FROM tender_app.field_decision WHERE document_id=$1 AND field_key='offer.received.v1' AND value::jsonb->>'intakeReceiptId'=ANY($2::text[]) GROUP BY value::jsonb->>'intakeReceiptId'",
    [projections[0].legacyDocumentId, ids],
  );
  assert.equal(events.rows.length, 2);
  assert.ok(events.rows.every((x) => x.n === 1));
  checkpoint(
    'E-T08/11',
    'same SHA canonical document reused; separate receipts, offer.received events and independently confirmed suppliers',
  );
  const other = await make('foreign identifiers'),
    foreignUpload = await upload(other, [betaFile]);
  const foreignReceipt = foreignUpload.outcomes[0].receiptIds[0];
  await until(
    async () =>
      Number(
        (
          await pool.query(
            "SELECT count(*) n FROM tender_app.intake_processing_run WHERE receipt_id=$1 AND status='completed'",
            [foreignReceipt],
          )
        ).rows[0].n,
      ) === 1,
    'foreign context',
  );
  const otherDetail = await get(base(other) + '/receipts/' + foreignReceipt + '/review');
  const baseTransfer = {
    expectedRevision: 1,
    contextToken: contexts[0].contextToken,
    lotId: lot.id,
    selectedFields: [],
    form: verificationBody.fields,
    items: [],
    note: 'Cross-scope input must fail',
  };
  // Receipt has revoked classification; a fresh confirmed duplicate proves foreign lot checks independently.
  const otherRevision = (await get('/api/tenders/' + other)).revision;
  const otherLot = await post('/api/tenders/' + other + '/verification/lot', {
    expectedRevision: otherRevision,
  });
  await post(
    B + '/receipts/' + ids[0] + '/transfer-draft',
    { ...baseTransfer, expectedRevision: 0, lotId: otherLot.id },
    404,
  );
  await post(
    B + '/receipts/' + ids[0] + '/transfer-draft',
    { ...baseTransfer, expectedRevision: 0, contextToken: '0'.repeat(64) },
    409,
  );
  await post(
    '/api/tenders/' + tender + '/verification',
    {
      ...verificationBody,
      expectedVersion: 2,
      intakeContext: { ...transfer.intakeContext, operationKey: randomUUID() },
    },
    409,
  );
  const beforeVersions = await count('offer_version');
  for (const [field, value] of [
    ['resultId', otherDetail.evidence[0].result_id],
    ['companyRevisionId', randomUUID()],
    ['associationRevisionId', randomUUID()],
    ['draftId', randomUUID()],
  ]) {
    const ctx = { ...contexts[0], draftId: transfer.draftId, operationKey: randomUUID(), [field]: value };
    const body = {
      ...verificationBody,
      documentId: projections[0].legacyDocumentId,
      receiptId: projections[0].legacyReceiptId,
      intakeContext: ctx,
    };
    delete body.intakeContext.supplierId;
    delete body.intakeContext.documentId;
    delete body.intakeContext.legacyReceiptId;
    delete body.intakeContext.companyId;
    delete body.intakeContext.tenderId;
    await post('/api/tenders/' + tender + '/verification', body, 404);
  }
  assert.equal(await count('offer_version'), beforeVersions);
  await assert.rejects(
    pool.query(
      "INSERT INTO tender_app.intake_field_lineage SELECT $1,tender_id,offer_version_id,receipt_id,result_id,field_path||'.foreign',lot_item_id,lot_id,evidence_id,manual_decision_id,transferred_value_hash FROM tender_app.intake_field_lineage WHERE offer_version_id=$2 LIMIT 1",
      [randomUUID(), saved.versionId],
    ),
    (e) => e.code === '23503',
  );
  await assert.rejects(
    pool.query(
      'UPDATE tender_app.intake_field_lineage SET transferred_value_hash=$1 WHERE offer_version_id=$2',
      ['0'.repeat(64), saved.versionId],
    ),
    (e) => e.code === '55000',
  );
  const sources = (await get(detailPath(receipt))).draftFields;
  assert.ok(sources.length >= 6);
  assert.ok(sources.every((s) => s.manual_decision_id && s.manual_note));
  checkpoint(
    'E-T14/15/21/22',
    'revoked/stale/foreign receipt/result/company/association/draft/lot contexts denied with zero versions; lineage FK/immutability and manual sources',
  );
  const supporting = ws.items.find((x) => x.name === 'supporting.txt');
  const beforeProj = await count('intake_receipt_projection');
  await post(classPath(supporting.receiptId), {
    action: 'change',
    type: 'unknown',
    expectedRevision: supporting.classificationRevision,
    note: 'Human leaves unknown content unprojected',
  });
  assert.equal(await count('intake_receipt_projection'), beforeProj);
  const unconfirmed = ws.companies.items.find((x) => x.requisites.names.includes('Synthetic Gamma'));
  const gammaReceipt = ws.items.find((x) => x.name === 'offer.xlsx');
  const gd = await get(detailPath(gammaReceipt.receiptId));
  await post(classPath(gammaReceipt.receiptId), {
    action: 'confirm',
    expectedRevision: gd.receipt.classificationRevision,
    note: 'Type alone is insufficient for supplier',
  });
  const ga = (await get(detailPath(gammaReceipt.receiptId))).receipt.associations.find(
    (x) => x.kind === 'supplier_of',
  );
  assert.ok(unconfirmed && !unconfirmed.confirmedSupplierId);
  await post(
    B + '/receipts/' + gammaReceipt.receiptId + '/associations/' + ga.id + '/decisions',
    { action: 'confirm', expectedRevision: ga.revision, note: 'Unconfirmed company forbidden' },
    409,
  );
  checkpoint(
    'E-T09/10',
    'quality/supporting/unknown remain unprojected; unconfirmed company cannot confirm supplier_of',
  );
  const csv = await request('GET', '/api/tenders/' + tender + '/comparison.csv?lotId=' + lot.id);
  assert.equal(csv.statusCode, 200, csv.body);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.ok(csv.body.includes('Контекст'));
  assert.ok(!csv.body.includes('NaN'));
  const preview = await get('/api/tenders/' + tender + '/lifecycle');
  assert.equal(preview.allowed.archive, true);
  const title = (await get('/api/tenders/' + tender)).title;
  await post('/api/tenders/' + tender + '/lifecycle', {
    action: 'archive',
    confirmationId: tender,
    confirmationTitle: title,
    previewHash: preview.previewHash,
    reason: 'Synthetic E archive regression verification',
  });
  const archived = await get(B + '/workspace');
  assert.equal(archived.canWrite, false);
  await post(op, { ...input, expectedRevision: 1 }, 409);
  await assert.rejects(
    pool.query(
      'INSERT INTO tender_app.intake_observation_decision SELECT $1,tender_id,observation_id,result_id,receipt_id,revision+1,action,$2,actor_id,note,now() FROM tender_app.intake_observation_decision WHERE observation_id=$3',
      [randomUUID(), randomUUID(), observation.id],
    ),
    (e) => e.code === 'LT409',
  );
  const restore = await get('/api/tenders/' + tender + '/lifecycle');
  await post('/api/tenders/' + tender + '/lifecycle', {
    action: 'restore',
    confirmationId: tender,
    confirmationTitle: title,
    previewHash: restore.previewHash,
    reason: 'Synthetic restore retains immutable history',
  });
  assert.equal((await get(detailPath(q.receiptId))).observationDecisions.length, 1);
  checkpoint(
    'E-T16/17/24',
    'CSV exposes stale managed context; archive blocks API/SQL observation writes; restore preserves history',
  );

  const legacyFile = fixtures.find((f) => f.name === 'offer.pdf'),
    m = multipart([legacyFile]);
  const uploadLegacy = await c.app.inject({
    method: 'POST',
    url: '/api/tenders/' + tender + '/offers/batches',
    headers: { ...c.auth, ...m.headers, 'idempotency-key': randomUUID() },
    payload: m.payload,
  });
  assert.equal(uploadLegacy.statusCode, 201, uploadLegacy.body);
  const legacyId = uploadLegacy.json().outcomes[0].documents[0];
  assert.ok(legacyId);
  let registry = await get('/api/tenders/' + tender + '/offers');
  const legacy = registry.find((d) => d.id === legacyId);
  assert.ok(legacy);
  const patch = await request('PATCH', '/api/tenders/' + tender + '/offers/' + legacyId + '/association', {
    revision: legacy.revision,
    supplierId: ac.confirmedSupplierId,
    note: 'Explicit legacy unmanaged association remains valid',
  });
  assert.equal(patch.statusCode, 200, patch.body);
  let verifyContext = await get('/api/tenders/' + tender + '/verification');
  const legacyReceipt = verifyContext.documents.find((d) => d.id === legacyId).receipts[0].id;
  const unmanaged = await post('/api/tenders/' + tender + '/verification', {
    ...verificationBody,
    supplierId: ac.confirmedSupplierId,
    documentId: legacyId,
    receiptId: legacyReceipt,
    fields: { ...verificationBody.fields, amount: '200' },
    original: { ...verificationBody.original, amount: '200' },
  });
  assert.equal(unmanaged.status, 'confirmed');
  assert.equal(
    Number(
      (
        await pool.query(
          'SELECT count(*) n FROM tender_app.intake_verification_context WHERE offer_version_id=$1',
          [unmanaged.versionId],
        )
      ).rows[0].n,
    ),
    0,
  );
  const mix = await get('/api/tenders/' + tender + '/comparison?lotId=' + lot.id);
  assert.equal(mix.columns.length, 2);
  assert.ok(mix.rows.find((r) => r.key === 'rank').values.includes('1'));
  assert.ok(mix.rows.some((r) => r.values.some((v) => String(v).includes('200'))));
  const stageCtx = await get('/api/tenders/' + tender + '/stages');
  const stage = await post('/api/tenders/' + tender + '/stages', {
    kind: 'negotiation',
    label: 'Synthetic legacy negotiation',
    comment: 'Explicit synthetic stage rationale',
    expectedRevision: stageCtx.scope.revision,
  });
  const afterStage = await get('/api/tenders/' + tender + '/stages');
  await post('/api/tenders/' + tender + '/stages/' + stage.id + '/responses', {
    offerId: unmanaged.offerId,
    status: 'no_reply',
    expectedRevision: afterStage.scope.revision,
    note: 'No response preserves latest confirmed price',
  });
  const afterNoReply = await get('/api/tenders/' + tender + '/comparison?lotId=' + lot.id);
  assert.ok(afterNoReply.rows.some((r) => r.values.some((v) => String(v).includes('200'))));
  const mixCsv = await request('GET', '/api/tenders/' + tender + '/comparison.csv?lotId=' + lot.id);
  assert.equal(mixCsv.statusCode, 200);
  assert.ok(mixCsv.body.includes('200'));
  checkpoint(
    'E-T12/17/24',
    'legacy unmanaged PATCH/verification intact; mixed comparison rank/formula/CSV and negotiation no-reply retain price',
  );

  await post(
    B + '/receipts/' + ids[0] + '/transfer-draft',
    {
      ...baseTransfer,
      expectedRevision: 0,
      items: [{ lotItemId: randomUUID(), quantity: '1', unit: 'unit', unitPrice: '1' }],
    },
    404,
  );
  const emptyDraft = await post(B + '/receipts/' + ids[0] + '/transfer-draft', {
    ...baseTransfer,
    expectedRevision: 0,
    selectedFields: ['amount', 'currency'],
    form: {
      amount: null,
      currency: null,
      vatMode: 'unknown',
      paymentTerms: null,
      deliveryTerms: null,
      compliance: 'unknown',
    },
  });
  assert.equal(emptyDraft.form.fields.amount, null);
  assert.equal(emptyDraft.form.fields.currency, null);
  assert.equal(emptyDraft.form.fields.vatMode, 'unknown');
  const beforeReprocess = await get(B + '/companies/' + company.preliminaryCompanyId);
  const originalEvidence = (
    await pool.query('SELECT * FROM tender_app.intake_evidence WHERE receipt_id=$1 ORDER BY id', [ids[0]])
  ).rows;
  const reprocessReceipt = (await get(detailPath(ids[0]))).receipt;
  const newRun = await post(B + '/receipts/' + ids[0] + '/reprocess', {
    expectedRunRevision: reprocessReceipt.runRevision,
    reason: 'Synthetic explicit reprocess after human company confirmation',
  });
  await until(
    async () =>
      Boolean(
        (
          await pool.query(
            "SELECT 1 FROM tender_app.intake_processing_run WHERE receipt_id=$1 AND generation=2 AND status='completed'",
            [ids[0]],
          )
        ).rowCount,
      ),
    'human company reprocess',
  );
  const afterReprocess = await get(B + '/companies/' + company.preliminaryCompanyId);
  assert.equal(afterReprocess.confirmedSupplierId, beforeReprocess.confirmedSupplierId);
  assert.equal(afterReprocess.stateRevision, beforeReprocess.stateRevision);
  assert.deepEqual(afterReprocess.requisites, beforeReprocess.requisites);
  for (const e of originalEvidence)
    assert.deepEqual(
      (await pool.query('SELECT * FROM tender_app.intake_evidence WHERE id=$1', [e.id])).rows[0],
      e,
    );
  assert.equal((await get(detailPath(ids[0]))).receipt.effectiveClassification, 'offer');
  assert.ok(newRun);
  checkpoint(
    'E2/reprocess',
    'explicit native reprocess preserves confirmed mapping, manual company revision/requisites, approved type and original evidence; foreign lot-item mapping denied',
  );
  const proof = {
    status: 'PASS',
    identity: run.identity,
    observationId: observation.id,
    sharedReceiptIds: ids,
    foreignTender: other,
    allSynthetic: true,
    mainConnections: 0,
    realModelCalls: 0,
  };
  await json(resolve(run.runRoot, 'E-extended-proof.json'), proof);
  return proof;
}
