-- TASK-011E. Additive bridge; old migration files and immutable triggers are unchanged.
ALTER TABLE tender_app.offer_version ADD UNIQUE(id,tender_id);
ALTER TABLE tender_app.intake_association_revision ADD UNIQUE(id,receipt_id,tender_id,company_id);
ALTER TABLE tender_app.intake_company DROP CONSTRAINT intake_company_confirmed_supplier_id_check;
ALTER TABLE tender_app.intake_association_head DROP CONSTRAINT intake_association_head_approved_revision_id_check;
ALTER TABLE tender_app.intake_association_revision DROP CONSTRAINT intake_association_revision_state_check;
ALTER TABLE tender_app.intake_association_revision ADD CHECK(state IN ('proposed','confirmed','rejected','deferred','revoked'));
ALTER TABLE tender_app.intake_association_revision ADD COLUMN created_by uuid REFERENCES tender_app.app_user(id);
ALTER TABLE tender_app.intake_review_decision DROP CONSTRAINT intake_review_decision_action_check;
ALTER TABLE tender_app.intake_review_decision DROP CONSTRAINT intake_review_decision_source_check;
ALTER TABLE tender_app.intake_review_decision ADD CHECK(action IN ('resolve','edit','confirm','choose_existing','reject','defer','classification','association','transfer','commercial'));
ALTER TABLE tender_app.intake_review_decision DROP CONSTRAINT intake_review_decision_expected_revision_check;
ALTER TABLE tender_app.intake_review_decision ADD CHECK(expected_revision>=0);
ALTER TABLE tender_app.intake_review_decision ADD CHECK(source IN ('system','human'));
CREATE UNIQUE INDEX intake_one_confirmed_supplier_per_receipt ON tender_app.intake_association_head(receipt_id)
 WHERE association_type='supplier_of' AND approved_revision_id IS NOT NULL;
-- Extend the mutable CAS head guard only. Append-only revision/evidence/decision guards remain unchanged.
CREATE OR REPLACE FUNCTION tender_app.guard_organization_head() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE allowed text[]; valid boolean;
BEGIN
 allowed:=ARRAY['current_revision_id','state_revision'];
 IF TG_TABLE_NAME='intake_company' THEN allowed:=array_append(allowed,'confirmed_supplier_id'); ELSE allowed:=array_append(allowed,'approved_revision_id'); END IF;
 IF (to_jsonb(NEW)-allowed) IS DISTINCT FROM (to_jsonb(OLD)-allowed) OR NEW.state_revision<>OLD.state_revision+1 THEN
  RAISE EXCEPTION 'stale or reassigned organization head' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='intake_company' THEN
  SELECT true INTO valid FROM tender_app.intake_company_revision r WHERE r.id=NEW.current_revision_id AND r.company_id=NEW.id AND r.tender_id=NEW.tender_id AND r.revision=NEW.state_revision
   AND (NEW.confirmed_supplier_id IS NULL OR (r.review_state='confirmed' AND r.source='human'));
 ELSE
  SELECT true INTO valid FROM tender_app.intake_association_revision r WHERE r.id=NEW.current_revision_id AND r.receipt_id=NEW.receipt_id AND r.association_key=NEW.association_key AND r.tender_id=NEW.tender_id AND r.revision=NEW.state_revision
   AND (NEW.approved_revision_id IS NULL OR EXISTS(SELECT 1 FROM tender_app.intake_association_revision approved WHERE approved.id=NEW.approved_revision_id AND approved.receipt_id=NEW.receipt_id AND approved.tender_id=NEW.tender_id AND approved.association_key=NEW.association_key AND approved.state='confirmed' AND approved.created_by IS NOT NULL));
 END IF;
 IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'organization head revision mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TABLE tender_app.intake_legacy_projection (
 original_id uuid NOT NULL, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), purpose text NOT NULL CHECK(purpose IN ('offer','specification')),
 legacy_document_id uuid NOT NULL, classification_revision_id uuid NOT NULL, receipt_id uuid NOT NULL,
 owned_document boolean NOT NULL, created_by uuid NOT NULL REFERENCES tender_app.app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(original_id,purpose), UNIQUE(original_id,purpose,tender_id,legacy_document_id),
 FOREIGN KEY(original_id,tender_id) REFERENCES tender_app.intake_document(id,tender_id),
 FOREIGN KEY(legacy_document_id,tender_id) REFERENCES tender_app.document(id,tender_id),
 FOREIGN KEY(classification_revision_id,receipt_id,tender_id) REFERENCES tender_app.intake_classification_revision(id,receipt_id,tender_id),
 FOREIGN KEY(receipt_id,tender_id) REFERENCES tender_app.intake_receipt(id,tender_id)
);
CREATE TABLE tender_app.intake_receipt_projection (
 receipt_id uuid NOT NULL, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), purpose text NOT NULL,
 original_id uuid NOT NULL, legacy_document_id uuid NOT NULL, legacy_receipt_id uuid REFERENCES tender_app.field_decision(id),
 classification_revision_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES tender_app.app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(receipt_id,purpose), UNIQUE(legacy_receipt_id), UNIQUE(receipt_id,tender_id,legacy_document_id,legacy_receipt_id),
 CHECK((purpose='offer' AND legacy_receipt_id IS NOT NULL) OR (purpose='specification' AND legacy_receipt_id IS NULL)),
 FOREIGN KEY(original_id,purpose,tender_id,legacy_document_id) REFERENCES tender_app.intake_legacy_projection(original_id,purpose,tender_id,legacy_document_id),
 FOREIGN KEY(receipt_id,tender_id) REFERENCES tender_app.intake_receipt(id,tender_id),
 FOREIGN KEY(classification_revision_id,receipt_id,tender_id) REFERENCES tender_app.intake_classification_revision(id,receipt_id,tender_id)
);
CREATE FUNCTION tender_app.guard_intake_projection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM tender_app.intake_receipt r JOIN tender_app.intake_document i ON i.id=r.original_id AND i.tender_id=r.tender_id
 JOIN tender_app.document d ON d.id=NEW.legacy_document_id AND d.tender_id=r.tender_id
 JOIN tender_app.intake_classification_revision cr ON cr.id=NEW.classification_revision_id AND cr.receipt_id=r.id AND cr.tender_id=r.tender_id
 WHERE r.id=NEW.receipt_id AND r.tender_id=NEW.tender_id AND r.original_id=NEW.original_id AND d.blob_sha256=i.blob_sha256 AND d.purpose=NEW.purpose AND cr.type=NEW.purpose AND cr.review_state='confirmed' AND cr.source='human') THEN
 RAISE EXCEPTION 'projection context mismatch' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='intake_receipt_projection' THEN
 IF NEW.purpose='offer' AND NOT EXISTS(SELECT 1 FROM tender_app.field_decision f WHERE f.id=NEW.legacy_receipt_id AND f.document_id=NEW.legacy_document_id AND f.field_key='offer.received.v1' AND f.value::jsonb->>'intakeReceiptId'=NEW.receipt_id::text) THEN
 RAISE EXCEPTION 'projection must reference the actual offer receipt' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER projection_context BEFORE INSERT ON tender_app.intake_legacy_projection FOR EACH ROW EXECUTE FUNCTION tender_app.guard_intake_projection();
