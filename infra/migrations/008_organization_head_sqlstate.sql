BEGIN;
-- Preserve invalid organization-head operation SQLSTATE; all scope/revision checks retained.
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
 IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'organization head revision mismatch' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
COMMIT;
