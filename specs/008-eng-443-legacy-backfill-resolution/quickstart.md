# ENG-443 Legacy Backfill Readback Evidence

## Scope Note

The checked-in multi-project planning artifacts for this feature live under `specs/003-multi-project-config/`. This `specs/008-eng-443-legacy-backfill-resolution/` directory exists to hold the final ENG-443 legacy/default readback evidence referenced by ENG-838, ENG-842, and ENG-846 issue descriptions.

## Base Proof

- Base behavior proof came from the current `origin/main` snapshot validated for `ENG-838`.
- The pinned-base proof showed the legacy/default readback path already existed in:
  - `src/core/persistence/RunTranscriptStore.ts`
  - `src/core/config/ProjectContexts.ts`
  - `src/app/http.ts`
- The proof refresh is summarized in `specs/003-multi-project-config/quickstart.md` under `Legacy backfill disposition note (ENG-443 / T088)`.

## Missing-Path Repair

- `ENG-842` investigated whether a still-missing legacy backfill repair path remained after the base proof landed.
- The checked-in workspace does not carry a separate surviving source or test delta for that repair path; the sibling disposition is therefore that no additional missing-path code change remained to merge after the base proof.
- This child finalization work records that outcome as evidence rather than re-introducing a redundant repair.

## No-Op Disposition

- The active legacy-backfill PR classification from the proof refresh was a no-op / behaviorally redundant branch against the already-passing pinned `origin/main` snapshot.
- The durable disposition evidence remains the GitHub/merge-base proof recorded in `specs/003-multi-project-config/quickstart.md`:
  - no source/test diff across the legacy readback proof surface
  - identical branch-tip and merge-base trees for the classified no-op PR

## Validation Results

Run the issue-required focused validation:

```powershell
npm test -- tests/transcript-store.test.ts tests/transcript-replay.test.ts tests/workspace.test.ts
npm test -- tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-projection-context.test.ts
npm test -- tests/issue-contract-lint.test.ts
```

Additional focused proof used for durable transcript rebuild attribution:

```powershell
npm test -- tests/web-history-transcript-durable-projection.test.ts -t "passes the legacy/default project context id into durable transcript rebuild reads for persisted runs missing projectContext metadata"
```

## Evidence Map

- Base proof: `tests/transcript-store.test.ts`, `tests/status-api.test.ts`, `tests/web-history-transcript-durable-projection.test.ts`
- Missing-path repair disposition: this file plus `specs/003-multi-project-config/quickstart.md`
- No-op disposition: `specs/003-multi-project-config/quickstart.md`
- Validation results: the commands above and the corresponding test output from the ENG-846 worker run
