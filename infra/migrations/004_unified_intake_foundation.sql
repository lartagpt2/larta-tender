-- TASK-011B: additive, isolated disposable databases only. Original 001/002/003 unchanged.
CREATE TABLE tender_app.intake_batch (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id),
 request_key uuid NOT NULL, request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 stage_id uuid, actor_id uuid NOT NULL REFERENCES tender_app.app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 outcomes jsonb NOT NULL CHECK(jsonb_typeof(outcomes)='array'),
 UNIQUE(tender_id,request_key), UNIQUE(id,tender_id),
 FOREIGN KEY(stage_id,tender_id) REFERENCES tender_app.tender_stage(id,tender_id)
);
CREATE TABLE tender_app.intake_document (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id),
 blob_sha256 char(64) NOT NULL REFERENCES tender_app.blob(sha256),
 original_name text NOT NULL CHECK(length(original_name) BETWEEN 1 AND 255),
 mime_type text NOT NULL, created_by uuid NOT NULL REFERENCES tender_app.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(), origin_legacy_document_id uuid,
 UNIQUE(tender_id,blob_sha256), UNIQUE(id,tender_id), UNIQUE(id,tender_id,blob_sha256),
 FOREIGN KEY(origin_legacy_document_id,tender_id) REFERENCES tender_app.document(id,tender_id)
);
CREATE TABLE tender_app.intake_receipt (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id),
 batch_id uuid NOT NULL, original_id uuid NOT NULL,
 top_level_index integer NOT NULL CHECK(top_level_index BETWEEN 0 AND 9),
 part_path text NOT NULL CHECK(length(part_path) BETWEEN 1 AND 64), parent_receipt_id uuid,
 channel text NOT NULL CHECK(channel IN ('manual','email')), declared_sender text,
 original_name text NOT NULL CHECK(length(original_name) BETWEEN 1 AND 255), declared_mime text NOT NULL,
 stage_id uuid, received_by uuid NOT NULL REFERENCES tender_app.app_user(id), received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(batch_id,top_level_index,part_path), UNIQUE(id,tender_id), UNIQUE(id,tender_id,original_id),
 FOREIGN KEY(batch_id,tender_id) REFERENCES tender_app.intake_batch(id,tender_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(original_id,tender_id) REFERENCES tender_app.intake_document(id,tender_id),
 FOREIGN KEY(parent_receipt_id,tender_id) REFERENCES tender_app.intake_receipt(id,tender_id),
 FOREIGN KEY(stage_id,tender_id) REFERENCES tender_app.tender_stage(id,tender_id),
 CHECK(parent_receipt_id IS NULL OR parent_receipt_id<>id)
);
CREATE TABLE tender_app.intake_processing_run (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), receipt_id uuid NOT NULL,
 original_id uuid NOT NULL, source_sha char(64) NOT NULL, generation integer NOT NULL CHECK(generation>0),
 request_key uuid NOT NULL, fingerprint char(64) NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 retry_of uuid, status text NOT NULL CHECK(status IN ('blocked','queued','running','retry_wait','completed','failed','unsupported')),
 policy_version text NOT NULL, versions jsonb NOT NULL CHECK(jsonb_typeof(versions)='object'),
 model text, model_digest text, lease_token uuid, lease_expires_at timestamptz,
 attempt_count integer NOT NULL CHECK(attempt_count>=0), state_revision integer NOT NULL CHECK(state_revision>0),
 error_code text, created_by uuid NOT NULL REFERENCES tender_app.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(receipt_id,generation), UNIQUE(tender_id,request_key), UNIQUE(id,tender_id,receipt_id),
 UNIQUE(id,tender_id,receipt_id,original_id,source_sha),
 FOREIGN KEY(receipt_id,tender_id,original_id) REFERENCES tender_app.intake_receipt(id,tender_id,original_id),
 FOREIGN KEY(original_id,tender_id,source_sha) REFERENCES tender_app.intake_document(id,tender_id,blob_sha256),
 FOREIGN KEY(retry_of,tender_id,receipt_id) REFERENCES tender_app.intake_processing_run(id,tender_id,receipt_id),
 CHECK((status IN ('completed','failed','unsupported'))=(completed_at IS NOT NULL)),
 CHECK((lease_token IS NULL)=(lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX intake_one_active_run ON tender_app.intake_processing_run(receipt_id)
 WHERE status IN ('blocked','queued','running','retry_wait');
CREATE TABLE tender_app.intake_run_event (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), run_id uuid NOT NULL,
 receipt_id uuid NOT NULL, state_revision integer NOT NULL CHECK(state_revision>0),
 to_state text NOT NULL CHECK(to_state IN ('blocked','queued','running','retry_wait','completed','failed','unsupported')),
 code text, actor_id uuid NOT NULL REFERENCES tender_app.app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,state_revision),
 FOREIGN KEY(run_id,tender_id,receipt_id) REFERENCES tender_app.intake_processing_run(id,tender_id,receipt_id)
);
CREATE TABLE tender_app.intake_result (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), run_id uuid NOT NULL,
 receipt_id uuid NOT NULL, original_id uuid NOT NULL, source_sha char(64) NOT NULL,
 schema_version text NOT NULL, rules_version text NOT NULL, output jsonb NOT NULL CHECK(jsonb_typeof(output)='object'),
 output_sha char(64) NOT NULL CHECK(output_sha ~ '^[a-f0-9]{64}$'),
 coverage jsonb NOT NULL CHECK(jsonb_typeof(coverage)='object'), completed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id), UNIQUE(id,tender_id,receipt_id), UNIQUE(id,tender_id,receipt_id,original_id,source_sha),
 FOREIGN KEY(run_id,tender_id,receipt_id,original_id,source_sha)
 REFERENCES tender_app.intake_processing_run(id,tender_id,receipt_id,original_id,source_sha)
);
CREATE TABLE tender_app.intake_evidence (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), result_id uuid NOT NULL,
 original_id uuid NOT NULL, receipt_id uuid NOT NULL, source_sha char(64) NOT NULL,
 field_path text NOT NULL, page integer CHECK(page>0), sheet text, cell_range text,
 excerpt text NOT NULL CHECK(length(excerpt) BETWEEN 1 AND 2000), method text NOT NULL,
 UNIQUE(id,result_id,receipt_id,tender_id),
 FOREIGN KEY(result_id,tender_id,receipt_id,original_id,source_sha)
 REFERENCES tender_app.intake_result(id,tender_id,receipt_id,original_id,source_sha)
);
CREATE TABLE tender_app.intake_classification_revision (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), receipt_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 type text NOT NULL CHECK(type IN ('specification','offer','quality_certificate','supporting','unknown')),
 review_state text NOT NULL CHECK(review_state IN ('proposed','needs_review','confirmed','rejected','superseded')),
 source text NOT NULL CHECK(source IN ('rules','human')), result_id uuid, evidence_id uuid,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000), supersedes_id uuid,
 created_by uuid NOT NULL REFERENCES tender_app.app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(receipt_id,revision), UNIQUE(id,receipt_id,tender_id),
 FOREIGN KEY(receipt_id,tender_id) REFERENCES tender_app.intake_receipt(id,tender_id),
 FOREIGN KEY(result_id,tender_id,receipt_id) REFERENCES tender_app.intake_result(id,tender_id,receipt_id),
 FOREIGN KEY(evidence_id,result_id,receipt_id,tender_id) REFERENCES tender_app.intake_evidence(id,result_id,receipt_id,tender_id),
 FOREIGN KEY(supersedes_id,receipt_id,tender_id) REFERENCES tender_app.intake_classification_revision(id,receipt_id,tender_id),
 CHECK(source<>'rules' OR (result_id IS NOT NULL AND review_state IN ('proposed','needs_review'))),
 CHECK(source<>'human' OR review_state IN ('confirmed','rejected'))
);
CREATE TABLE tender_app.intake_classification_head (
 receipt_id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id),
 current_revision_id uuid NOT NULL, approved_revision_id uuid, state_revision integer NOT NULL CHECK(state_revision>0),
 FOREIGN KEY(receipt_id,tender_id) REFERENCES tender_app.intake_receipt(id,tender_id),
 FOREIGN KEY(current_revision_id,receipt_id,tender_id) REFERENCES tender_app.intake_classification_revision(id,receipt_id,tender_id),
 FOREIGN KEY(approved_revision_id,receipt_id,tender_id) REFERENCES tender_app.intake_classification_revision(id,receipt_id,tender_id)
);
CREATE INDEX intake_receipts_tender ON tender_app.intake_receipt(tender_id,received_at,id);
CREATE INDEX intake_runs_tender_status ON tender_app.intake_processing_run(tender_id,status);
CREATE FUNCTION tender_app.protect_intake_run_input() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','lease_token','lease_expires_at','attempt_count','state_revision','error_code','completed_at']::text[])
 IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['status','lease_token','lease_expires_at','attempt_count','state_revision','error_code','completed_at']::text[]) THEN
  RAISE EXCEPTION 'intake processing input is immutable' USING ERRCODE='55000';
 END IF;
 IF NEW.state_revision<>OLD.state_revision+1 THEN RAISE EXCEPTION 'stale processing revision' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION tender_app.protect_intake_head() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.receipt_id<>OLD.receipt_id OR NEW.tender_id<>OLD.tender_id OR NEW.state_revision<>OLD.state_revision+1 THEN
  RAISE EXCEPTION 'invalid classification head revision' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_run_input_immutable BEFORE UPDATE ON tender_app.intake_processing_run FOR EACH ROW EXECUTE FUNCTION tender_app.protect_intake_run_input();
CREATE TRIGGER intake_head_identity_immutable BEFORE UPDATE ON tender_app.intake_classification_head FOR EACH ROW EXECUTE FUNCTION tender_app.protect_intake_head();
CREATE TRIGGER intake_run_no_delete BEFORE DELETE ON tender_app.intake_processing_run FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER intake_head_no_delete BEFORE DELETE ON tender_app.intake_classification_head FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
DO $$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['intake_batch','intake_document','intake_receipt','intake_processing_run','intake_run_event','intake_result','intake_evidence','intake_classification_revision','intake_classification_head']
 LOOP
  EXECUTE format('CREATE TRIGGER lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON tender_app.%I FOR EACH ROW EXECUTE FUNCTION tender_app.guard_lifecycle_child(''tender_id'')',tbl);
  IF tbl NOT IN ('intake_processing_run','intake_classification_head') THEN
   EXECUTE format('CREATE TRIGGER intake_immutable BEFORE UPDATE OR DELETE ON tender_app.%I FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation()',tbl);
  END IF;
  EXECUTE format('CREATE TRIGGER intake_no_truncate BEFORE TRUNCATE ON tender_app.%I FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation()',tbl);
 END LOOP;
END $$;
