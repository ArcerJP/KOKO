---
name: research-plan-implement
description: Use for non-trivial implementation work, multi-file changes, architecture changes, migrations, risky changes, or tasks that require understanding the current repository before editing. Guides research, planning, implementation, verification, and handoff.
---

# Research, Plan, Implement

Scale the workflow to risk. Do not create ceremony that does not improve a small task, and do not skip evidence or approval where failure would be consequential.

## Phase A — Scope

Restate the objective, acceptance criteria, in-scope and out-of-scope work, authorization boundaries, and material unknowns. Classify risk:

- Level 0: read-only explanation or light investigation; a task folder is optional.
- Level 1: clear, local, low-risk change; formal research and plan may be omitted.
- Level 2: normal feature, bug fix, multi-file change, or non-trivial refactor; plan by default and research unknowns.
- Level 3: architecture, authentication, security, migration, destructive or breaking change, infrastructure, permissions, secrets, or production data; research, plan, human approval, and verification are required.

Do not inflate the risk level without a concrete reason.

## Phase B — Research

Read the request, applicable AGENTS.md files, relevant source, current docs, and relevant knowledge. Observe current behavior when useful. Record evidence paths, facts, inferences, constraints, contradictions, and unknowns without prematurely choosing the solution.

For substantial task-specific research, use work/notebook/<task-id>/research/YYYY-MM-DD-topic.md based on work/_templates/research.md. Promote findings to knowledge/wiki/ only if they are reusable beyond the task.

### Optional Parallel Investigation

Use subagents only when the capability is available and the task is complex enough to benefit from independent, parallel research or verification. Give each agent a bounded, non-overlapping assignment; do not let multiple agents compete to edit the same file. The main agent remains responsible for synthesis and must verify subagent findings before treating them as facts. Parallelization is optional, not a completion requirement.

## Phase C — Plan

Define the desired state, scope, files to create/modify/delete, ordered phases, verification, tests, documentation, security, compatibility, rollback, risks, and open questions. Use work/_templates/plan.md when a durable task plan adds value.

A plan is intended future work, not the current authoritative specification.

## Phase D — Approval Gate

Obtain human approval before Level 3 implementation or whenever the plan requires a material user choice, destructive action, new authority, or meaningful scope expansion. Never mark a Level 3 plan approved on the user's behalf. A user-provided approved specification may satisfy this gate for the scope it explicitly authorizes.

## Phase E — Implementation

Implement only the approved scope in coherent phases. Preserve existing conventions and user changes. Avoid unrelated refactors. If evidence invalidates the plan or requires a large deviation, stop, update the plan, and re-evaluate approval.

Keep implementation in the actual source tree; never store a duplicate source snapshot in work/.

## Phase F — Verification

Run checks proportionate to the change: relevant tests, lint, formatting, type checks, build, runtime behavior, security checks, documentation consistency, diff review, and Git status. Do not invent commands for tooling that does not exist. Record exact results and distinguish passed, failed, skipped, and unavailable checks.

## Phase G — Handoff

Use work/_templates/handoff.md when a durable handoff is needed. Report requested and completed work, changed files, verification and test results, security review, limitations, risks, follow-up, related research/plan, and commit or PR state. Do not claim completion beyond the evidence.
