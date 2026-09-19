# KOKO

## Overview

KOKO is a Codex-native workspace foundation designed to keep instructions, evidence, knowledge, plans, implementation, memory, and task state distinct as the project grows.

## Current Status

The repository currently contains only the AI-native workspace architecture. The product purpose, technology stack, application structure, database, infrastructure, and deployment model remain undecided.

## Primary AI Environment

OpenAI Codex is the canonical AI development environment across Codex CLI and the Codex IDE extension. Repository instructions use AGENTS.md and repeatable workflows use repository Skills under .agents/skills/.

## Design Philosophy

KOKO combines five patterns:

1. Layered repository, directory, and task instructions.
2. Separation of raw evidence from derived knowledge.
3. Research, plan, implement, verify, and review for non-trivial work.
4. Separation of AI values, role, user context, tools, and memory.
5. An inbox, notebook, outbox, and archive task lifecycle.

The architecture uses progressive disclosure: the structures exist, but Codex reads them only when relevant.

## Directory Overview

~~~text
KOKO/
├── AGENTS.md              Repository-wide Codex routing
├── .agents/skills/        Repeatable Codex workflows
├── docs/                  Authoritative documentation and ADRs
├── knowledge/raw/         Original evidence, private-first
├── knowledge/wiki/        Derived reusable knowledge
├── work/                  Task lifecycle artifacts, private-first
├── memory/                Temporary local memory, private-first
└── MEMORY.md              Durable public-safe continuity
~~~

See docs/architecture/directory-map.md for the formal registry.

## Knowledge Lifecycle

Original source material enters knowledge/raw/. Reusable synthesis belongs in knowledge/wiki/ with provenance. Raw evidence has authority over derived summaries.

## Work Lifecycle

Tasks move rather than copy through:

~~~text
inbox → notebook → outbox → archive
~~~

Dynamic task contents are local and ignored by Git by default.

## Codex Instructions

AGENTS.md provides concise repository routing. Nested AGENTS.md files add subtree-only rules. The five Skills under .agents/skills/ provide task-specific procedures.

## Git / GitHub

The default branch is main and commits follow Conventional Commits where practical. Secrets and private working material must not be committed. GitHub owner and visibility are explicit user decisions.

## Extending KOKO

Before adding a top-level directory, instruction layer, or Skill, follow .agents/skills/evolve-workspace/SKILL.md and docs/architecture/extension-policy.md.

## Portability

KOKO is currently Codex-native. Other AI IDE adapters are intentionally absent and should be designed only when a real migration is requested. See docs/architecture/portability.md.
