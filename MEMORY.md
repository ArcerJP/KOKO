# Durable Project Memory

- KOKO itself is the repository root; do not create a nested KOKO/KOKO root.
- OpenAI Codex is the primary AI development environment.
- KOKO adopts the five-pattern workspace architecture documented in docs/architecture/five-patterns.md.
- The technology stack and product shape are not selected.
- knowledge/raw/ holds evidence; knowledge/wiki/ holds derived knowledge.
- Task state moves through work/inbox/, work/notebook/, work/outbox/, and work/archive/.
- Codex-native repository instructions use AGENTS.md and repository Skills use .agents/skills/.
- Other AI IDE compatibility is deferred until a real migration is requested.

Keep this file brief and public-safe. Put detailed current architecture in docs/, task context in work/, and temporary context in memory/.
