# Workspace Extension Policy

## Purpose

Extend KOKO without speculative structure, duplicated responsibility, instruction bloat, or unclear lifecycle.

## Required Assessment

Before creating or materially restructuring a persistent directory or architecture domain:

1. Classify the information or implementation type.
2. Check whether an existing directory already owns it.
3. Establish why a new top-level directory is necessary now.
4. Describe its responsibility in one unambiguous sentence.
5. Define creation, active use, update, archival, and removal lifecycle.
6. Identify its authoritative source and conflict rules.
7. Identify who or what may write it.
8. Define tracked, ignored, generated, or private-first Git policy.
9. Review secrets, privacy, copyright, binary, and file-size risks.
10. Decide whether unique subtree behavior justifies nested AGENTS.md.
11. Decide whether a human README is useful rather than automatic.
12. Update directory-map.md.
13. Check for duplicated or overlapping responsibility.
14. Update source-of-truth.md when authority changes.

Use the evolve-workspace Skill for this assessment. Use research-plan-implement and human approval when the change is Level 3 or materially changes established architecture.

## Adding a Skill

Add a Skill only when the workflow is repeated, order-sensitive, project-specific, costly to perform incorrectly, too detailed for AGENTS.md, and expressible with a clear trigger. First attempt to extend an existing Skill. Do not create a Skill for a one-time task.

A new Skill starts with only SKILL.md containing valid name and description frontmatter. Add scripts, references, assets, or UI metadata only for a demonstrated use.

## Naming

Use lowercase kebab-case for ordinary directories and standard uppercase names for documented special files. Use YYYY-MM-DD-topic.md for dated artifacts and TASK-YYYYMMDD-short-kebab-description for tasks.

Do not create ambiguous buckets or faux versions such as misc/, other/, stuff/, temp2/, new/, old2/, final/, final-v2/, or final-final/. Git owns version history.

## Implementation Domains

Do not pre-create src/, app/, apps/, frontend/, backend/, server/, client/, api/, services/, packages/, libs/, infra/, database/, mobile/, or web/. Introduce the smallest structure only after the product and technology decisions make its responsibility concrete.
