-- PROPOSAL: requires human review and explicit empty-test-database approval.
-- Run inside the migration runner's transaction. Never edit applied 001_initial.sql.
ALTER TABLE tender_app.tender
 ADD COLUMN owner_id uuid REFERENCES tender_app.app_user(id),
 ADD COLUMN category text,
 ADD COLUMN scope_status text NOT NULL DEFAULT 'title_only' CHECK (scope_status IN ('title_only','draft','confirmed')),
 ADD COLUMN selection_mode text NOT NULL DEFAULT 'lot' CHECK (selection_mode IN ('lot','items'));
UPDATE tender_app.tender SET owner_id=created_by WHERE owner_id IS NULL;
ALTER TABLE tender_app.tender ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE tender_app.supplier ADD COLUMN country char(2) CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');
CREATE TABLE tender_app.tender_member (
 tender_id uuid NOT NULL REFERENCES tender_app.tender(id),
 user_id uuid NOT NULL REFERENCES tender_app.app_user(id),
 role text NOT NULL CHECK (role IN ('buyer','reviewer','manager')),
 PRIMARY KEY(tender_id,user_id)
);
CREATE TABLE tender_app.lot (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id),
 name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 300),
 ordinal integer NOT NULL CHECK (ordinal > 0),
 created_by uuid NOT NULL REFERENCES tender_app.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tender_id,ordinal), UNIQUE(id,tender_id)
);
CREATE TABLE tender_app.lot_item (
 id uuid PRIMARY KEY, lot_id uuid NOT NULL REFERENCES tender_app.lot(id),
 ordinal integer NOT NULL CHECK (ordinal>0), item_name text NOT NULL CHECK(length(trim(item_name)) BETWEEN 1 AND 500),
 quantity numeric(18,6) NOT NULL CHECK(quantity>0), unit text NOT NULL CHECK(length(trim(unit)) BETWEEN 1 AND 40),
 tech_requirements text, created_by uuid NOT NULL REFERENCES tender_app.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(lot_id,ordinal), UNIQUE(id,lot_id)
);
CREATE TABLE tender_app.tender_supplier (
 tender_id uuid NOT NULL REFERENCES tender_app.tender(id), supplier_id uuid NOT NULL REFERENCES tender_app.supplier(id),
 contact_status text NOT NULL DEFAULT 'unresolved' CHECK(contact_status IN ('unresolved','candidate','confirmed')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tender_id,supplier_id)
);
CREATE TABLE tender_app.tender_stage (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id),
 kind text NOT NULL CHECK(kind IN ('clarification','round','negotiation')),
 ordinal integer NOT NULL CHECK(ordinal>0), label text NOT NULL, comment text,
 opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
 created_by uuid NOT NULL REFERENCES tender_app.app_user(id),
 UNIQUE(tender_id,ordinal), UNIQUE(id,tender_id), CHECK(closed_at IS NULL OR closed_at>=opened_at)
);
CREATE TABLE tender_app.offer (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id),
 supplier_id uuid NOT NULL, lot_id uuid NOT NULL,
 offer_package_id uuid NOT NULL UNIQUE,
 verification_status text NOT NULL DEFAULT 'needs_review' CHECK(verification_status IN ('needs_review','confirmed','rejected')),
 created_by uuid NOT NULL REFERENCES tender_app.app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tender_id,supplier_id) REFERENCES tender_app.tender_supplier(tender_id,supplier_id),
 FOREIGN KEY(lot_id,tender_id) REFERENCES tender_app.lot(id,tender_id),
 FOREIGN KEY(offer_package_id,tender_id) REFERENCES tender_app.offer_package(id,tender_id),
 UNIQUE(id,tender_id), UNIQUE(id,offer_package_id), UNIQUE(id,lot_id), UNIQUE(tender_id,supplier_id,lot_id)
);
ALTER TABLE tender_app.offer_version
 ADD COLUMN offer_id uuid,
 ADD COLUMN lot_id uuid,
 ADD COLUMN tender_id uuid REFERENCES tender_app.tender(id),
 ADD COLUMN stage_id uuid,
 ADD COLUMN amount numeric(20,6) CHECK(amount>=0),
 ADD COLUMN extra_cost numeric(20,6) CHECK(extra_cost>=0),
 ADD COLUMN is_initial boolean NOT NULL DEFAULT false,
 ADD COLUMN source_document_id uuid REFERENCES tender_app.document(id),
 ADD COLUMN vat_mode text CHECK(vat_mode IN ('included','excluded','unknown')),
 ADD COLUMN submitted_at timestamptz;
UPDATE tender_app.offer_version v SET tender_id=p.tender_id,amount=v.price_minor::numeric/100,extra_cost=v.extra_cost_minor::numeric/100
 FROM tender_app.offer_package p WHERE p.id=v.offer_package_id;
