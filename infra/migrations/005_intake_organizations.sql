-- TASK-011C additive extension. Reviewed disposable UUID databases only.
CREATE TABLE tender_app.intake_organization_result (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), receipt_id uuid NOT NULL,
 classification_result_id uuid NOT NULL, original_id uuid NOT NULL, source_sha char(64) NOT NULL,
 schema_version text NOT NULL CHECK(schema_version='intake-organizations-v1'),
 policy_version text NOT NULL, output jsonb NOT NULL CHECK(jsonb_typeof(output)='array'),
 output_sha char(64) NOT NULL CHECK(output_sha ~ '^[a-f0-9]{64}$'),
 extraction_method text NOT NULL CHECK(extraction_method IN ('native_labeled','localai','test_mock')),
 model boolean NOT NULL CHECK(model=false), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(classification_result_id), UNIQUE(id,tender_id,receipt_id,classification_result_id),
 UNIQUE(id,tender_id), UNIQUE(id,tender_id,receipt_id),
 FOREIGN KEY(classification_result_id,tender_id,receipt_id,original_id,source_sha)
 REFERENCES tender_app.intake_result(id,tender_id,receipt_id,original_id,source_sha)
);
CREATE TABLE tender_app.intake_organization_observation (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), result_id uuid NOT NULL,
 receipt_id uuid NOT NULL, classification_result_id uuid NOT NULL, local_key text NOT NULL,
 origin_key char(64) NOT NULL CHECK(origin_key ~ '^[a-f0-9]{64}$'),
 role text NOT NULL CHECK(role IN ('supplier','buyer','manufacturer','carrier','other','unknown')),
 name text, legal_name text, country text, identifiers jsonb NOT NULL CHECK(jsonb_typeof(identifiers)='array'),
 address text, emails jsonb NOT NULL CHECK(jsonb_typeof(emails)='array'), contacts jsonb NOT NULL CHECK(jsonb_typeof(contacts)='array'),
 evidence_by_field jsonb NOT NULL CHECK(jsonb_typeof(evidence_by_field)='object'),
 extraction_method text NOT NULL CHECK(extraction_method IN ('native_labeled','localai','test_mock')),
 review_state text NOT NULL CHECK(review_state IN ('proposed','needs_review')),
 warnings jsonb NOT NULL CHECK(jsonb_typeof(warnings)='array'), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(result_id,local_key), UNIQUE(id,tender_id), UNIQUE(id,result_id,receipt_id,tender_id),
 FOREIGN KEY(result_id,tender_id,receipt_id,classification_result_id)
 REFERENCES tender_app.intake_organization_result(id,tender_id,receipt_id,classification_result_id)
);
CREATE TABLE tender_app.intake_company (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id),
 origin_observation_id uuid NOT NULL, origin_observation_key char(64) NOT NULL,
 current_revision_id uuid NOT NULL, state_revision integer NOT NULL CHECK(state_revision>0),
 confirmed_supplier_id uuid CHECK(confirmed_supplier_id IS NULL), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tender_id), UNIQUE(tender_id,origin_observation_key),
 FOREIGN KEY(origin_observation_id,tender_id) REFERENCES tender_app.intake_organization_observation(id,tender_id)
 ,FOREIGN KEY(tender_id,confirmed_supplier_id) REFERENCES tender_app.tender_supplier(tender_id,supplier_id)
);
CREATE TABLE tender_app.intake_company_revision (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), company_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), requisites jsonb NOT NULL CHECK(jsonb_typeof(requisites)='object'),
 source_observations uuid[] NOT NULL CHECK(cardinality(source_observations)>0), evidence_ids uuid[] NOT NULL CHECK(cardinality(evidence_ids)>0),
 review_state text NOT NULL CHECK(review_state IN ('proposed','needs_review','confirmed','rejected','superseded')),
 reason text NOT NULL, source text NOT NULL CHECK(source IN ('system','human')),
 actor_id uuid NOT NULL REFERENCES tender_app.app_user(id), supersedes_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,revision), UNIQUE(id,company_id,tender_id),
 FOREIGN KEY(company_id,tender_id) REFERENCES tender_app.intake_company(id,tender_id),
 FOREIGN KEY(supersedes_id,company_id,tender_id) REFERENCES tender_app.intake_company_revision(id,company_id,tender_id),
 CHECK(source<>'system' OR review_state IN ('proposed','needs_review'))
);
ALTER TABLE tender_app.intake_company ADD CONSTRAINT intake_company_head_fk
 FOREIGN KEY(current_revision_id,id,tender_id) REFERENCES tender_app.intake_company_revision(id,company_id,tender_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE tender_app.intake_identity_claim (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), company_id uuid NOT NULL,
 observation_id uuid NOT NULL, country_key char(2) NOT NULL CHECK(country_key IN ('RU','GB')),
 scheme text NOT NULL CHECK(scheme IN ('RU_INN','GB_CRN')), normalized_value text NOT NULL CHECK(length(normalized_value)>0),
 normalization_version text NOT NULL, evidence_id uuid NOT NULL, result_id uuid NOT NULL, receipt_id uuid NOT NULL,
 classification_result_id uuid NOT NULL, state_revision integer NOT NULL DEFAULT 1 CHECK(state_revision=1),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tender_id,country_key,scheme,normalized_value), UNIQUE(id,tender_id),
 FOREIGN KEY(company_id,tender_id) REFERENCES tender_app.intake_company(id,tender_id),
 FOREIGN KEY(observation_id,result_id,receipt_id,tender_id) REFERENCES tender_app.intake_organization_observation(id,result_id,receipt_id,tender_id),
 FOREIGN KEY(evidence_id,classification_result_id,receipt_id,tender_id) REFERENCES tender_app.intake_evidence(id,result_id,receipt_id,tender_id)
);
CREATE TABLE tender_app.intake_match_proposal (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), company_id uuid NOT NULL,
 target_company_id uuid, target_supplier_id uuid, observation_id uuid NOT NULL,
 match_type text NOT NULL CHECK(match_type IN ('strong_identifier','weak_name','weak_email','weak_contact','weak_domain','weak_address','identifier_conflict','changed_identity')),
 basis jsonb NOT NULL, evidence_ids uuid[] NOT NULL CHECK(cardinality(evidence_ids)>0),
 state text NOT NULL CHECK(state='proposed'), rules_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tender_id),
 FOREIGN KEY(company_id,tender_id) REFERENCES tender_app.intake_company(id,tender_id),
 FOREIGN KEY(target_company_id,tender_id) REFERENCES tender_app.intake_company(id,tender_id),
 FOREIGN KEY(tender_id,target_supplier_id) REFERENCES tender_app.tender_supplier(tender_id,supplier_id),
 FOREIGN KEY(observation_id,tender_id) REFERENCES tender_app.intake_organization_observation(id,tender_id),
 CHECK((target_company_id IS NULL)<>(target_supplier_id IS NULL)),
 CHECK(target_company_id IS NULL OR target_company_id<>company_id)
);
CREATE UNIQUE INDEX intake_match_dedup ON tender_app.intake_match_proposal(company_id,COALESCE(target_company_id,target_supplier_id),observation_id,match_type);
CREATE TABLE tender_app.intake_association_revision (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id),
 receipt_id uuid NOT NULL, company_id uuid, target_receipt_id uuid, association_key text NOT NULL, observation_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 association_type text NOT NULL CHECK(association_type IN ('supplier_of','supports','quality_for','relates_to_specification','contained_in','supersedes')),
 state text NOT NULL CHECK(state='proposed'), evidence_ids uuid[] NOT NULL CHECK(cardinality(evidence_ids)>0),
 reason text NOT NULL, rules_version text NOT NULL, supersedes_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(receipt_id,association_key,revision), UNIQUE(id,receipt_id,association_key,tender_id),
 FOREIGN KEY(receipt_id,tender_id) REFERENCES tender_app.intake_receipt(id,tender_id),
 FOREIGN KEY(company_id,tender_id) REFERENCES tender_app.intake_company(id,tender_id),
 FOREIGN KEY(target_receipt_id,tender_id) REFERENCES tender_app.intake_receipt(id,tender_id),
 FOREIGN KEY(observation_id,tender_id) REFERENCES tender_app.intake_organization_observation(id,tender_id),
 FOREIGN KEY(supersedes_id,receipt_id,association_key,tender_id)
 REFERENCES tender_app.intake_association_revision(id,receipt_id,association_key,tender_id),
 CHECK((association_type IN ('supplier_of','supports','quality_for') AND company_id IS NOT NULL AND target_receipt_id IS NULL)
    OR (association_type IN ('relates_to_specification','contained_in','supersedes') AND company_id IS NULL AND target_receipt_id IS NOT NULL)),
 CHECK(target_receipt_id IS NULL OR target_receipt_id<>receipt_id),
 CHECK(association_key=association_type||':'||COALESCE(company_id,target_receipt_id)::text)
);
CREATE TABLE tender_app.intake_association_head (
 tender_id uuid NOT NULL REFERENCES tender_app.tender(id), receipt_id uuid NOT NULL,
 company_id uuid, target_receipt_id uuid, association_key text NOT NULL, association_type text NOT NULL, current_revision_id uuid NOT NULL,
 approved_revision_id uuid CHECK(approved_revision_id IS NULL),
 state_revision integer NOT NULL CHECK(state_revision>0),
 PRIMARY KEY(receipt_id,association_key),
 CHECK((company_id IS NULL)<>(target_receipt_id IS NULL)),
 CHECK(association_key=association_type||':'||COALESCE(company_id,target_receipt_id)::text),
 FOREIGN KEY(current_revision_id,receipt_id,association_key,tender_id)
 REFERENCES tender_app.intake_association_revision(id,receipt_id,association_key,tender_id),
 FOREIGN KEY(approved_revision_id,receipt_id,association_key,tender_id)
 REFERENCES tender_app.intake_association_revision(id,receipt_id,association_key,tender_id)
);
CREATE TABLE tender_app.intake_review_decision (
 id uuid PRIMARY KEY, tender_id uuid NOT NULL REFERENCES tender_app.tender(id), operation_key uuid NOT NULL,
 request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 subject_type text NOT NULL CHECK(subject_type IN ('receipt','company')),
 receipt_id uuid, company_id uuid, expected_revision integer NOT NULL CHECK(expected_revision>0),
 action text NOT NULL CHECK(action='resolve'), before_state jsonb NOT NULL, after_state jsonb NOT NULL,
 reason text NOT NULL, actor_id uuid NOT NULL REFERENCES tender_app.app_user(id), source text NOT NULL CHECK(source='system'),
 result_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tender_id,operation_key),
 FOREIGN KEY(receipt_id,tender_id) REFERENCES tender_app.intake_receipt(id,tender_id),
 FOREIGN KEY(company_id,tender_id) REFERENCES tender_app.intake_company(id,tender_id),
 FOREIGN KEY(result_id,tender_id) REFERENCES tender_app.intake_organization_result(id,tender_id),
 FOREIGN KEY(result_id,tender_id,receipt_id) REFERENCES tender_app.intake_organization_result(id,tender_id,receipt_id),
 CHECK((subject_type='receipt' AND receipt_id IS NOT NULL AND company_id IS NULL) OR
       (subject_type='company' AND company_id IS NOT NULL AND receipt_id IS NULL))
);
CREATE INDEX intake_company_tender ON tender_app.intake_company(tender_id,id);
CREATE INDEX intake_org_receipt ON tender_app.intake_organization_observation(tender_id,receipt_id);
CREATE FUNCTION tender_app.guard_organization_observation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE item record; field text; val jsonb; n integer; ev tender_app.intake_evidence;
BEGIN
 FOR item IN SELECT key,value FROM jsonb_each_text(NEW.evidence_by_field) LOOP
  SELECT * INTO ev FROM tender_app.intake_evidence e WHERE e.id=item.value::uuid AND e.tender_id=NEW.tender_id
   AND e.result_id=NEW.classification_result_id AND e.receipt_id=NEW.receipt_id
   AND e.field_path='organizations.'||NEW.local_key||'.'||item.key;
  IF NOT FOUND THEN RAISE EXCEPTION 'unrelated organization evidence' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOREACH field IN ARRAY ARRAY['role','name','legal_name','country','address'] LOOP
  IF to_jsonb(NEW)->>field IS NOT NULL AND NOT(NEW.evidence_by_field ? field) THEN
   RAISE EXCEPTION 'missing field evidence' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOREACH field IN ARRAY ARRAY['identifiers','emails','contacts'] LOOP
  n:=0;
  FOR val IN SELECT * FROM jsonb_array_elements(to_jsonb(NEW)->field) LOOP
   IF NOT(NEW.evidence_by_field ? (field||'.'||n||CASE WHEN field='identifiers' THEN '.raw_value' ELSE '' END)) THEN
    RAISE EXCEPTION 'missing array evidence' USING ERRCODE='23514'; END IF;
   n:=n+1;
  END LOOP;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER observation_evidence_guard BEFORE INSERT ON tender_app.intake_organization_observation
 FOR EACH ROW EXECUTE FUNCTION tender_app.guard_organization_observation();
