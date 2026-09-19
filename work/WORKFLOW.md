# Work Lifecycle

## Purpose

The location of one task folder expresses its current state:

~~~text
INBOX → ACTIVE / NOTEBOOK → OUTBOX → ARCHIVED
~~~

State changes move the folder; they do not copy it. A task must exist in only one state.

## INBOX

Path: work/inbox/<task-id>/

Meaning: the request has been received but work has not started.

Minimum artifact: request.md with the goal, requirements, constraints, acceptance criteria, references, and known unknowns.

Exit condition: the task is intentionally started, declined, or otherwise dispositioned.

## ACTIVE / NOTEBOOK

Path: work/notebook/<task-id>/

Meaning: the task is actively being researched, planned, implemented, or verified.

Possible artifacts:

- request.md;
- research/YYYY-MM-DD-topic.md;
- plans/YYYY-MM-DD-topic.md;
- prs/ review artifacts;
- a handoff draft.

Create only needed paths. Do not store copies of active source files here.

Exit condition: scoped implementation and verification are complete enough for human handoff, or the task is explicitly cancelled/closed.

## OUTBOX

Path: work/outbox/<task-id>/

Meaning: Codex-side work is complete and presented for human review, acceptance, or next action. This does not imply human acceptance.

Required evidence should state what was requested and completed, changed files, verification and tests, security review, limitations, risks, follow-up, related research/plan, and commit or PR status.

Exit condition: a human accepts, closes, returns, or redirects the task.

## ARCHIVED

Path: work/archive/YYYY/<task-id>/

Meaning: the task is confirmed closed and retained as historical task context.

Archive only after explicit human acceptance or close disposition. Archived task artifacts remain historical and do not become current specifications.

## Task IDs

Use TASK-YYYYMMDD-short-kebab-description, for example TASK-20260919-bootstrap-koko. The date is the intake date. The description must identify the task; do not use an unexplained number alone.

## Privacy and Git

Dynamic contents under inbox/, notebook/, outbox/, and archive/ are local/private by default and ignored by Git. Only the state README files and templates are tracked initially.

If a team later needs task artifacts in Git, change the policy explicitly after privacy, security, history, and collaboration review. Never force-add private content under the current policy.
