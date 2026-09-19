---
name: evolve-workspace
description: Use before adding or restructuring top-level directories, repository-wide instructions, nested AGENTS.md files, Skills, architecture domains, or other persistent KOKO workspace structures.
---

# Evolve the Workspace

Evolve KOKO only for a present, evidenced responsibility. Read docs/AGENTS.md, docs/architecture/directory-map.md, docs/architecture/source-of-truth.md, and docs/architecture/extension-policy.md before editing persistent architecture.

## Workflow

1. State the requirement and the concrete problem the proposed structure solves.
2. Inspect the current directory map and actual repository state.
3. Identify the authoritative source for the information or behavior.
4. Test whether an existing category already fits.
5. Check for overlapping or duplicated responsibility.
6. Define lifecycle: creation, active use, update, archival, and removal.
7. Classify privacy, secret, copyright, and data-handling risks.
8. Define tracked, ignored, generated, or private-first Git policy.
9. Estimate Codex context cost and preserve progressive disclosure.
10. Justify any new top-level directory in one unambiguous sentence.
11. Add nested AGENTS.md only when the subtree needs behavior not already covered by its parent.
12. Add a Skill only for a repeated, order-sensitive, project-specific workflow with a clear trigger and meaningful error cost; first test whether an existing Skill can own it.
13. Identify directory-map, source-of-truth, architecture, README, ADR, and cross-reference impacts.
14. For non-trivial or Level 3 changes, research, plan, obtain required approval, and then implement the minimal coherent change.
15. Audit structure, naming, responsibilities, instruction hierarchy, cross-references, privacy, Git policy, and absence of obsolete architecture.

## Constraints

- Do not create structure because it might be convenient someday.
- Do not create misc/, other/, stuff/, new/, old2/, final/, or final-final/.
- Do not add empty scripts/, references/, assets/, source, application, infrastructure, or adapter directories without a current use.
- Do not duplicate complete procedures between AGENTS.md, Skills, README files, and architecture docs.
- Record consequential, hard-to-reverse architecture choices in an ADR.
- When a real migration to another AI IDE is requested, verify that IDE's current official specification before designing the smallest adapter or migration.
