# TASK-003 proposed ERD

DDL authority: [002](../infra/migrations/002_domain_foundation.sql), extending unchanged [001](../infra/migrations/001_initial.sql). Not yet applied. UUID keys; composite foreign keys prevent cross-tender and cross-lot associations. Legacy tables specification_item, comparison and comparison_offer remain intact; they are not silently remapped.

```mermaid
erDiagram
  APP_USER ||--o{ TENDER : owns
  TENDER ||--o{ TENDER_MEMBER : authorizes
  APP_USER ||--o{ TENDER_MEMBER : participates
  TENDER ||--o{ LOT : contains
  LOT ||--o{ LOT_ITEM : contains
  TENDER ||--o{ TENDER_SUPPLIER : invites
  SUPPLIER ||--o{ TENDER_SUPPLIER : participates
  TENDER_SUPPLIER ||--o{ OFFER : submits
  LOT ||--o{ OFFER : priced_by
  OFFER_PACKAGE ||--o| OFFER : maps_to
  OFFER ||--o{ OFFER_VERSION : versions
  OFFER_VERSION ||--o{ OFFER_ITEM : details
  LOT_ITEM ||--o{ OFFER_ITEM : quoted
  OFFER_VERSION ||--o{ COST_COMPONENT : costs
  TENDER ||--o{ TENDER_STAGE : stages
  TENDER_STAGE ||--o{ STAGE_RESPONSE : responses
  OFFER ||--o{ STAGE_RESPONSE : responds
  OFFER_VERSION o|--o{ STAGE_RESPONSE : optional_price
  TENDER ||--o{ UPLOAD_BATCH : uploads
  UPLOAD_BATCH o|--o{ DOCUMENT : groups
  BLOB ||--o{ DOCUMENT : original
  TENDER ||--o{ DOCUMENT : contains
  DOCUMENT ||--o{ DOCUMENT_RECEIPT : idempotency
  DOCUMENT ||--o{ DOCUMENT_RELATION : linked
  DOCUMENT ||--o{ EXTRACTION_RUN : parsed
  DOCUMENT ||--o{ EVIDENCE_REFERENCE : evidence
  EXTRACTION_RUN o|--o{ EXTRACTED_FIELD : fields
  EVIDENCE_REFERENCE o|--o{ EXTRACTED_FIELD : supports
  DOCUMENT ||--o{ FIELD_DECISION : decisions
  EXTRACTED_FIELD o|--o{ FIELD_DECISION : corrected_by
  DOCUMENT ||--o{ CONTACT : source
  DOCUMENT ||--o{ ACCREDITATION_REPORT : evidence
  TENDER_SUPPLIER ||--o{ ACCREDITATION_REPORT : assessed
  TENDER_STAGE ||--o{ DRAFT_MESSAGE : drafts
  TENDER ||--o{ CALCULATION_RUN : calculations
  TENDER ||--o{ AUDIT_EVENT : history
```

Historical offer versions without a reviewed lot mapping are the explicit exception to Offer cardinality. No fabricated mapping is made. The ERD abbreviates nullable stage/supplier/source-document references; see DDL for every constraint and [ADR](./ADR-003-persistence.md) for unresolved mappings.
