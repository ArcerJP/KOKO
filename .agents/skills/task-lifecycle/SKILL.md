---
name: task-lifecycle
description: Use when creating, starting, handing off, closing, moving, or archiving a task through KOKO's work/inbox to work/notebook to work/outbox to work/archive lifecycle.
---

# Task Lifecycle

Maintain one task folder whose location represents its current state. Read work/AGENTS.md and work/WORKFLOW.md before changing task state.

## Identify the Task

Use TASK-YYYYMMDD-short-kebab-description. Confirm that no folder with the same task ID already exists in another state.

Create only artifacts needed by the task. Use files from work/_templates/ rather than inventing competing formats.

## State Transitions

1. Intake: create work/inbox/<task-id>/request.md and record the request, constraints, acceptance criteria, references, and unknowns.
2. Start: move the same folder to work/notebook/<task-id>/. Update request status and add research/, plans/, or prs/ only when the work needs them.
3. Handoff: after implementation and verification, add a handoff artifact and move the folder to work/outbox/<task-id>/.
4. Archive: only after human acceptance or an explicit close decision, move it to work/archive/YYYY/<task-id>/.

Move; do not copy a task between states. Never keep the same task active in more than one state.

## Boundaries

- Do not copy active source code into work/.
- Do not treat research, plans, or handoffs as current authoritative docs.
- Do not create every optional subdirectory preemptively.
- Do not overwrite an existing task folder; stop and resolve the collision.
- Dynamic work content is local/private by default. Do not force-add it to Git or expose sensitive content in a PR.
- If a task yields durable knowledge or an architecture decision, synthesize only the durable result into the appropriate wiki, docs, or ADR location.

## Verify

Confirm the task exists in exactly one lifecycle state, its metadata matches that state, required handoff evidence exists, and no confidential content was staged.
