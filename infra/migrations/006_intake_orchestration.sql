-- Durable orchestration; additive migration, disposable UUID databases only.
ALTER TABLE tender_app.intake_processing_run
 ADD COLUMN worker_id text,
 ADD COLUMN stage text NOT NULL DEFAULT 'registered',
 ADD COLUMN coverage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(coverage)='object'),
 ADD COLUMN next_attempt_at timestamptz,
 ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN enqueue_order bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE tender_app.intake_run_event ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE tender_app.intake_run_event ADD COLUMN worker_id text, ADD COLUMN stage text,
 ADD CONSTRAINT intake_event_identity CHECK((actor_id IS NULL)<>(worker_id IS NULL));
ALTER TABLE tender_app.audit_event ADD COLUMN worker_id text;
ALTER TABLE tender_app.intake_company_revision ADD COLUMN worker_id text;
ALTER TABLE tender_app.intake_review_decision ADD COLUMN worker_id text;
CREATE TABLE tender_app.intake_processing_operation (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), receipt_id uuid NOT NULL,
 operation_key uuid NOT NULL, request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 run_id uuid NOT NULL, expected_revision integer NOT NULL CHECK(expected_revision>0),
 action text NOT NULL CHECK(action IN ('reprocess','cancel')), reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 actor_id uuid NOT NULL REFERENCES tender_app.app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tender_id,operation_key),
 FOREIGN KEY(run_id,tender_id,receipt_id) REFERENCES tender_app.intake_processing_run(id,tender_id,receipt_id)
);
CREATE TRIGGER lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON tender_app.intake_processing_operation FOR EACH ROW EXECUTE FUNCTION tender_app.guard_lifecycle_child('tender_id');
CREATE TRIGGER operation_immutable BEFORE UPDATE OR DELETE ON tender_app.intake_processing_operation FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER operation_no_truncate BEFORE TRUNCATE ON tender_app.intake_processing_operation FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TABLE tender_app.intake_processing_checkpoint (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id),receipt_id uuid NOT NULL,run_id uuid NOT NULL,
 stage text NOT NULL CHECK(stage IN ('classification','organizations')),payload jsonb NOT NULL,payload_sha char(64) NOT NULL CHECK(payload_sha ~ '^[a-f0-9]{64}$'),
 schema_version text NOT NULL,worker_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,stage),
 FOREIGN KEY(run_id,tender_id,receipt_id) REFERENCES tender_app.intake_processing_run(id,tender_id,receipt_id)
);
CREATE TRIGGER lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON tender_app.intake_processing_checkpoint FOR EACH ROW EXECUTE FUNCTION tender_app.guard_lifecycle_child('tender_id');
CREATE TRIGGER checkpoint_immutable BEFORE UPDATE OR DELETE ON tender_app.intake_processing_checkpoint FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER checkpoint_no_truncate BEFORE TRUNCATE ON tender_app.intake_processing_checkpoint FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();
CREATE OR REPLACE FUNCTION tender_app.protect_intake_run_input() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','lease_token','lease_expires_at','attempt_count','state_revision','error_code','completed_at','worker_id','stage','coverage','next_attempt_at','updated_at']::text[])
 IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['status','lease_token','lease_expires_at','attempt_count','state_revision','error_code','completed_at','worker_id','stage','coverage','next_attempt_at','updated_at']::text[]) THEN
  RAISE EXCEPTION 'intake processing input is immutable' USING ERRCODE='55000';
 END IF;
 IF NEW.state_revision<>OLD.state_revision+1 THEN RAISE EXCEPTION 'stale processing revision' USING ERRCODE='55000'; END IF;
 IF OLD.status IN ('completed','failed','unsupported') THEN RAISE EXCEPTION 'terminal processing run' USING ERRCODE='55000'; END IF;
 IF OLD.status='blocked' AND NEW.status NOT IN ('blocked','failed') THEN RAISE EXCEPTION 'blocked run requires explicit cancellation and new generation' USING ERRCODE='55000'; END IF;
 IF NEW.attempt_count>3 THEN RAISE EXCEPTION 'attempt limit' USING ERRCODE='55000'; END IF;
 IF OLD.status='running' AND OLD.lease_expires_at<=clock_timestamp() AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token AND NEW.status IN ('completed','failed') THEN
  RAISE EXCEPTION 'expired worker cannot finalize' USING ERRCODE='55000'; END IF;
 NEW.updated_at:=clock_timestamp();
 RETURN NEW;
END $$;
CREATE INDEX intake_queue_ready ON tender_app.intake_processing_run(status,next_attempt_at,enqueue_order);
-- Document relations may use metadata/text proof without inventing an organization.
ALTER TABLE tender_app.intake_association_revision ALTER COLUMN observation_id DROP NOT NULL;
ALTER TABLE tender_app.intake_association_revision ADD CONSTRAINT association_observation_required
 CHECK(observation_id IS NOT NULL OR (company_id IS NULL AND target_receipt_id IS NOT NULL));
CREATE FUNCTION tender_app.guard_intake_document_relation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE eid uuid;
BEGIN
 IF NEW.observation_id IS NULL THEN
  FOREACH eid IN ARRAY NEW.evidence_ids LOOP
   IF NOT EXISTS(SELECT 1 FROM tender_app.intake_evidence e WHERE e.id=eid AND e.tender_id=NEW.tender_id AND e.receipt_id=NEW.receipt_id
    AND e.field_path LIKE 'relations.%') THEN RAISE EXCEPTION 'unrelated document relation proof' USING ERRCODE='23514'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
-- Retain the C reference guard for company links; a separate trigger covers document-only links.
DROP TRIGGER org_reference_guard ON tender_app.intake_association_revision;
CREATE TRIGGER org_reference_guard BEFORE INSERT ON tender_app.intake_association_revision FOR EACH ROW WHEN(NEW.observation_id IS NOT NULL) EXECUTE FUNCTION tender_app.guard_organization_references();
CREATE TRIGGER document_relation_guard BEFORE INSERT ON tender_app.intake_association_revision FOR EACH ROW EXECUTE FUNCTION tender_app.guard_intake_document_relation();
-- Persist one event in the same transaction for every run state revision, including heartbeat/stages.
CREATE FUNCTION tender_app.require_intake_run_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM tender_app.intake_run_event e WHERE e.run_id=NEW.id AND e.state_revision=NEW.state_revision AND e.to_state=NEW.status) THEN
  RAISE EXCEPTION 'processing transition requires event' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER run_event_required AFTER INSERT OR UPDATE ON tender_app.intake_processing_run DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tender_app.require_intake_run_event();