CREATE FUNCTION tender_app.guard_organization_references() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE obs tender_app.intake_organization_observation; eid uuid; oid uuid;
BEGIN
 IF TG_TABLE_NAME='intake_company' THEN
  SELECT * INTO obs FROM tender_app.intake_organization_observation WHERE id=NEW.origin_observation_id AND tender_id=NEW.tender_id;
  IF obs.role<>'supplier' OR COALESCE(obs.legal_name,obs.name) IS NULL OR NEW.origin_observation_key<>obs.origin_key THEN
   RAISE EXCEPTION 'company requires named supplier observation' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='intake_company_revision' THEN
  FOREACH oid IN ARRAY NEW.source_observations LOOP
   IF NOT EXISTS(SELECT 1 FROM tender_app.intake_organization_observation WHERE id=oid AND tender_id=NEW.tender_id) THEN
    RAISE EXCEPTION 'unrelated revision observation' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOREACH eid IN ARRAY NEW.evidence_ids LOOP
   IF NOT EXISTS(SELECT 1 FROM tender_app.intake_organization_observation o,jsonb_each_text(o.evidence_by_field) e
    WHERE o.id=ANY(NEW.source_observations) AND o.tender_id=NEW.tender_id AND e.value=eid::text) THEN
    RAISE EXCEPTION 'unrelated revision evidence' USING ERRCODE='23514'; END IF;
  END LOOP;
 ELSE
  SELECT * INTO obs FROM tender_app.intake_organization_observation WHERE id=NEW.observation_id AND tender_id=NEW.tender_id;
  IF TG_TABLE_NAME='intake_identity_claim' THEN
   IF obs.role<>'supplier' OR obs.review_state<>'proposed' OR NEW.classification_result_id<>obs.classification_result_id OR
    (CASE upper(obs.country) WHEN 'РОССИЯ' THEN 'RU' WHEN 'РОССИЙСКАЯ ФЕДЕРАЦИЯ' THEN 'RU'
      WHEN 'UNITED KINGDOM' THEN 'GB' WHEN 'UK' THEN 'GB' WHEN 'ВЕЛИКОБРИТАНИЯ' THEN 'GB' ELSE upper(obs.country) END) IS DISTINCT FROM NEW.country_key OR
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements(obs.identifiers) WITH ORDINALITY AS ids(i,n)
      WHERE i->>'scheme'=NEW.scheme AND i->>'normalized_value'=NEW.normalized_value AND i->>'valid'='true'
       AND i->>'validator_version'=NEW.normalization_version
       AND obs.evidence_by_field->>('identifiers.'||(n-1)||'.raw_value')=NEW.evidence_id::text) THEN
    RAISE EXCEPTION 'claim requires supported evidence-backed identity' USING ERRCODE='23514'; END IF;
  ELSE
   FOREACH eid IN ARRAY NEW.evidence_ids LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_each_text(obs.evidence_by_field) e WHERE e.value=eid::text) THEN
     RAISE EXCEPTION 'unrelated proposal evidence' USING ERRCODE='23514'; END IF;
   END LOOP;
   IF TG_TABLE_NAME='intake_association_revision' THEN
    IF obs.receipt_id<>NEW.receipt_id THEN
     RAISE EXCEPTION 'unrelated association receipt' USING ERRCODE='23514'; END IF;
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION tender_app.guard_organization_head() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['current_revision_id','state_revision']::text[]) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['current_revision_id','state_revision']::text[]) OR NEW.state_revision<>OLD.state_revision+1 THEN
  RAISE EXCEPTION 'stale or reassigned organization head' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='intake_company' THEN
  IF NOT EXISTS(SELECT 1 FROM tender_app.intake_company_revision WHERE id=NEW.current_revision_id AND revision=NEW.state_revision) THEN
   RAISE EXCEPTION 'company head revision mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM tender_app.intake_association_revision WHERE id=NEW.current_revision_id AND revision=NEW.state_revision) THEN
   RAISE EXCEPTION 'association head revision mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION tender_app.check_organization_head_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='intake_company' THEN
  IF NOT EXISTS(SELECT 1 FROM tender_app.intake_company c JOIN tender_app.intake_company_revision r ON r.id=c.current_revision_id
   WHERE c.id=NEW.id AND r.revision=c.state_revision) THEN
   RAISE EXCEPTION 'initial company revision mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM tender_app.intake_association_head h JOIN tender_app.intake_association_revision r ON r.id=h.current_revision_id
   WHERE h.receipt_id=NEW.receipt_id AND h.association_key=NEW.association_key AND r.revision=h.state_revision) THEN
   RAISE EXCEPTION 'initial association revision mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER org_initial_revision_guard AFTER INSERT ON tender_app.intake_company DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION tender_app.check_organization_head_revision();