CREATE TRIGGER projection_context BEFORE INSERT ON tender_app.intake_receipt_projection FOR EACH ROW EXECUTE FUNCTION tender_app.guard_intake_projection();
CREATE TABLE tender_app.intake_commercial_result (
 result_id uuid PRIMARY KEY,tender_id uuid NOT NULL,receipt_id uuid NOT NULL,
 schema_version text NOT NULL CHECK(schema_version='intake-commercial-native-v1'),method text NOT NULL CHECK(method IN ('native_labeled','test_mock')),model boolean NOT NULL CHECK(model=false),
 output jsonb NOT NULL CHECK(jsonb_typeof(output)='object'),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(result_id,tender_id,receipt_id) REFERENCES tender_app.intake_result(id,tender_id,receipt_id)
);
CREATE TABLE tender_app.intake_manual_source (
 id uuid PRIMARY KEY,tender_id uuid NOT NULL REFERENCES tender_app.tender(id),receipt_id uuid NOT NULL,result_id uuid NOT NULL,
 field_path text NOT NULL,value jsonb NOT NULL,value_hash char(64) NOT NULL CHECK(value_hash ~ '^[a-f0-9]{64}$'),
 note text NOT NULL CHECK(length(trim(note)) BETWEEN 1 AND 2000),actor_id uuid NOT NULL REFERENCES tender_app.app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,result_id,receipt_id,tender_id,field_path,value_hash),
 FOREIGN KEY(result_id,tender_id,receipt_id) REFERENCES tender_app.intake_result(id,tender_id,receipt_id)
);
CREATE TABLE tender_app.intake_commercial_draft (
 id uuid PRIMARY KEY,tender_id uuid NOT NULL REFERENCES tender_app.tender(id),receipt_id uuid NOT NULL,result_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),context_token char(64) NOT NULL,
 form jsonb NOT NULL CHECK(jsonb_typeof(form)='object'),created_by uuid NOT NULL REFERENCES tender_app.app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(receipt_id,revision),UNIQUE(id,result_id,receipt_id,tender_id),
 FOREIGN KEY(result_id,tender_id,receipt_id) REFERENCES tender_app.intake_result(id,tender_id,receipt_id)
);
CREATE TABLE tender_app.intake_draft_field (
 id uuid PRIMARY KEY,tender_id uuid NOT NULL,receipt_id uuid NOT NULL,result_id uuid NOT NULL,draft_id uuid NOT NULL,
 field_path text NOT NULL,value_hash char(64) NOT NULL CHECK(value_hash ~ '^[a-f0-9]{64}$'),evidence_id uuid,manual_decision_id uuid,
 UNIQUE(draft_id,field_path),CHECK((evidence_id IS NULL)<>(manual_decision_id IS NULL)),
 FOREIGN KEY(draft_id,result_id,receipt_id,tender_id) REFERENCES tender_app.intake_commercial_draft(id,result_id,receipt_id,tender_id),
 FOREIGN KEY(evidence_id,result_id,receipt_id,tender_id) REFERENCES tender_app.intake_evidence(id,result_id,receipt_id,tender_id),
 FOREIGN KEY(manual_decision_id,result_id,receipt_id,tender_id,field_path,value_hash) REFERENCES tender_app.intake_manual_source(id,result_id,receipt_id,tender_id,field_path,value_hash)
);
CREATE TABLE tender_app.intake_verification_context (
 offer_version_id uuid PRIMARY KEY,tender_id uuid NOT NULL,receipt_id uuid NOT NULL,result_id uuid NOT NULL,company_id uuid NOT NULL,
 company_revision_id uuid NOT NULL,classification_revision_id uuid NOT NULL,association_revision_id uuid NOT NULL,
 supplier_id uuid NOT NULL,context_token char(64) NOT NULL,draft_id uuid NOT NULL,intent text NOT NULL CHECK(intent IN ('draft','confirm')),
 UNIQUE(offer_version_id,tender_id,receipt_id,result_id),
 FOREIGN KEY(offer_version_id,tender_id) REFERENCES tender_app.offer_version(id,tender_id),
 FOREIGN KEY(result_id,tender_id,receipt_id) REFERENCES tender_app.intake_result(id,tender_id,receipt_id),
 FOREIGN KEY(company_revision_id,company_id,tender_id) REFERENCES tender_app.intake_company_revision(id,company_id,tender_id),
 FOREIGN KEY(classification_revision_id,receipt_id,tender_id) REFERENCES tender_app.intake_classification_revision(id,receipt_id,tender_id),
 FOREIGN KEY(tender_id,supplier_id) REFERENCES tender_app.tender_supplier(tender_id,supplier_id),
 FOREIGN KEY(association_revision_id,receipt_id,tender_id,company_id) REFERENCES tender_app.intake_association_revision(id,receipt_id,tender_id,company_id),
 FOREIGN KEY(draft_id,result_id,receipt_id,tender_id) REFERENCES tender_app.intake_commercial_draft(id,result_id,receipt_id,tender_id)
);
CREATE TABLE tender_app.intake_field_lineage (
 id uuid PRIMARY KEY,tender_id uuid NOT NULL,offer_version_id uuid NOT NULL,receipt_id uuid NOT NULL,result_id uuid NOT NULL,
 field_path text NOT NULL,lot_item_id uuid,lot_id uuid,evidence_id uuid,manual_decision_id uuid,
 transferred_value_hash char(64) NOT NULL CHECK(transferred_value_hash ~ '^[a-f0-9]{64}$'),
 UNIQUE(offer_version_id,field_path),CHECK((evidence_id IS NULL)<>(manual_decision_id IS NULL)),
 CHECK((lot_item_id IS NULL)=(lot_id IS NULL)),
 FOREIGN KEY(offer_version_id,tender_id,receipt_id,result_id) REFERENCES tender_app.intake_verification_context(offer_version_id,tender_id,receipt_id,result_id),
 FOREIGN KEY(offer_version_id,lot_id) REFERENCES tender_app.offer_version(id,lot_id),
 FOREIGN KEY(lot_item_id,lot_id) REFERENCES tender_app.lot_item(id,lot_id),
 FOREIGN KEY(evidence_id,result_id,receipt_id,tender_id) REFERENCES tender_app.intake_evidence(id,result_id,receipt_id,tender_id),
 FOREIGN KEY(manual_decision_id,result_id,receipt_id,tender_id,field_path,transferred_value_hash) REFERENCES tender_app.intake_manual_source(id,result_id,receipt_id,tender_id,field_path,value_hash)
);
CREATE FUNCTION tender_app.guard_intake_verification_context() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM tender_app.intake_association_revision a WHERE a.id=NEW.association_revision_id AND a.receipt_id=NEW.receipt_id AND a.tender_id=NEW.tender_id AND a.company_id=NEW.company_id AND a.association_type='supplier_of' AND a.state='confirmed') THEN
 RAISE EXCEPTION 'invalid commercial association context' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER verification_context_guard BEFORE INSERT ON tender_app.intake_verification_context FOR EACH ROW EXECUTE FUNCTION tender_app.guard_intake_verification_context();
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['intake_commercial_result','intake_legacy_projection','intake_receipt_projection','intake_manual_source','intake_commercial_draft','intake_draft_field','intake_verification_context','intake_field_lineage'] LOOP
 EXECUTE format('CREATE TRIGGER lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON tender_app.%I FOR EACH ROW EXECUTE FUNCTION tender_app.guard_lifecycle_child(''tender_id'')',tbl);
 EXECUTE format('CREATE TRIGGER intake_bridge_immutable BEFORE UPDATE OR DELETE ON tender_app.%I FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation()',tbl);
 EXECUTE format('CREATE TRIGGER intake_bridge_no_truncate BEFORE TRUNCATE ON tender_app.%I FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation()',tbl);
 END LOOP;
END $$;