# TASK-011C preliminary organizations API

This additive backend extension runs synchronously with the accepted TASK-011B intake pipeline. New classification results remain intake-classification-v1; organization output has its own intake-organizations-v1 envelope and immutable organization result. Existing classifications are never rewritten. No backfill or automatic supplier confirmation occurs.

## Read endpoints

All paths below are relative to /api/tenders/:id/intake and use the existing authorization policy. Actor identity comes from the authenticated server context, never query/body fields. Foreign tender/company/receipt IDs return 404.

| Endpoint                  | Contract                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET /companies            | contractVersion, items, nextCursor, unassignedReceipts                                                            |
| GET /companies/:companyId | Current revision, revisions, observations, evidence, proposals and card fields                                    |
| GET /receipts/:receiptId  | Existing revisions/evidence plus organizationsContractVersion, organizations, organizationResults, matchProposals |

List queries: limit integer 1–100 (default 30), exclusive company UUID cursor, reviewStatus (proposed/needs_review/confirmed/rejected/superseded), literal search up to 200 characters. Search and matching stay inside the current tender. Company IDs are sorted for cursor pagination. unassignedReceipts returns up to 100 receipts without a supplier_of head; it is a separate diagnostic group, not an assertion that the document has no organizations.

Cards expose preliminaryCompanyId, name, requisites, roles, identifiers, supplierRole, observationCount, receiptCount, documents, reviewState, conflicts, matchProposals, evidenceReferences, existingParticipantCandidates, stateRevision and confirmedSupplierId. confirmedSupplierId is always null in this stage. Company detail supplies full immutable observation/revision history and evidence excerpts.

Receipt observations include role, individual evidence_by_field references, preliminaryCompanyIds/preliminaryCompanyId and associationProposals. Original TASK-011B fields remain available. Receipt results distinguish native_labeled/test_mock/localai and record model=false.

OpenAPI response schemas and query descriptions are registered on the actual controllers; enable OpenAPI only on an isolated development/test application to retrieve /api/openapi.json. No write endpoint for confirming companies, suppliers or business associations is provided.

## Organizations contract and evidence

Each observation contains:

- local_key, role, nullable name/legal_name/country/address;
- identifiers with scheme, raw_value, normalized_value, valid and validator_version;
- emails and contacts, evidence_by_field, extraction_method, review_state and warnings.

Roles: supplier, buyer, manufacturer, carrier, other, unknown. A labeled organization without a reliable name remains an observation requiring clarification. Only an unambiguous, named supplier observation may originate a preliminary supplier card. Other roles can be retained on an already evidenced identity without creating buyer-only/manufacturer-only suppliers.

Every extracted scalar/array element has its own evidence UUID. The proof binds tender, classification result, receipt, original SHA, exact excerpt and page; XLSX includes physical sheet index and available cell address. Before persistence, evidence is checked against the extracted source text and the field value. SQL triggers reject unrelated result/receipt proofs. Normalized identifiers retain evidence of their raw value. No numerical confidence substitutes for evidence.

## Native extraction and identifier policy

Production adapter: native_labeled. It reads explicit colon labels in line/semicolon/cell-delimited blocks, including seller/supplier/buyer/manufacturer/carrier and labeled requisites. Multiple blocks preserve separate roles. Filenames, From headers and unlabeled organization-like text do not establish a supplier.

PDF/TXT/XLSX use the bounded native text reader inherited from TASK-011B. Supported EML text/plain parts use UTF-8/ASCII with 7bit, 8bit or base64; HTML, quoted-printable and other encodings are not inferred. Unsupported/corrupt native content produces no organizations, while the original classification status remains available. No OCR, model or background worker is started.

Normalization policy organization-identity-v1 requires explicit supported country context. RU_INN supports 10/12 digit strings, checksum validation and preservation of leading zeros. ASCII spaces/hyphens are removed; original values remain. KPP/OGRN never substitute for INN. GB_CRN supports a conservative eight-character subset: eight digits or supported SC/NI/OC/SO/NC/FC prefix plus six digits. Other countries/schemes retain their raw identifiers and need review.

These are grouping validators, not registry existence checks. Primary format references: [FNS INN structure](https://www.nalog.gov.ru/rn77/fl/interest/inn/), [HMRC company registration number formats](https://www.gov.uk/hmrc-internal-manuals/cotax-manual/com40011), [Companies House eight-character lookup](https://find-and-update.company-information.service.gov.uk/company-lookup/search?forward=%2Fauth-code-requests%2Fcompany%2F%7BcompanyNumber%7D%2Fconfirm). The GB validator intentionally supports a narrower subset.

Legacy supplier.tax_id has no foreign scheme metadata, so it is used for a strong existing-participant proposal only for RU_INN in RU context. Foreign legacy participants can receive weak proposals from available evidence; an eight-digit foreign tax value is not presumed to be a registration number.

## Atomic resolver and boundaries

The existing parent tender lock fences access, active state and protected holds. Organization result/run freshness and policy are checked again in the transaction. Company locks precede claim insertion and association-head locks. Uniqueness conflicts reread the existing winner; claims are append-only and cannot be transferred.

Strong grouping key is tender + country + supported scheme + normalized value. Weak name/email/phone/domain/address matches only create proposals. Contradictory identifiers never merge companies. No-ID origins use receipt + local anchor + role + canonical observed set. A changed observed identity is retained as a separate observation/proposal requiring review; previous document associations remain.

Company/association revisions are immutable; mutable heads use increasing CAS revisions. Automated review states are proposed/needs_review; associations remain proposed. Company confirmed_supplier_id and association approved_revision_id stay null. The schema also provides constrained document-relation targets for future proposals; the native resolver currently proposes supplier_of and supports.

The LocalAI port accepts tender/original/receipt IDs, text pages, MIME structure and contract version. Its LocalAI adapter is disabled. A constructor-injected test mock is allowed only with NODE_ENV=test and labels observations/results test_mock, including empty outputs. It is not evidence of native extractor or LLM quality. No environment flag activates a real model.

## Isolated acceptance

From this physical source copy, load the workspace environment, set process-only TASK011B_CREDENTIALS_FILE to the existing ignored main .env path, build shared/API, then run:

    node scripts/task011c/integration.mjs --run

Without --run the script performs no database creation. With --run it creates a fresh TASK-014 UUID database, applies checked migrations 001–005, verifies name/OID/owner/run marker, enables provenance on all 53 reviewed application tables and retains the database/artifacts. It never adopts an earlier run database.

The main numeric fixture uses actual uploads of ten generated documents without seeded companies/observations/evidence/suppliers and requires 3 preliminary companies, 0 confirmed suppliers and 2 unassigned receipts. Additional participant controls are seeded separately after that acceptance. Resolver fault injection is confined to the synthetic test harness; no production failure hooks or mocked main acceptance results exist.

No real-document corpus was used: no exact approved IT corpus path/scope was supplied. No production portal restart, migration, merge, publish or TASK-011D work is included.
