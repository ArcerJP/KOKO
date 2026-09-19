# Codex Runtime and KOKO Conventions

## Purpose

This document distinguishes behavior implemented by OpenAI Codex from information architecture conventions implemented by KOKO.

## Codex-native Mechanisms

KOKO uses these Codex-native mechanisms:

- Root AGENTS.md for repository-wide instructions and routing.
- Nested AGENTS.md files for rules scoped to docs/, knowledge/, and work/.
- .agents/skills/<skill-name>/SKILL.md for repository-specific repeatable workflows.

According to the official OpenAI documentation verified on 2026-09-19, Codex builds its project instruction chain from the repository root to the active working directory, with deeper instructions taking precedence. It scans repository Skill locations under .agents/skills from the active working directory upward to the repository root. A Skill requires SKILL.md frontmatter containing name and description; optional resources are loaded only when needed.

The official Skill documentation states that standalone Skills are available in Codex CLI and the Codex IDE extension. KOKO therefore uses the same repository Skill path for both environments rather than maintaining interface-specific copies.

Because instruction discovery follows the active working-directory path, a Codex session started at the repository root does not thereby load every descendant AGENTS.md. Root routing therefore requires reading the applicable nested guidance before changing a scoped subtree from the root.

Official references:

- [Custom instructions with AGENTS.md](https://developers.openai.com/ja-JP/docs/agent-configuration/agents-md)
- [Build skills](https://developers.openai.com/ja-JP/docs/build-skills)

## KOKO Architecture Conventions

The following are ordinary repository files and directories whose meaning is defined by KOKO:

- SOUL.md — collaboration values.
- IDENTITY.md — repository-local AI role.
- USER.md — durable user collaboration context.
- TOOLS.md — tool and environment guidance.
- MEMORY.md — concise durable project continuity.
- memory/ — temporary local memory.
- knowledge/ — evidence and derived knowledge.
- work/ — task lifecycle and task artifacts.
- docs/ — authoritative project documentation.

These paths do not gain automatic instruction semantics merely by existing. AGENTS.md or a selected Skill routes Codex to them when the task needs their contents.

## Context Loading Philosophy

1. Load repository-wide behavior through root AGENTS.md.
2. Load scoped rules only for the subtree being changed.
3. Load a Skill only when its description or explicit invocation matches the task.
4. Load detailed docs, evidence, wiki knowledge, task artifacts, or memory only when relevant.
5. Prefer links and routing over copying source text into always-on instructions.

## No Fake Auto-loading

Documentation and prompts must not describe SOUL.md, IDENTITY.md, USER.md, TOOLS.md, MEMORY.md, or KOKO directories as Codex special files. If future Codex behavior changes, verify the current official specification before updating this document and the routing architecture.