CREATE CONSTRAINT TRIGGER org_initial_revision_guard AFTER INSERT ON tender_app.intake_association_head DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION tender_app.check_organization_head_revision();
DO $$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['intake_organization_result','intake_organization_observation','intake_company',
 'intake_company_revision','intake_identity_claim','intake_match_proposal','intake_association_revision',
 'intake_association_head','intake_review_decision'] LOOP
  EXECUTE format('CREATE TRIGGER lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON tender_app.%I FOR EACH ROW EXECUTE FUNCTION tender_app.guard_lifecycle_child(''tender_id'')',tbl);
  EXECUTE format('CREATE TRIGGER org_no_truncate BEFORE TRUNCATE ON tender_app.%I FOR EACH STATEMENT EXECUTE FUNCTION tender_app.reject_mutation()',tbl);
  IF tbl IN ('intake_company','intake_association_head') THEN
   EXECUTE format('CREATE TRIGGER org_head_guard BEFORE UPDATE ON tender_app.%I FOR EACH ROW EXECUTE FUNCTION tender_app.guard_organization_head()',tbl);
   EXECUTE format('CREATE TRIGGER org_no_delete BEFORE DELETE ON tender_app.%I FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation()',tbl);
  ELSE
   EXECUTE format('CREATE TRIGGER org_immutable BEFORE UPDATE OR DELETE ON tender_app.%I FOR EACH ROW EXECUTE FUNCTION tender_app.reject_mutation()',tbl);
  END IF;
  IF tbl IN ('intake_company','intake_company_revision','intake_identity_claim','intake_match_proposal','intake_association_revision') THEN
   EXECUTE format('CREATE TRIGGER org_reference_guard BEFORE INSERT ON tender_app.%I FOR EACH ROW EXECUTE FUNCTION tender_app.guard_organization_references()',tbl);
  END IF;
 END LOOP;
END $$;
