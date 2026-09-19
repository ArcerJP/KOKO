# Five-Pattern Architecture

## Purpose

KOKO combines five information and workflow patterns so Codex and people can locate the right context without conflating instructions, evidence, synthesis, plans, implementation, memory, or state.

The existence of every layer does not mean every layer belongs in every prompt. Progressive disclosure remains the controlling principle.

## Pattern 1 — Instruction Layering

| Attribute | Definition |
| --- | --- |
| Purpose | Place stable behavior at the narrowest scope where it applies. |
| Problem solved | Prevents one oversized instruction file and irrelevant context. |
| KOKO mapping | Root AGENTS.md → nested AGENTS.md → .agents/skills/. |
| Read timing | Root at repository/session discovery; nested guidance for its subtree; Skills only when triggered. |
| Write policy | Repository-wide rules at root, subtree-only rules nested, repeatable procedures in Skills. |
| Source of truth | The nearest applicable Codex-native instruction or selected Skill. |
| Lifecycle | Durable, revised when repository responsibilities or repeatable workflows change. |

## Pattern 2 — Raw Evidence / Derived Knowledge

| Attribute | Definition |
| --- | --- |
| Purpose | Preserve provenance while making evidence reusable. |
| Problem solved | Prevents summaries, interpretations, and source material from becoming indistinguishable. |
| KOKO mapping | knowledge/raw/ for evidence; knowledge/wiki/ for synthesis. |
| Read timing | On demand for the question being researched; raw consulted for source claims. |
| Write policy | Raw is imported or appended and normally immutable; wiki is maintained with source references. |
| Source of truth | Raw evidence outranks derived wiki content for claims about the source. |
| Lifecycle | Raw remains durable while permitted; wiki evolves as evidence changes. |

## Pattern 3 — Research → Plan → Implement → Verify → Review

| Attribute | Definition |
| --- | --- |
| Purpose | Make non-trivial work evidence-led, reviewable, and demonstrably complete. |
| Problem solved | Prevents premature design, scope drift, and unsupported completion claims. |
| KOKO mapping | work/notebook/<task-id>/ for task artifacts; actual changes in the real source tree; handoff in work/outbox/. |
| Read timing | For Level 2 work by default and Level 3 work mandatorily; scaled down for Levels 0–1. |
| Write policy | Research records current evidence, plans record intended change, verification records observed results. |
| Source of truth | Actual runtime/source for behavior; docs for current specification; task artifacts for task history only. |
| Lifecycle | Active artifacts move with the task and eventually archive; durable results are synthesized elsewhere. |

## Pattern 4 — Identity / User / Tools / Memory Separation

| Attribute | Definition |
| --- | --- |
| Purpose | Keep values, role, collaboration preferences, tool guidance, and continuity independently maintainable. |
| Problem solved | Prevents preferences, procedures, credentials, and project facts from accumulating in one pseudo-prompt. |
| KOKO mapping | SOUL.md, IDENTITY.md, USER.md, TOOLS.md, MEMORY.md, and memory/. |
| Read timing | On demand when a task depends on the relevant category; these files are not Codex auto-loaded special files. |
| Write policy | Store only category-appropriate, minimal, public-safe durable content; temporary content goes to ignored memory/. |
| Source of truth | Each file owns its named category; formal specifications remain in docs/. |
| Lifecycle | Root context files are durable; memory/ entries are temporary and selectively promoted. |

## Pattern 5 — Inbox → Notebook → Outbox → Archive

| Attribute | Definition |
| --- | --- |
| Purpose | Make task state explicit from location. |
| Problem solved | Prevents duplicate task copies and ambiguous active/completed state. |
| KOKO mapping | work/inbox/ → work/notebook/ → work/outbox/ → work/archive/YYYY/. |
| Read timing | Only for the active or reviewed task. |
| Write policy | Move one task folder between states; create only artifacts the task needs. |
| Source of truth | The task folder's single current location and its state metadata. |
| Lifecycle | Received → active → Codex-complete/handoff → human-confirmed historical. |

## Combined Invariant

No layer substitutes for another: evidence is not a specification, a plan is not current state, a handoff is not acceptance, memory is not detailed architecture, and a KOKO convention is not automatically a Codex runtime mechanism.
