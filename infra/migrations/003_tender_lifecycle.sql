-- PROPOSAL ONLY. Do not run against an existing database without separate approval.
-- Additive schema; no existing tender is classified, archived or trashed.
ALTER TABLE tender_app.tender ADD COLUMN dependency_revision bigint NOT NULL DEFAULT 0, ADD COLUMN content_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE tender_app.tender_lifecycle (
 tender_id uuid PRIMARY KEY REFERENCES tender_app.tender(id),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived','trash')),
 classification text NOT NULL DEFAULT 'unclassified' CHECK(classification IN ('unclassified','synthetic','working')),
 classified_content_revision bigint, classified_ocr_hash char(64), evidence text, classified_by uuid REFERENCES tender_app.app_user(id), classified_at timestamptz,
 changed_at timestamptz NOT NULL DEFAULT now(),
 CHECK(classification <> 'synthetic' OR (length(trim(evidence)) >= 10 AND classified_by IS NOT NULL AND classified_at IS NOT NULL AND classified_content_revision IS NOT NULL AND classified_ocr_hash ~ '^[a-f0-9]{64}$')),
 CHECK(state <> 'trash' OR classification = 'synthetic'),
 CHECK(tender_id NOT IN (
 'f768e259-c0fe-4819-a62b-28d5630025c6','3c936af9-7b49-41cd-8b12-6b8c3b9a38fc',
 '240a9be8-d6e1-4fa7-a3f0-ea73bd60ef7c','af32d29e-6589-410a-a7f5-e9e8795c7975',
 '62affe51-1e91-429e-a1b7-23611be38ac3','346de0b5-f052-45a2-bdd8-d1f0882a8e5e',
 'e1f80509-6590-4b94-bc8b-4772aaaf54a5','91f1fadf-9273-416e-a881-863a6456c693'
 ) OR (state='active' AND classification='unclassified'))
);
-- Separate capabilities, not inherited from ownership or manager role. No grants seeded.
CREATE TABLE tender_app.tender_capability (
 tender_id uuid NOT NULL REFERENCES tender_app.tender(id), user_id uuid NOT NULL REFERENCES tender_app.app_user(id),
 capability text NOT NULL CHECK(capability IN ('classify_synthetic','trash_synthetic')),
 PRIMARY KEY(tender_id,user_id,capability)
);
CREATE TABLE tender_app.lifecycle_event (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id),
 actor_id uuid NOT NULL REFERENCES tender_app.app_user(id), action text NOT NULL,
 before_state jsonb NOT NULL, after_state jsonb NOT NULL, preview_hash char(64) NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tender_lifecycle_state_idx ON tender_app.tender_lifecycle(state,tender_id);
CREATE INDEX tender_list_order_idx ON tender_app.tender(created_at DESC,id);
CREATE TRIGGER lifecycle_event_immutable BEFORE UPDATE OR DELETE ON tender_app.lifecycle_event FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER lifecycle_event_no_truncate BEFORE TRUNCATE ON tender_app.lifecycle_event FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER tender_no_delete BEFORE DELETE ON tender_app.tender FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER tender_no_truncate BEFORE TRUNCATE ON tender_app.tender FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER lifecycle_no_delete BEFORE DELETE ON tender_app.tender_lifecycle FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation();
CREATE TRIGGER lifecycle_no_truncate BEFORE TRUNCATE ON tender_app.tender_lifecycle FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation();
-- Parent is the serialization point for all child writes and lifecycle previews.
CREATE FUNCTION tender_app.guard_lifecycle_child() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE payload jsonb; prior jsonb; target uuid; parent_state text;
BEGIN
 payload := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_OP='UPDATE' THEN
  prior := to_jsonb(OLD);
  IF prior->>TG_ARGV[0] IS DISTINCT FROM payload->>TG_ARGV[0] THEN
   RAISE EXCEPTION 'parent reassignment forbidden' USING ERRCODE='LT409';
  END IF;
 END IF;
 IF TG_ARGV[0]='tender_id' THEN target := (payload->>'tender_id')::uuid;
 ELSIF TG_ARGV[0]='document_id' THEN SELECT tender_id INTO target FROM tender_app.document WHERE id=(payload->>'document_id')::uuid;
 ELSIF TG_ARGV[0]='lot_id' THEN SELECT tender_id INTO target FROM tender_app.lot WHERE id=(payload->>'lot_id')::uuid;
 ELSIF TG_ARGV[0]='offer_version_id' THEN SELECT tender_id INTO target FROM tender_app.offer_version WHERE id=(payload->>'offer_version_id')::uuid;
 ELSIF TG_ARGV[0]='comparison_id' THEN SELECT tender_id INTO target FROM tender_app.comparison WHERE id=(payload->>'comparison_id')::uuid;
 END IF;
 IF target IS NULL THEN RAISE EXCEPTION 'missing parent' USING ERRCODE='LT409'; END IF;
 PERFORM 1 FROM tender_app.tender WHERE id=target FOR UPDATE;
 SELECT state INTO parent_state FROM tender_app.tender_lifecycle WHERE tender_id=target;
 IF TG_TABLE_NAME NOT IN ('audit_event','lifecycle_event','tender_lifecycle','tender_capability') AND COALESCE(parent_state,'active') <> 'active' THEN
  RAISE EXCEPTION 'tender is read only' USING ERRCODE='LT409';
 END IF;
 UPDATE tender_app.tender SET dependency_revision=dependency_revision+1, content_revision=content_revision+CASE WHEN TG_TABLE_NAME IN ('audit_event','lifecycle_event','tender_lifecycle','tender_capability') THEN 0 ELSE 1 END WHERE id=target;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE FUNCTION tender_app.guard_lifecycle_tender() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (to_jsonb(NEW)-'dependency_revision'-'content_revision') IS DISTINCT FROM (to_jsonb(OLD)-'dependency_revision'-'content_revision') AND
 EXISTS(SELECT 1 FROM tender_app.tender_lifecycle WHERE tender_id=OLD.id AND state<>'active') THEN
  RAISE EXCEPTION 'tender is read only' USING ERRCODE='LT409';
 END IF;
 IF (to_jsonb(NEW)-'dependency_revision'-'content_revision') IS DISTINCT FROM (to_jsonb(OLD)-'dependency_revision'-'content_revision') THEN NEW.content_revision := OLD.content_revision+1; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER lifecycle_guard BEFORE UPDATE ON tender_app.tender FOR EACH ROW EXECUTE FUNCTION tender_app.guard_lifecycle_tender();
DO $$
DECLARE item record;
BEGIN
 FOR item IN SELECT table_name FROM information_schema.columns WHERE table_schema='tender_app' AND column_name='tender_id' LOOP
  EXECUTE format('CREATE TRIGGER lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON tender_app.%I FOR EACH ROW EXECUTE FUNCTION tender_app.guard_lifecycle_child(''tender_id'')',item.table_name);
 END LOOP;
 FOR item IN SELECT * FROM (VALUES
  ('lot_item','lot_id'),('extracted_field','document_id'),('extraction_run','document_id'),
  ('evidence_reference','document_id'),('field_decision','document_id'),('offer_item','offer_version_id'),
  ('cost_component','offer_version_id'),('comparison_offer','comparison_id')) AS links(tbl,col) LOOP
  EXECUTE format('CREATE TRIGGER lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON tender_app.%I FOR EACH ROW EXECUTE FUNCTION tender_app.guard_lifecycle_child(%L)',item.tbl,item.col);
 END LOOP;
END $$;