# Contract: Public Metadata Redaction

## Purpose

Define what project-context metadata may be exposed outside private configuration and runtime credential paths.

## Allowed Public Fields

Public metadata MAY include:

- project context id
- project context label
- tracker project slug or non-secret label
- repository owner/name or local path summary after redaction
- source kind
- capability names
- credential profile names only when names are non-secret
- safe redaction markers

## Forbidden Public Fields

Public metadata MUST NOT include:

- API tokens
- private keys
- raw environment variable values
- raw credential profile contents
- repository credentials or user-info
- provider account contents
- secret-bearing query or fragment values

## Required Behavior

1. Direct helper calls and normalized configuration calls MUST produce equivalent public metadata for the same context.
2. Repository-like values MUST be treated as untrusted input before display.
3. Ambiguous credential-like input MUST redact or omit sensitive portions.
4. Missing optional values MUST be distinguishable from redacted values when that distinction is safe.
5. Validation evidence MUST use synthetic secrets only.

## Child Issue Contract Seeds

Any generated child issue should use fenced JSON requirements equivalent to:

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-11.1",
  "requirements": [
    {
      "id": "REQ-RED-001",
      "requirement": "Public project-context metadata must omit credential-bearing values across direct helper and normalized configuration paths.",
      "proofHint": "Show synthetic redaction fixtures pass for both paths."
    }
  ]
}
```