ALTER TABLE tender_app.offer_version
 ALTER COLUMN tender_id SET NOT NULL,
 ADD FOREIGN KEY(offer_id,tender_id) REFERENCES tender_app.offer(id,tender_id),
 ADD FOREIGN KEY(offer_id,lot_id) REFERENCES tender_app.offer(id,lot_id),
 ADD UNIQUE(id,lot_id),
 ADD UNIQUE(id,offer_id,stage_id,tender_id),
 ADD FOREIGN KEY(offer_id,offer_package_id) REFERENCES tender_app.offer(id,offer_package_id),
 ADD FOREIGN KEY(stage_id,tender_id) REFERENCES tender_app.tender_stage(id,tender_id),
 ADD CONSTRAINT new_offer_versions_require_offer CHECK(offer_id IS NOT NULL AND lot_id IS NOT NULL) NOT VALID;
-- Existing rows with unknown lot/offer remain preserved; no invented associations.
CREATE UNIQUE INDEX offer_single_initial_idx ON tender_app.offer_version(offer_id) WHERE is_initial;
CREATE TABLE tender_app.offer_item (
 id uuid PRIMARY KEY, offer_version_id uuid NOT NULL REFERENCES tender_app.offer_version(id),
 lot_item_id uuid NOT NULL,
 lot_id uuid NOT NULL,
 FOREIGN KEY(lot_item_id,lot_id) REFERENCES tender_app.lot_item(id,lot_id),
 FOREIGN KEY(offer_version_id,lot_id) REFERENCES tender_app.offer_version(id,lot_id),
 quantity numeric(18,6) NOT NULL CHECK(quantity>0),
 unit_price numeric(20,6) CHECK(unit_price>=0), currency char(3) CHECK(currency ~ '^[A-Z]{3}$'),
 UNIQUE(offer_version_id,lot_item_id)
);
CREATE TABLE tender_app.upload_batch (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), stage_id uuid,
 created_by uuid NOT NULL REFERENCES tender_app.app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(stage_id,tender_id) REFERENCES tender_app.tender_stage(id,tender_id), UNIQUE(id,tender_id)
);
ALTER TABLE tender_app.document
 ADD COLUMN supplier_id uuid,
 ADD COLUMN stage_id uuid,
 ADD COLUMN batch_id uuid,
 ADD COLUMN parent_document_id uuid,
 ADD COLUMN channel text CHECK(channel IN ('manual','email','archive')),
 ADD COLUMN sender_email text,
 ADD COLUMN received_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN association_status text NOT NULL DEFAULT 'unresolved' CHECK(association_status IN ('unresolved','candidate','confirmed')),
 ADD COLUMN association_reason text,
 ADD CONSTRAINT document_id_tender_unique UNIQUE(id,tender_id),
 ADD FOREIGN KEY(tender_id,supplier_id) REFERENCES tender_app.tender_supplier(tender_id,supplier_id),
 ADD FOREIGN KEY(stage_id,tender_id) REFERENCES tender_app.tender_stage(id,tender_id),
 ADD FOREIGN KEY(batch_id,tender_id) REFERENCES tender_app.upload_batch(id,tender_id),
 ADD FOREIGN KEY(parent_document_id,tender_id) REFERENCES tender_app.document(id,tender_id),
 DROP CONSTRAINT document_status_check;
