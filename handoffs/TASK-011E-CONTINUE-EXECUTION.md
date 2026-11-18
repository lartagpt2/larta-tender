# TASK-011E — isolated review workflow

Technical matrix passed; owner acceptance is pending. This branch publishes the verified isolated source snapshot for review. It does not deploy or copy code to the working portal. The snapshot includes the agreed B/C/D, TASK014 and Lifecycle foundations required by E; unrelated uncommitted portal files are not staged.

Company confirmation, document type, receipt association and commercial verification are independent human decisions. Mixed intake retains immutable originals, separate receipts, durable processing, evidence and history. The workspace supports detached receipt cards, company revision/source review, observation rejection, canonical legacy projection and explicit commercial draft/verification with scoped lineage. Stale managed contexts are excluded from comparison with visible warnings; legacy unmanaged review and stage no_reply behavior are preserved.

## Verification

- B:7/7groups; C:7/7groups,449assertions; D:12/12groups; all exit0 after shared changes.
- E1–E7 / E-T01–E-T24:15SQL/API/Worker groups and11 actual Playwright scenarios, exit0.
- API Jest25suites/219tests, web Vitest8suites/49tests,13isolation/policy/coverage tests pass. TypeScript, all builds, global ESLint and Prettier pass.
- Owner-approved B status adjustments and one EML unit coverage expectation are recorded in the assertion proof. reflect-metadata is loaded by test bootstrap; health assertions are unchanged.
- Migrations001–009 are byte-identical to the final approved set; the disposable runner pins their SHA and exact64tables. New tests use only fresh UUID databases; all31runs and artifacts are retained.
- Accepted D policy and E runtime allowlist remain SHA74dffd227d0232b9e60afdcdb09e0f01461d02a9d72f043df480377a174b5a3e. No real LLM/Ollama, approved_corpus expansion, secret/storage/real-document copy, main-DB writes or deployment.

[Final source manifest](../docs/task011e-validation/SOURCE-MANIFEST.json), [results](../docs/task011e-validation/RESULTS.json), [E matrix](../docs/task011e-validation/E-MATRIX.json), [quality](../docs/task011e-validation/QUALITY.json), [assertions](../docs/task011e-validation/ASSERTIONS.json), [migration hashes](../docs/task011e-validation/MIGRATIONS.json), [DB provenance](../docs/task011e-validation/DB-PROVENANCE.json). The manifests record the actual isolated run paths and UUID identities; these paths are provenance, not production configuration.

B/C/D regression manifests are test-only; normal API/Worker do not activate them. The normal E runtime policy remains frozen. The physical10file UAT kit is described by [its manifest](../docs/task011e-validation/UAT-FIXTURES.json) and generated from the approved D fixture generator; real documents must not be substituted. Native price conflict extraction is unit-tested. The frozen D corpus has no labeled commercial prices, so SQL/API/UAT price confirmation uses explicit synthetic human transcription and does not claim model quality.

Full raw logs, physical fixture files, patches and the detailed UAT instructions remain in the retained isolated continuation directory. No node_modules, dist, storage, credentials or runtime logs are committed. The isolated local UAT interface has owner/reviewer/outsider roles and is ready for owner review. TASK-011E is not automatically accepted.
