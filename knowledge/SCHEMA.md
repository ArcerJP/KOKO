# Knowledge Schema

## Purpose

The knowledge system preserves original evidence separately from reusable synthesis, with provenance, authority, privacy, and lifecycle made explicit.

## Layers

### raw

knowledge/raw/ contains evidence or source material such as specifications, PDFs, exported data, user-provided references, external documentation snapshots, original text, and original datasets.

Raw material is normally immutable after ingestion. If a source is wrong, preserve it and record corrections, contradictions, or interpretation in the wiki.

### wiki

knowledge/wiki/ contains maintained, reusable knowledge synthesized from raw or authoritative external evidence. Wiki pages are secondary sources and must not erase uncertainty or contradicting evidence.

## Authority

For claims about source content:

~~~text
raw evidence > derived wiki
~~~

Normative project specifications remain in docs/ and implemented behavior remains authoritative in the actual source/runtime. The wiki does not override either category.

## Ingest Workflow

Use the knowledge-ingest Skill:

1. Classify source and provenance.
2. Assess sensitivity, rights, secrets, format, and size.
3. Decide whether storage is permitted.
4. Preserve permitted raw evidence without rewriting it.
5. Inspect the source and existing wiki.
6. Record contradictions and distinguish facts from inference.
7. Update the canonical wiki topic with references.
8. Update the wiki index and change log.
9. Verify consistency, privacy, and Git policy.

## Naming

- Use lowercase kebab-case Markdown names for ordinary wiki topics.
- Use YYYY-MM-DD-topic.md when a dated snapshot is intrinsic to the artifact.
- Preserve meaningful original filenames for raw evidence when safe; add a stable contextual prefix if collision or provenance would otherwise be unclear.
- Do not use final-v2, final-final, new, old2, misc, other, or stuff.

## Source References

A wiki claim should cite the most precise available source:

- Repository raw source: relative path, relevant section/page/record, and source date if known.
- External authoritative source: direct URL, publisher, title, and access or verification date when currency matters.
- User-provided evidence not stored in Git: describe provenance without exposing confidential contents or personal data.

Clearly mark quoted text, paraphrase, fact, inference, and unresolved interpretation. Do not cite a wiki page as a substitute for its raw source when verifying the original.

## Contradictions

Do not silently choose between conflicting sources. Record:

- the competing sources;
- their dates, versions, scope, and authority;
- the precise disagreement;
- whether resolution is known, inferred, or pending;
- the downstream implications.

If the contradiction affects a current normative specification or implementation, route it to docs/, an ADR, or the relevant task rather than resolving it only in the wiki.

## Updates

Update an existing canonical page when it already owns the topic. Create a new page only for a distinct reusable responsibility. Preserve meaningful history through Git and the wiki log; do not create filename-based versions.

Re-check source currency when a claim is likely to have changed. Mark stale or superseded knowledge rather than leaving it apparently current.

## Index

knowledge/wiki/index.md lists canonical wiki pages and their purpose. Every durable topic page must be reachable from the index. The index is navigation, not a duplicate summary of every page.

## Change Log

knowledge/wiki/log.md records dated knowledge additions, material revisions, contradiction updates, and retirements with concise source references. It is not a copy of page contents or Git history.

## Privacy

Before storing source material, check for personal data, credentials, confidential content, contractual restrictions, copyright constraints, and unnecessary sensitive detail. Store the minimum required information. If authorization is unclear, do not add the material and ask the user.

Never reproduce or report detected secret values. Report only the affected path and next safe action.

## Git Policy

knowledge/raw/ is private-first and ignored by default except for its README.md. Do not force-add raw content. A future decision to track a raw class requires explicit policy, rights and privacy review, file-size review, and any needed LFS decision.

knowledge/wiki/ may be tracked when content and source references are public-safe and repository-appropriate. Do not move sensitive raw content into a tracked wiki summary to bypass the raw policy.
