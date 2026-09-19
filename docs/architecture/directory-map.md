# Directory Map

## Registry

| Path | Purpose | Category | Authority | Read timing | Write policy | Git policy | Lifecycle |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AGENTS.md | Repository instruction and routing | Codex-native instruction | Authoritative for repository behavior | Automatic at repository-root discovery | Controlled, concise, repository-wide only | Tracked | Durable |
| .agents/skills/ | Repeatable task workflows | Codex-native Skills | Authoritative for selected procedure | On trigger or explicit invocation | One focused Skill per justified workflow | Tracked | Durable, evolvable |
| README.md | Human entrypoint | Orientation | Informative; links to formal docs | On onboarding | Concise overview, not architecture manual | Tracked | Durable |
| SOUL.md | Collaboration values | KOKO context | Authoritative for values | On demand | Values only; no procedures | Tracked | Durable |
| IDENTITY.md | Repository-local AI role | KOKO context | Authoritative for role boundary | On demand | No model-version binding | Tracked | Durable |
| USER.md | Collaboration preferences | KOKO context | Authoritative for recorded preferences | On demand | Public-safe, no inferred personal facts | Tracked | Durable |
| TOOLS.md | Tool guidance | KOKO context | Authoritative for repository tool policy | Before relevant tool work | No credentials or stale version claims | Tracked | Durable |
| MEMORY.md | Project continuity | KOKO memory | Authoritative only for concise continuity | When prior context matters | Public-safe summaries and links | Tracked | Durable |
| memory/ | Daily or temporary context | KOKO memory | Temporary | For relevant active context | Date/topic files; selectively promote | README tracked; dynamic entries ignored | Short-lived |
| docs/AGENTS.md | Documentation-only behavior | Nested Codex instruction | Authoritative under docs/ | When CWD/path scope includes docs, or explicitly routed | Scoped rules only | Tracked | Durable |
| docs/architecture/ | Current formal architecture | Normative docs | Authoritative for documented architecture | On architecture-dependent work | Update with implementation; avoid proposals as current state | Tracked | Durable |
| docs/decisions/ | Architecture decision records | Normative decisions | Authoritative for accepted decisions | When rationale or alternatives matter | Append decisions; supersede explicitly | Tracked | Durable history |
| knowledge/AGENTS.md | Knowledge-only behavior | Nested Codex instruction | Authoritative under knowledge/ | When CWD/path scope includes knowledge, or explicitly routed | Scoped rules only | Tracked | Durable |
| knowledge/SCHEMA.md | Knowledge system rules | Normative schema | Authoritative for knowledge handling | Before ingestion or schema change | Controlled; update related guidance | Tracked | Durable |
| knowledge/raw/ | Original evidence and sources | Evidence | Primary source | On demand for source claims | Import/append; normally immutable | README tracked; contents ignored/private-first | Durable when permitted |
| knowledge/wiki/ | Reusable derived knowledge | Synthesis | Secondary to raw evidence and normative docs | On relevant research | Maintain canonical topic pages with provenance | Tracked when public-safe | Durable, revisable |
| work/AGENTS.md | Work-only behavior | Nested Codex instruction | Authoritative under work/ | When CWD/path scope includes work, or explicitly routed | Scoped rules only | Tracked | Durable |
| work/WORKFLOW.md | Task state model | Normative workflow | Authoritative for task states | Before state changes | Change only with lifecycle review | Tracked | Durable |
| work/_templates/ | Task artifact templates | Template | Authoritative starting structure | When creating corresponding artifact | Adapt without changing category meaning | Tracked | Durable |
| work/inbox/ | Received, unstarted tasks | Task state | Task folder location | At intake/triage | Create request; move to start | README tracked; tasks ignored/private-first | Pending |
| work/notebook/ | Active task context | Task state | Task folder location | During active work | One active folder; no source copies | README tracked; tasks ignored/private-first | Active |
| work/outbox/ | Codex-complete handoff | Task state | Task folder location | At review/handoff | Include evidence; await human disposition | README tracked; tasks ignored/private-first | Review pending |
| work/archive/ | Confirmed historical tasks | Task history | Task folder location | On historical lookup | Move into YYYY/task-id after close | README tracked; tasks ignored/private-first | Archived |
| .github/PULL_REQUEST_TEMPLATE.md | Pull request prompts | Collaboration template | Authoritative for default PR structure | When preparing a PR | Do not copy private task content | Tracked | Durable |
| Future source tree | Actual product implementation | Source/runtime | Authoritative for implemented behavior | During product work | Created only after stack/shape decision | Tracked as later policy defines | Product lifecycle |

## Registry Maintenance

Any persistent path added, removed, or materially repurposed must update this registry after following extension-policy.md. A path must have one clear responsibility, authority, read timing, write policy, Git policy, and lifecycle.
