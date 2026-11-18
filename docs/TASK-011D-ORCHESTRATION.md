# TASK-011D: durable intake orchestration

This physical copy extends the accepted TASK-011C foundation. Main deployment is unchanged. TASK-011E UI and TASK-011F model integration are outside this change.

## Runtime and policy

Build the copy, then start `node scripts/intake-api.mjs <absolute-runtime-config.json>`. The API starts a separate `scripts/intake-worker.mjs` child; standalone workers can use the same explicit config. The Nest development entry point requires `INTAKE_RUNTIME_CONFIG` and delegates to this guarded runtime. No runtime/bootstrap reads a main `.env` fallback. Credentials must be supplied in process environment; never store them in runtime JSON.

Config contains the TASK-014 disposable identity (UUID database name, OID, owner, run marker), owned workspace/storage paths, policyFile, actorId, optional port and timing. Runtime verifies identity on connection and rejects protected ports. DEV_API_TOKEN is required. DOCUMENT_AI must remain disabled. Bootstrap requires explicit TASK014_PGUSER/TASK014_PGPASSWORD inputs. The development launcher outside the patch explicitly reads the named credentials file once; it neither copies credentials nor supplies a fallback to application code.

Policy defaults to disabled. Policy JSON supports disabled or synthetic, enabled boolean and an explicit list of SHA-256 values. approved_corpus is rejected in D. Eligibility is checked before container/native parsing, before claim and before committing results. Policy version is recorded in each run and checked by fencing. Ineligible documents are accepted with metadata and blocked runs, without parser/checkpoint execution. Real documents are not processing-authorized by filenames, sender, MIME or matching company names.

## Queue and fencing

Upload commits receipt plus one processing run plus matching event in the same PostgreSQL transaction. HTTP does not perform classification or organization extraction. Each receipt retains its own run even when originals share a blob SHA. GET/list/history never enqueue.

Queue uses SQL ordering, tender-first locks and SKIP LOCKED. Production lease is 180 seconds with heartbeat every 15 seconds. Concurrency defaults to one and supports two. Production short leases are rejected; short timing and fault hooks require NODE_ENV=test. Every mutable run transition increments state_revision and has an event enforced by a deferred constraint trigger. Initiating actor and worker executor are distinct identities.

Claimed jobs progress through original read, native classification, Organizations extraction, existing C resolver, contextual links and atomic finalization. Immutable classification and organization checkpoints use schema version and canonical payload SHA. Recovery validates checkpoints and the immutable original SHA. Native extraction is reused; model=false. Results, evidence, classification heads, observations, preliminary companies, proposed links and completed event commit together. Resolver failure rolls the promotion back.

Every write verifies token, revision, worker, unexpired lease, active tender, access, source/policy versions and absence of an existing final result. Heartbeat loss cancels finalization. Expired workers cannot complete after another claim. File read, native steps and SQL have finite deadlines; a hard processing deadline stops heartbeat and releases recovery to another worker.

New run states are queued, blocked, running, retry_wait, completed and failed. Legacy unsupported terminal states remain readable. Max attempts is three total; configured delays are 2/10/30 seconds (with three total attempts only the first two delays are used). Transient I/O, selected connection/transaction errors and native timeout retry; corrupt/unsupported input fails permanently. A failed document does not block siblings. Bounded retry exhaustion is terminal and visible.

## Explicit operations

POST `/api/tenders/:id/intake/receipts/:receiptId/reprocess` requires Idempotency-Key, expectedRunRevision and reason. Same key/body returns the prior operation. Changed payload, stale revision or conflicting active generation returns 409. A successful reprocess creates a new generation with retry_of, preserving prior runs/history. Cancellation is explicit for blocked/queued/retry_wait runs and does not delete the original. Running jobs reject cancellation. A blocked generation must be explicitly cancelled before starting a new one after policy changes.

GET receipt processing/history and batch read models expose state, stage, attempts, coverage, run revision, update time and safe errors. Rejected late worker writes produce safe audit diagnostics even when Lifecycle prohibits writing to the archived run itself.

## Context and Lifecycle

Existing C strong identity resolver is reused. supplier_of remains evidence based. quality_for and supports require this receipt's supplier proof. contained_in records physical MIME parentage only and cannot establish a supplier. Shared blob SHA never transfers semantic links. Explicit in-tender receipt references can propose relates_to_specification (only an already classified specification target) and supersedes. All new links stay proposed. If the referenced specification has not completed classification, explicitly reprocess the referencing receipt later; deferred reconciliation is outside D.

Lifecycle inventory already includes intake runs. Queued/running/retry_wait/blocked jobs affect busy, allowed actions and preview hashes. Archive/trash stale-preview requests fail; Restore respects busy. Normal archived tenders reject worker promotion. No supplier, tender_supplier, offer_version or business confirmation is created.

## Verification and retained data

The integration suite uses new UUID databases, synthetic native fixtures and real worker processes, including SIGKILL recovery, SQL fault injection, concurrent claims, stale fencing, policy revocation and HTTP death after enqueue commit. Migrations 001–005 are unchanged. Migration 006 and both new tables are covered by migration SHA and TASK-014 provenance. Every database and storage tree is retained. Blob writes preceding a rolled-back receipt transaction may leave diagnostic orphans; this change performs no physical cleanup.

Global lint retains 27 inherited no-unreachable errors in fail-closed research scripts; changed-file lint is checked separately. No frontend changes are part of D.
