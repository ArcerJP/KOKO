# Documentation Guidance

These rules apply only under docs/.

- Use Markdown unless another format is explicitly required.
- Separate verified facts from inference, proposals, and unresolved questions.
- Separate current authoritative state from future possibilities.
- Keep each rule, specification, and decision in one authoritative location; link rather than copy.
- Do not mix normative project documentation with derived knowledge from knowledge/wiki/.
- Update or retire obsolete documentation when behavior or architecture changes; do not leave silent contradictions.
- When architecture changes, check directory-map.md, source-of-truth.md, extension-policy.md, portability.md, README.md, and relevant cross-references.
- Consider an ADR for consequential, disputed, cross-cutting, or hard-to-reverse decisions.
- Preserve the distinction between accepted current decisions and proposed future work.

Keep this file scoped and concise. Detailed architecture belongs in docs/architecture/.