UPDATE tender_app.document SET status=CASE status WHEN 'recognized' THEN 'extracted' WHEN 'review' THEN 'needs_review' WHEN 'error' THEN 'failed' ELSE status END;
ALTER TABLE tender_app.document ADD CHECK(status IN ('uploaded','queued','processing','extracted','needs_review','confirmed','failed'));
ALTER TABLE tender_app.offer_version ADD FOREIGN KEY(source_document_id,tender_id) REFERENCES tender_app.document(id,tender_id);
-- One atomic receipt per idempotency key; FK may be filled later in the same transaction.
CREATE TABLE tender_app.document_receipt (
 tender_id uuid NOT NULL REFERENCES tender_app.tender(id), request_key uuid NOT NULL,
 request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 document_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tender_id,request_key),
 FOREIGN KEY(document_id,tender_id) REFERENCES tender_app.document(id,tender_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE tender_app.document_relation (
 from_document_id uuid NOT NULL, to_document_id uuid NOT NULL, tender_id uuid NOT NULL,
 relation_type text NOT NULL CHECK(relation_type IN ('attachment','container','supplement')),
 FOREIGN KEY(from_document_id,tender_id) REFERENCES tender_app.document(id,tender_id),
 FOREIGN KEY(to_document_id,tender_id) REFERENCES tender_app.document(id,tender_id),
 PRIMARY KEY(from_document_id,to_document_id,relation_type), CHECK(from_document_id<>to_document_id)
);
CREATE TABLE tender_app.contact (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), supplier_id uuid,
 email text NOT NULL, source_document_id uuid, verified boolean NOT NULL DEFAULT false,
 FOREIGN KEY(tender_id,supplier_id) REFERENCES tender_app.tender_supplier(tender_id,supplier_id),
 FOREIGN KEY(source_document_id,tender_id) REFERENCES tender_app.document(id,tender_id)
);
CREATE TABLE tender_app.extraction_run (
 id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES tender_app.document(id),
 model_tag text NOT NULL, prompt_version text NOT NULL, parser_version text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','processing','completed','failed')),
 started_at timestamptz, completed_at timestamptz, error_code text,
 UNIQUE(id,document_id)
);
CREATE TABLE tender_app.evidence_reference (
 id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES tender_app.document(id),
 page integer CHECK(page>0), bbox jsonb, sheet text, cell_range text, excerpt text,
 sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), UNIQUE(id,document_id)
);
ALTER TABLE tender_app.extracted_field
 ADD CONSTRAINT extracted_field_id_document_unique UNIQUE(id,document_id),
 ADD COLUMN run_id uuid,
 ADD COLUMN evidence_id uuid,
 ADD COLUMN normalized_value text,
 ADD COLUMN unit text,
 ADD COLUMN status text NOT NULL DEFAULT 'found' CHECK(status IN ('found','missing','ambiguous','manual','verified','rejected')),
 ADD FOREIGN KEY(run_id,document_id) REFERENCES tender_app.extraction_run(id,document_id),
 ADD FOREIGN KEY(evidence_id,document_id) REFERENCES tender_app.evidence_reference(id,document_id);
CREATE TABLE tender_app.field_decision (
 id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES tender_app.document(id),
 extracted_field_id uuid, field_key text NOT NULL, value text,
 FOREIGN KEY(extracted_field_id,document_id) REFERENCES tender_app.extracted_field(id,document_id),
 source_type text NOT NULL CHECK(source_type IN ('document','phone','email','other')),
 source_note text NOT NULL CHECK(length(trim(source_note))>0),
 decided_by uuid NOT NULL REFERENCES tender_app.app_user(id), decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tender_app.cost_component (
 id uuid PRIMARY KEY, offer_version_id uuid NOT NULL REFERENCES tender_app.offer_version(id),
 name text NOT NULL, amount numeric(20,6) CHECK(amount>=0), currency char(3) CHECK(currency ~ '^[A-Z]{3}$'),
 treatment text NOT NULL CHECK(treatment IN ('add','included','unknown')),
 source text NOT NULL, created_by uuid NOT NULL REFERENCES tender_app.app_user(id),
 CHECK(treatment='unknown' OR (amount IS NOT NULL AND currency IS NOT NULL))
);
CREATE TABLE tender_app.accreditation_report (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL, supplier_id uuid NOT NULL, document_id uuid NOT NULL,
 assessed_at timestamptz NOT NULL, status text NOT NULL CHECK(status IN ('passed','conditional','pending','failed','no_conclusion')),
 source text NOT NULL, note text, created_by uuid NOT NULL REFERENCES tender_app.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tender_id,supplier_id) REFERENCES tender_app.tender_supplier(tender_id,supplier_id),
 FOREIGN KEY(document_id,tender_id) REFERENCES tender_app.document(id,tender_id)
);
CREATE TABLE tender_app.stage_response (
 id uuid PRIMARY KEY, stage_id uuid NOT NULL, offer_id uuid NOT NULL, tender_id uuid NOT NULL,
 response_status text NOT NULL CHECK(response_status IN ('received','no_reply','withdrawn')),
 offer_version_id uuid,
 FOREIGN KEY(offer_version_id,offer_id,stage_id,tender_id) REFERENCES tender_app.offer_version(id,offer_id,stage_id,tender_id),
 created_by uuid NOT NULL REFERENCES tender_app.app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(stage_id,tender_id) REFERENCES tender_app.tender_stage(id,tender_id),
 FOREIGN KEY(offer_id,tender_id) REFERENCES tender_app.offer(id,tender_id),
 UNIQUE(stage_id,offer_id), CHECK((response_status='received')=(offer_version_id IS NOT NULL))
);
CREATE TABLE tender_app.draft_message (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL, stage_id uuid NOT NULL, supplier_id uuid NOT NULL,
 to_addresses text[] NOT NULL, subject text NOT NULL, body text NOT NULL,
 approval_status text NOT NULL DEFAULT 'draft' CHECK(approval_status IN ('draft','approved')),
 created_by uuid NOT NULL REFERENCES tender_app.app_user(id),
 FOREIGN KEY(stage_id,tender_id) REFERENCES tender_app.tender_stage(id,tender_id),
 FOREIGN KEY(tender_id,supplier_id) REFERENCES tender_app.tender_supplier(tender_id,supplier_id)
);
CREATE TABLE tender_app.calculation_run (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id),
 mode text NOT NULL CHECK(mode IN ('lot','items')), rules_version text NOT NULL,
 input_revision integer NOT NULL CHECK(input_revision>0), produced_at timestamptz NOT NULL DEFAULT now(), warnings jsonb NOT NULL DEFAULT '[]'
);
ALTER TABLE tender_app.audit_event ADD COLUMN entity text, ADD COLUMN entity_id uuid;
CREATE FUNCTION tender_app.reject_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'immutable record: append a new version' USING ERRCODE='55000'; END;
$$;
CREATE FUNCTION tender_app.protect_document_original() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.offer_package_id IS DISTINCT FROM OLD.offer_package_id OR NEW.blob_sha256 IS DISTINCT FROM OLD.blob_sha256 OR NEW.original_name IS DISTINCT FROM OLD.original_name
 OR NEW.mime_type IS DISTINCT FROM OLD.mime_type OR NEW.tender_id IS DISTINCT FROM OLD.tender_id
 OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
 RAISE EXCEPTION 'document original is immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON tender_app.audit_event FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON tender_app.audit_event FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER version_append_only BEFORE UPDATE OR DELETE ON tender_app.offer_version FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER version_no_truncate BEFORE TRUNCATE ON tender_app.offer_version FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER decision_append_only BEFORE UPDATE OR DELETE ON tender_app.field_decision FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER document_original_immutable BEFORE UPDATE ON tender_app.document FOR EACH ROW EXECUTE FUNCTION tender_app.protect_document_original();
