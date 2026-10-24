# The routing guide ships without workflows or routes

- found: 2026-10-24, plan: 20261024-loremax-workflow-routing-guide, phase: internal review
- severity: major
- area: guide.mjs

0.3.0 ships `GUIDE.workflows = {}` and `GUIDE.routes = []` (guide.mjs:33-34): Task 7 of the plan was blocked because
the catalog export did not exist, and its checkboxes were ticked with ⚠️ notes so the loop would not retry it. Until
the guide is filled, `recommended`, `use_for` and `guide` never appear in a `loremax_workflows` reply in either mode;
agents get only the generic `rules`.

To fill it:

- produce the catalog export with the read-only script in the private LoreMax repository (public fields of the
  workflows available to all organizations only) at `docs/catalog/loremax-workflows.json` (git-ignored), or set
  `LOREMAX_CATALOG_EXPORT` to its path;
- fill `GUIDE.workflows` (`use_for`, `knobs`, `caveats`; keys are visual ids, else `id:<n>`) and `GUIDE.routes` for the
  tasks listed under Technical Details → Routes in docs/plans/20261024-loremax-workflow-routing-guide.md (cheap or
  draft workflows never first), and carry over the media-generation caveats;
- no organization-specific names, provider URLs, prices or internal settings (the repository is public);
- run `npm test`: the export check in test/guide.test.mjs stops being skipped and checks every key against it;
- release, with a CHANGELOG entry saying `recommended` now ships.
