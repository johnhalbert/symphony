# Contract: Context Credential Profile Assignment

## Purpose

Ensure every service capability resolves credentials from the target project context before use.

## Assignment Rule

For each service capability:

1. Resolve the target project context.
2. Resolve the capability's credential profile assignment within that context.
3. Apply structured inheritance and validation.
4. Provide secret values only to the authorized service path.
5. Expose only non-secret assignment evidence outside the service path.

## Failure Behavior

If the credential assignment is missing, ambiguous, or invalid:

- do not contact the upstream service
- do not fall back to a different project context silently
- record a redacted operator-facing reason
- continue processing unrelated contexts when safe

## Child Issue Contract Seed

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-11.1",
  "requirements": [
    {
      "id": "REQ-CRED-001",
      "requirement": "Credential profile resolution must use the target project context and capability before any service access.",
      "proofHint": "Show distinct contexts resolve distinct credentials without exposing secret values."
    }
  ]
}
```
