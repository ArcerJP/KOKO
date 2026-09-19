---
name: knowledge-ingest
description: Use when adding source material to knowledge/raw or converting source evidence into reusable knowledge/wiki documentation while preserving provenance and raw/wiki separation.
---

# Knowledge Ingest

Read knowledge/AGENTS.md and knowledge/SCHEMA.md before ingesting material. Raw evidence has authority over derived wiki content.

## Workflow

1. Classify the source type, ownership, provenance, expected reuse, and whether it is evidence or already a synthesis.
2. Check for secrets, personal data, confidentiality, copyright restrictions, licensing limits, large files, and binary content.
3. Decide whether repository storage is permitted. If uncertain or sensitive, keep it outside Git and request direction; do not reproduce protected content unnecessarily.
4. Save permitted evidence under knowledge/raw/ with a stable descriptive name. Preserve the original; do not rewrite it to fix perceived errors.
5. Inspect enough of the source to support the intended claims.
6. Search knowledge/wiki/index.md and relevant wiki pages for an existing topic.
7. Compare the source with existing evidence and record contradictions rather than silently choosing one account.
8. Update an existing wiki page when it already owns the topic; create a new page only for a distinct reusable responsibility.
9. Add precise source references that identify the raw artifact or authoritative external source and distinguish facts from inference.
10. Update knowledge/wiki/index.md with the canonical wiki entry.
11. Append a concise dated entry to knowledge/wiki/log.md describing the knowledge change and sources.
12. Verify provenance, links, contradiction notes, privacy, Git policy, and consistency with existing docs.

## Boundaries

- Do not generate many summaries of the same source; integrate into the existing canonical topic when possible.
- Do not cite a wiki summary as proof of what a raw source says when the raw source is available.
- Do not force-add ignored raw material.
- Do not turn task-only research into durable wiki content unless it has demonstrated cross-task value.
- Do not copy a normative project specification into the wiki; current specifications belong in docs/.
