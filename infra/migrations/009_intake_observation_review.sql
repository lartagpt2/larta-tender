-- TASK-011E continuation: observation-specific human rejection, immutable FK-backed history.
BEGIN;
ALTER TABLE tender_app.intake_review_decision ADD UNIQUE(id,tender_id,result_id,receipt_id);
CREATE TABLE tender_app.intake_observation_decision (
 id uuid PRIMARY KEY,tender_id uuid NOT NULL REFERENCES tender_app.tender(id),
 observation_id uuid NOT NULL,result_id uuid NOT NULL,receipt_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),action text NOT NULL CHECK(action='reject'),
 review_decision_id uuid NOT NULL UNIQUE,actor_id uuid NOT NULL REFERENCES tender_app.app_user(id),
 note text NOT NULL CHECK(length(trim(note)) BETWEEN 1 AND 1000),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(observation_id,revision),
 FOREIGN KEY(observation_id,result_id,receipt_id,tender_id) REFERENCES tender_app.intake_organization_observation(id,result_id,receipt_id,tender_id),
 FOREIGN KEY(review_decision_id,tender_id,result_id,receipt_id) REFERENCES tender_app.intake_review_decision(id,tender_id,result_id,receipt_id)
);
CREATE FUNCTION tender_app.guard_observation_decision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.revision <> COALESCE((SELECT max(d.revision) FROM tender_app.intake_observation_decision d WHERE d.observation_id=NEW.observation_id),0)+1 THEN RAISE EXCEPTION 'stale observation revision' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM tender_app.intake_review_decision d WHERE d.id=NEW.review_decision_id AND d.tender_id=NEW.tender_id AND d.receipt_id=NEW.receipt_id AND d.result_id=NEW.result_id AND d.source='human' AND d.action='reject' AND d.actor_id=NEW.actor_id AND d.after_state->>'observationId'=NEW.observation_id::text AND (d.after_state->>'revision')::integer=NEW.revision) THEN RAISE EXCEPTION 'observation decision mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER observation_decision_context BEFORE INSERT ON tender_app.intake_observation_decision FOR EACH ROW EXECUTE FUNCTION tender_app.guard_observation_decision();
CREATE TRIGGER lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON tender_app.intake_observation_decision FOR EACH ROW EXECUTE FUNCTION tender_app.guard_lifecycle_child('tender_id');
CREATE TRIGGER observation_decision_immutable BEFORE UPDATE OR DELETE ON tender_app.intake_observation_decision FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER observation_decision_no_truncate BEFORE TRUNCATE ON tender_app.intake_observation_decision FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();
COMMIT;
