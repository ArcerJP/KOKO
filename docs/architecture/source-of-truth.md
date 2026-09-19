# Source of Truth

## Principle

KOKO does not treat every record as equally authoritative. The correct source depends on the question being answered.

| Question | Authoritative source | Non-authoritative supporting material |
| --- | --- | --- |
| What does the system currently do? | Actual source code and observed runtime behavior | Plans, handoffs, old docs |
| Why was an architecture choice made? | Accepted ADR in docs/decisions/ | MEMORY.md summary, task discussion |
| What is the current formal architecture or specification? | Current docs/ | Wiki synthesis, implementation plan |
| What did an original source say? | knowledge/raw/ or the cited authoritative external source | knowledge/wiki/ summary |
| What reusable conclusions have been derived? | Canonical page in knowledge/wiki/, subject to its evidence | Task research |
| What project continuity should persist? | MEMORY.md | Temporary memory entries |
| What evidence and intent belong to an active task? | work/notebook/<task-id>/ | Chat recollection |
| What was handed to a human for review? | work/outbox/<task-id>/ | Active notebook copy, which must not coexist |
| What is the historical task record? | work/archive/YYYY/<task-id>/ | Prior state locations |
| How should Codex behave? | Applicable AGENTS.md and selected Skill | README or ordinary docs |

## Conflict Rules

1. Do not silently reconcile conflicting sources.
2. Identify the question and its authoritative category.
3. Check dates, versions, provenance, implementation state, and whether a decision is proposed, accepted, superseded, or deprecated.
4. Prefer current observed behavior for what exists, while recording when it violates an accepted specification.
5. Prefer raw evidence over derived wiki claims about the evidence.
6. Correct the stale non-authoritative copy or replace it with a link; do not preserve competing full copies.
7. Escalate material ambiguity that changes scope, safety, compatibility, or architecture.

## Duplication Boundaries

- MEMORY.md may link to an ADR but must not reproduce it.
- README.md may summarize architecture but must link to formal docs.
- Plans describe intended changes and do not become current specifications after implementation.
- Research is task-specific; only reusable synthesis is promoted to the wiki.
- Wiki pages cite evidence and do not replace raw sources or normative docs.