CREATE TRIGGER document_no_delete BEFORE DELETE ON tender_app.document FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER blob_append_only BEFORE UPDATE OR DELETE ON tender_app.blob FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE INDEX lot_tender_idx ON tender_app.lot(tender_id);
CREATE INDEX lot_item_lot_idx ON tender_app.lot_item(lot_id);
CREATE INDEX tender_owner_updated_idx ON tender_app.tender(owner_id,updated_at DESC,id);
CREATE INDEX document_batch_idx ON tender_app.document(batch_id);
CREATE INDEX offer_version_offer_idx ON tender_app.offer_version(offer_id,version DESC);
CREATE INDEX evidence_document_idx ON tender_app.evidence_reference(document_id);
CREATE INDEX decision_document_idx ON tender_app.field_decision(document_id,decided_at);
CREATE INDEX accreditation_tender_supplier_idx ON tender_app.accreditation_report(tender_id,supplier_id,assessed_at DESC);
CREATE TRIGGER document_no_truncate BEFORE TRUNCATE ON tender_app.document FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER blob_no_truncate BEFORE TRUNCATE ON tender_app.blob FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER decision_no_truncate BEFORE TRUNCATE ON tender_app.field_decision FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER offer_item_append_only BEFORE UPDATE OR DELETE ON tender_app.offer_item FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER offer_item_no_truncate BEFORE TRUNCATE ON tender_app.offer_item FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER cost_append_only BEFORE UPDATE OR DELETE ON tender_app.cost_component FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER cost_no_truncate BEFORE TRUNCATE ON tender_app.cost_component FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();
-- Preserve legacy fields but permit unknown confidence and independent extraction runs.
ALTER TABLE tender_app.extracted_field ALTER COLUMN confidence DROP NOT NULL;
ALTER TABLE tender_app.extracted_field DROP CONSTRAINT extracted_field_document_id_document_revision_field_name_key;
CREATE UNIQUE INDEX extracted_field_legacy_unique ON tender_app.extracted_field(document_id,document_revision,field_name) WHERE run_id IS NULL;
CREATE UNIQUE INDEX extracted_field_run_unique ON tender_app.extracted_field(run_id,field_name) WHERE run_id IS NOT NULL;
ALTER TABLE tender_app.offer_package ADD UNIQUE(id,tender_id,supplier_id);
ALTER TABLE tender_app.offer ADD FOREIGN KEY(offer_package_id,tender_id,supplier_id) REFERENCES tender_app.offer_package(id,tender_id,supplier_id);
CREATE TRIGGER receipt_append_only BEFORE UPDATE OR DELETE ON tender_app.document_receipt FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER receipt_no_truncate BEFORE TRUNCATE ON tender_app.document_receipt FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();