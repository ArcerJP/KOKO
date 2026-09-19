# KOKO

## Purpose

KOKO is an AI-native workspace for long-term collaboration between people and OpenAI Codex.

The product, programming language, framework, database, cloud provider, and repository shape are not selected yet.

This file is the repository routing layer. Keep detailed procedures in Skills and formal architecture in docs/.

## Core Principles

- Progressive Disclosure: read only the context needed for the current task.
- Single Source of Truth: do not copy complete rules, specifications, or decisions across files.
- Evidence Before Synthesis: keep original evidence separate from derived knowledge.
- Research Before Non-trivial Planning: resolve material unknowns before committing to a design.
- Plan Before Non-trivial Implementation: plan multi-file, architectural, or risky work first.
- Minimal Change: do not mix unrelated changes into the requested work.
- Verify Before Completion: distinguish editing from demonstrated completion.
- Security First: keep secrets, credentials, personal data, and sensitive sources out of Git.
- No Speculative Structure: add structure only for a present, justified responsibility.

## Repository Routing

- docs/ — current, authoritative project and architecture documentation.
- docs/decisions/ — architecture decision records for consequential decisions.
- knowledge/raw/ — original evidence and source material; private-first and normally immutable.
- knowledge/wiki/ — reusable knowledge derived from cited evidence.
- knowledge/SCHEMA.md — formal knowledge-layer rules; read before knowledge ingestion.
- work/ — task lifecycle and temporary task-scoped artifacts.
- work/WORKFLOW.md — state definitions and transitions; read when moving task state.
- .agents/skills/ — repeatable task-specific procedures loaded on demand.
- MEMORY.md — concise, durable, public-safe project continuity.
- memory/ — temporary or daily local context; private by default.
- SOUL.md — collaboration values; read only when role or judgment guidance is relevant.
- IDENTITY.md — the repository-local AI role; read only when role boundaries matter.
- USER.md — durable collaboration preferences; read only when they affect the task.
- TOOLS.md — tool guidance; read before environment- or tool-specific work.

## Mandatory Skill Routing

Use the named repository Skill when its trigger applies:

- New, started, handed-off, closed, moved, or archived task state → $task-lifecycle.
- Multi-file change, architecture work, migration, risky change, or non-trivial implementation → $research-plan-implement.
- Adding raw evidence or deriving reusable wiki knowledge → $knowledge-ingest.
- Inspecting or staging Git changes, committing, branching, remotes, pushing, or PR preparation → $git-workflow.
- Changing top-level structure, Skills, AGENTS.md files, or architecture domains → $evolve-workspace.

Do not split planning, implementation, handoff review, or memory maintenance into new Skills unless evolve-workspace establishes a repeated need.

## Directory-specific Guidance

Root instructions apply repository-wide.

Before changing docs/, knowledge/, or work/ from the repository root, read the AGENTS.md in that subtree. Codex discovers nested instructions automatically only along the active working-directory path, so root-level work must route to them explicitly.

A nested AGENTS.md contains only rules specific to its subtree. Do not copy this file into nested guidance.

## Context Routing

Do not preload every repository document.

- Read formal architecture only when the task depends on it.
- Read raw evidence only when the task requires the source.
- Read wiki knowledge only when reusable findings are relevant.
- Read task artifacts only for the active task.
- Read MEMORY.md for continuity, not as a substitute for current source or docs.
- Treat SOUL.md, IDENTITY.md, USER.md, TOOLS.md, MEMORY.md, memory/, knowledge/, work/, and docs/ as KOKO conventions, not Codex auto-loaded special files.

## Information Boundaries

- Repository-wide behavior belongs here.
- Directory-specific behavior belongs in the nearest nested AGENTS.md.
- Repeatable procedures belong in .agents/skills/.
- Original evidence belongs in knowledge/raw/.
- Derived reusable knowledge belongs in knowledge/wiki/.
- Current normative specifications belong in docs/.
- Task-specific research and plans belong in work/notebook/.
- Actual implementation belongs in the future source tree, not in work/.
- If information does not fit, reclassify it; do not create misc/, other/, or stuff/.

## Safety

- Do not modify anything outside the KOKO repository without explicit permission.
- Inspect existing state before broad changes; never delete unexpected data to recreate an assumed state.
- Do not infer or introduce a technology stack, framework, source tree, CI, deployment, database, cloud provider, or license.
- Do not fabricate important facts, approvals, verification results, or completion.
- Do not add secrets, tokens, passwords, private keys, credentials, session data, or sensitive personal information.
- Do not commit confidential raw sources or task artifacts without explicit policy and authorization.
- Do not run destructive Git operations, rewrite history, overwrite a remote, or discard user changes without explicit permission.
- Surface contradictions, material uncertainty, security concerns, and approval requirements before proceeding past the relevant gate.

## Change Discipline

- Confirm scope, authority, and the current source of truth before mutation.
- Resolve user-owned choices before committing to a materially different design.
- Classify new information by responsibility, lifecycle, and Git policy before storing it.
- Update the authoritative layer and link to it instead of preserving competing full copies.

## Completion

Before claiming completion, verify the changed behavior or artifact, review the diff, check documentation consistency, inspect security impact, and report limitations or pending human decisions.
