# Contract: ENG-2479 Parent Handoff

This contract defines the parent-facing note to prepare after the child evidence exists. It does not move ENG-2479 out of Blocked.

## Required Content

- Summary of why ENG-2479 was decomposed.
- Links or identifiers for the proof matrix, execution path, focused evidence, and review handoff children after issue-sync.
- The failed review gate or blocked triage finding that the new evidence is intended to supersede.
- The smallest next action for a reviewer or operator.
- Any intentionally unverified live Linear, GitHub, publication, or merge effects.
- Confirmation that no lifecycle state was changed outside the service-owned path.

## Template

```markdown
## ENG-2479 Review-Unblock Handoff

Status: decomposition evidence ready for focused re-review

Prepared evidence:
- Proof matrix: <child issue or artifact link>
- Approved preflight execution path: <child issue or artifact link>
- Focused preflight evidence: <child issue or artifact link>
- Review handoff owner: <child issue or artifact link>

Supersedes:
- <failed review or blocked triage finding identifier>

Focused evidence summary:
- Command/result: <exact focused command and outcome>
- Runtime child families: REQ-392-RUNTIME-ROUTING, REQ-392-RELOAD-PRESERVATION, REQ-392-APPROVAL-WRITEBACK
- Findings: <none or listed findings>

Intentionally unverified:
- Live Linear effects: <state>
- GitHub publication or merge effects: <state>
- Other external effects: <state>

Next action:
- <focused reviewer or operator action through normal Symphony lifecycle>

No Linear lifecycle state, PR publication state, merge state, or protected branch state was changed by this handoff outside the service-owned path.
```

## Validation Rules

- The note must not claim a passing focused preflight unless the evidence child recorded the focused result.
- The note must not claim live effects that were not exercised.
- The note must avoid secrets, credential values, secret-backed profile contents, customer-private data, and unnecessary local absolute paths.
