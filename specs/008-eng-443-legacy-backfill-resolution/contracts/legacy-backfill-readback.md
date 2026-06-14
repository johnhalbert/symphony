# Contract: Legacy Backfill Readback

## Purpose

Preserve historical readback compatibility for runs, workspaces, transcripts, and operator-facing projections created before explicit project-context metadata existed.

## Public Metadata Contract

Historical records that lack explicit project-context metadata must synthesize only non-secret public attribution fields:

```json
{
  "projectContext": {
    "projectContextId": "default",
    "projectContextLabel": "Default",
    "linearProjectSlug": null,
    "routingSource": "legacy_default"
  }
}
```

No credential-bearing repository URLs, tokens, private keys, or secret profile material may appear in public readback output.

## Readback Invariants

1. Ordinary reads must synthesize legacy/default attribution when historical records omit `projectContext`.
2. Ordinary reads must not destructively rewrite historical files or durable rows just to backfill public attribution.
3. Public transcript and projection output must remain redacted even when historical source rows contain secret-bearing payloads.
4. Evidence for the ENG-443 child follow-ups must distinguish:
   - base proof
   - missing-path repair disposition
   - no-op disposition
   - validation results

## Proof Surfaces

- `tests/transcript-store.test.ts`
  - validates synthesized legacy/default attribution and non-mutating readback for run/workspace records
  - validates unexpected secret-bearing `projectContext` fields are stripped from public reads
- `tests/transcript-replay.test.ts`
  - validates replayed historical runs still synthesize legacy/default attribution when persisted run metadata omits `projectContext`
- `tests/web-history-transcript-durable-projection.test.ts`
  - validates durable transcript rebuild reads stay scoped to the synthesized legacy/default `projectContextId`
  - validates durable transcript projection output remains redacted
- `tests/status-api.test.ts`
  - validates durable status routes expose normalized legacy/default attribution across issue, run, and workspace reads
- `tests/issue-contract-lint.test.ts`
  - validates ENG-443 child-contract examples pass the shared fenced JSON issue-contract lint path

## Evidence Notes

- Checked-in planning lives under `specs/003-multi-project-config/`.
- Final ENG-443 legacy/default readback evidence summaries live in `specs/008-eng-443-legacy-backfill-resolution/quickstart.md`.
