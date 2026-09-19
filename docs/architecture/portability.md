# AI Environment Portability

## Current Position

OpenAI Codex is the primary AI development environment. The Codex-native configuration is the canonical implementation, using AGENTS.md and .agents/skills/.

No CLAUDE.md, .claude/ directory, Anthropic-specific configuration, or other unused AI IDE adapter is part of the bootstrap.

## Portability Principle

Portability means keeping responsibilities, information categories, lifecycles, evidence boundaries, source-of-truth rules, and workspace structure understandable without depending excessively on one vendor's file names. It does not mean pre-creating compatibility files for tools that are not in use.

Currently, the Codex-native structure is the canonical implementation. If KOKO later migrates to another AI IDE, verify that target IDE's official specification at that time before designing an adapter or migration.

## Future Migration Procedure

Only after an actual migration request:

1. Verify the target IDE's current official documentation.
2. Research the current KOKO architecture and instruction hierarchy.
3. Preserve semantic responsibilities and information classification.
4. Design the smallest necessary target-specific instruction layer.
5. Avoid duplicated canonical instructions between AGENTS.md and the adapter.
6. Verify current compatibility of any Skill standard or translate intentionally.
7. Record the migration or adapter decision in an ADR.
8. Update directory-map.md and source-of-truth.md.
9. Remove obsolete adapters when migration makes them unnecessary.
10. Verify instruction discovery, precedence, workflow behavior, and context cost in the target environment.

Do not freeze today's Claude Code, Gemini CLI, Cursor, or other vendor behavior into this repository. Re-check it when migration becomes real.
