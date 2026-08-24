---
plan: fmops-06-native-engine-plan
epic: fmeng-taskops
story: fmops-06-native-engine
kind: implementation-plan
created: 2026-08-24
authors: crewmate (ak:plan)
status: task-time
builds: fmops-06-native-engine
sources:
  - stories/fmops-06-native-engine.md
  - approved plan fmops-04-native-engine-plan (`../260823-2058-epic-fmops-taskmodel/stories/fmops-04-native-engine-plan/plan.md`)
  - architecture.md (`../260824-1046-epic-fmeng-taskops/architecture.md`)
  - review fmops-04b (`../260824-1046-epic-fmeng-taskops/reports/fmops-04b-plan-review/report.md`)
---

# fmops-06 task-time plan — PR-1 engine core on `nphattai/tasks-axi`

Refresh of the captain-APPROVED plan, narrowed to PR-1 (the fork engine core). All file:line
anchors in the upfront plan (`fmops-04-native-engine-plan`) were re-verified against this
worktree's HEAD (see §0). Nothing below reopens the design or reroutes the plan.

---

## 0. Refresh check (HEAD anchors vs upfront plan)

Verified 2026-08-24 against the fork base branch (`epic/fmeng-taskops` = `main`). Every anchor
the upfront plan cites is BYTE-EXACT:

| Upfront plan anchor | HEAD status |
|---|---|
| `src/cli.ts` COMMANDS L86 / COMMAND_HELP L112 / TOP_HELP L65 | matches |
| `src/commands/crud.ts` addCommand L227 / `--report` L238 / requireTypedLinkUrl L132-154 err L150 | matches |
| `src/commands/state.ts` doneCommand L153-236 | matches |
| `src/backends/markdown-grammar.ts` REPORT_LINK L129 / deriveLinks L156-173 / buildProse L302 | matches |
| `src/backends/markdown.ts` normalizeTypedLink L143-165 err L157 / appendTitleLink L248 | matches |
| `src/version.ts:25` `parsed.name === "tasks-axi"` / VERSION L36 | matches |
| `package.json` name L2 / version L3 / bin L25 / repository L7 | matches |

No refactor or extraction landed between the upfront plan (2026-08-23) and HEAD. This plan
follows the upfront plan as-is; the extra sections below just spell out the implementation
choices the upfront plan left for build time.

---

## 1. Scope (PR-1 only)

From `stories/fmops-06-native-engine.md`:

- Fork superset. Keep `name: "tasks-axi"` AND bin `tasks-axi`. Bump `version` 0.2.5 → 0.3.0.
  Repoint `repository`/`homepage`/`bugs` to `nphattai/tasks-axi`.
- Every preserved verb (list/show/start/reopen/update/rm/block/unblock/hold/unhold/ready/
  public-followup/mv/prune/render/setup + aliases) keeps byte-exact behavior.
- Enforce-on-write. `add` requires `--epic <slug>` (or the `--child-of <parent-id>` escape);
  the slug must resolve; the resulting task carries a `[<slug>]` title prefix and a
  `parent: <slug>` dep edge, idempotently.
- Native report path. `report path <id>` prints `data/plans/<epic>/reports/<id>-report.md`.
- §10 review fix F2b. `--report <url>` no longer pollutes the title. The store keeps report
  links out-of-title, the grammar renders and parses a real `(report: <url>)` tag.
- New verbs registered in cli.ts + TOP_HELP + COMMAND_HELP: `epic`, `story`, `report`,
  `doctor`, `migrate`.
- Skill regenerates via `pnpm run build:skill`; `--check` stays green.

Out of PR-1: F1 (firstmate `fm-captain-hold.sh` add-site wiring — rides fmops-07); running
`migrate` against real data (per-home ops step). The `migrate` verb IS built here so it
ships with 0.3.0 for PR-3 to run, per upfront plan Step 1.7.

## 2. Implementation choices (the pieces the upfront plan left for build time)

### 2.1 The membership resolver (`src/epic-paths.ts`)

Pure module, one owner per lookup. Imported by crud/epic/story/report/doctor/migrate.

```ts
// dataRoot defaults to dirname(config.path) — matches firstmate's <home>/data layout.
resolveEpicDir(slug: string, opts?: {dataRoot?: string}): string      // throws EPIC_NOT_FOUND
reportPath(epicDir: string, id: string): string                        // <epicDir>/reports/<id>-report.md
epicOfTask(task: Task): string | null                                  // parent: edge → [<slug>] title tag
```

- `resolveEpicDir(slug)` scans `<dataRoot>/plans/*/epic.md`, reads its YAML frontmatter,
  matches `epic: <slug>`, and asserts the dir infix `-epic-<slug>` agrees. No fancy YAML
  library — a small inline `epic:\s*(\S+)` frontmatter lookup (mirrors firstmate's
  `epic_status_find_dir`).
- `epicOfTask`: prefer the `parent:` edge whose id looks like an epic slug (validated via
  `resolveEpicDir` when the caller supplies a dataRoot); else fall back to a `[<slug>]`
  title-prefix scan `/^\[([a-z][a-z0-9-]*)\]\s+/`.

### 2.2 `add` enforcement + title/edge stamping (`src/commands/crud.ts`)

New flags on `add` (parsed BEFORE positional parsing so the help text is honest):

- `--epic <slug>` — required unless `--child-of` is present.
- `--child-of <parent-id>` — the escape for decision-hold children. Mutually exclusive with
  `--epic`. Parent must exist. Child inherits the parent's epic via `epicOfTask(parent)`
  (throws `EPIC_UNRESOLVED_PARENT` if the parent has none — never silently orphan).
- `--story <id>` — optional, tightens `parent:` to a story instead of the raw epic. Story
  id must exist. Not required in PR-1 (child-of covers the story case too).

Resolution + stamping (idempotent):
1. Resolve the effective epic slug (from `--epic` or via `epicOfTask` on `--child-of` target).
2. `resolveEpicDir(slug)` — throws `EPIC_NOT_FOUND` (VALIDATION_ERROR) if the dir is absent.
3. Title: if `/^\[[a-z][a-z0-9-]*\]\s/` already present, leave; else prepend `[<slug>] `.
4. Deps: if a `parent:` edge already exists (any target), leave; else append
   `parent: <child-of-target ?? slug>`.

Errors:
- Neither `--epic` nor `--child-of` → `EPIC_REQUIRED` (VALIDATION_ERROR), one-line hint
  pointing at `--epic <slug>` or `--child-of <parent-id>`.
- Both → `VALIDATION_ERROR`.

### 2.3 F2b — out-of-title `(report: <url>)` grammar token

Widen + parse + render. NO title mutation for `--report`.

**Grammar (`src/backends/markdown-grammar.ts`)**:
- `REPORT_LINK` regex widens to `\bdata\/(?:plans\/[^/\s]+\/reports\/[^/\s]+\-report\.md|[^\s]+\/report\.md)\b`
  so legacy prose `data/<id>/report.md` AND native `data/plans/<epic>/reports/<id>-report.md`
  both parse from prose (backward compat for hand-written and untouched legacy lines).
- New tail matcher `TAIL_REPORT = /\s*\(report:\s*([^()\s]+)\)\s*$/` (single-token URL, no
  parens, no whitespace inside — report paths satisfy this).
- `extractTags` collects `(report: <url>)` tags off the tail and merges them into
  `tags.links` deduped against `deriveLinks(cleaned_title)` by URL. Order: prose-derived
  first (stable with existing behavior), then out-of-title tag survivors.
- `buildProse` renders `(report: <url>)` after `(hold: …)` and BEFORE reason-carrying dep
  edges (which the grammar already emits last), for each report link in `task.links` whose
  URL is not present in `deriveLinks(task.title)` — so a rendered task never has a report
  URL both in prose and as a tag.

**Backend (`src/backends/markdown.ts`)**:
- `normalizeTypedLink` inherits the widened regex; update the report error string to
  `"a data/<id>/report.md or data/plans/<epic>/reports/<id>-report.md path"`.
- `appendTitleLink(title, link)` becomes report-aware: for `link.kind === "report"`, return
  the title UNCHANGED. Callers pass those links through to `task.links` directly.
- `taskFromInput`, `update()` `addLinks` loop, `transition()` `transitionLinks` loop: split
  the input links into `(non-report → appendTitleLink)` + `(report → push to task.links
  after the derive step)`. The composition after mutation is:
  `task.links = deriveLinks(task.title).concat(reportLinks not in prose).dedup(url)`.

**CLI (`src/commands/crud.ts`)**:
- `requireTypedLinkUrl` inherits the widened regex; update the error string to match the
  backend's.

### 2.4 New verbs (registered in `src/cli.ts`)

Each command dispatches on its first positional (the `public-followup` pattern).

- **`src/commands/epic.ts`** — `epic new|list|show`.
  - `epic new <slug> --title <t> --repos <a,b> [--homes <a,b>] [--signed-off YYYY-MM-DD] [--json]`
    writes `plans/<YYMMDD>-epic-<slug>/epic.md` with frontmatter (`epic`, `title`, `repos`,
    `homes`, `signed_off`). Re-run is idempotent (no-op if slug already resolves).
  - `epic list [--json]` — rollup: for every epic, count `total`/`done`/`in_flight`/
    `queued` tasks (via `epicOfTask`); derived status = `complete` (signed + all done) /
    `active` (signed + open) / `draft` (unsigned). No `status:` stored.
  - `epic show <slug> [--json]` — the same rollup for one epic + a task list.
- **`src/commands/story.ts`** — `story new|list`.
  - `story new <id> --epic <slug> --repo <r> --pr-base <b> [--kind ship|scout] [--gate]
    [--depends <a,b>] [--json]` writes `plans/<epic-dir>/stories/<id>.md` with NO
    `status:` field. Idempotent.
  - `story list --epic <slug> [--json]` — list stories under an epic.
- **`src/commands/report.ts`** — `report path <id> [--json]`. Prints the native path
  computed from `epicOfTask(store.get(id))`. Fails with `EPIC_NOT_FOUND` (or a distinct
  `TASK_HAS_NO_EPIC` when the task exists but is orphan) — the plan says a task's epic is
  always resolvable under enforced add, so this is a real error, not a soft null.
- **`src/commands/doctor.ts`** — no-write integrity net. Scans live tasks and reports
  (exit 1 if any finding):
  1. Orphan tasks (no `epicOfTask`).
  2. Dangling epic FK from a story (`epic:` slug that doesn't resolve).
  3. Missing native report for a Done task with a `report:` link OR whose report file is
     absent at `reportPath(epic, id)`.
  Read-only; NOT the enforcement path (`add` is).
- **`src/commands/migrate.ts`** — three idempotent transforms with `--dry-run`:
  1. Strip `status:` line from every `plans/*/stories/*.md`.
  2. Move `data/<id>/report.md` → native path via `reportPath(epic, id)`. If the
     destination exists as a real file (not a symlink), refuse with `REPORT_COLLISION`
     and name both paths — never overwrite (review §F5). If it's a symlink, replace with
     the real file. If the source is empty after the move, delete the empty dir.
  3. Backfill membership on live orphans: attach to the inferable epic (via `epicOfTask`
     fallback that succeeds on a title tag), else `ops`. Never invents epic membership
     for a Done task (their state is frozen).
  Dry run prints a bounded plan (counts + per-transform samples), writes nothing.

### 2.5 Version + package metadata (`package.json`, no code impact)

Bump `version` 0.2.5 → 0.3.0. Repoint `repository.url`, `homepage`, `bugs.url` to
`nphattai/tasks-axi`. Keep `name` = `"tasks-axi"` and `bin.tasks-axi` unchanged — the
`version.ts` name-assert and the fleet `--version` compat probe depend on both. Add a
short `HARDFORK.md` note declaring no upstream-merge tracking.

### 2.6 Skill regeneration

`skills/tasks-axi/SKILL.md` is auto-generated (`pnpm run build:skill`) and CI-enforced
with `--check`. Regenerate as the last build step so CI stays green.

## 3. Ordered build (roughly `ak:cook`-shaped)

1. **Package metadata + HARDFORK.md.** No code churn; unblocks the version-floor path.
2. **Grammar + backend for F2b.** Widen REPORT_LINK, add TAIL_REPORT, teach `buildProse`
   the tag, update `appendTitleLink` + `taskFromInput`/`update`/`transition` to route
   report links out-of-title. Update error strings.
3. **`src/epic-paths.ts`** with unit tests.
4. **`add` enforcement + stamping** (crud.ts) with unit tests. Update existing add tests
   that no longer pass under required-epic (add `--epic` to every add call the test
   suite uses; tests become superset proof that add is compatible on shape).
5. **New verb files** (epic/story/report/doctor/migrate) + tests per verb.
6. **Register verbs in cli.ts**, extend TOP_HELP + COMMAND_HELP.
7. **Regenerate skill** (`pnpm run build:skill`), run `--check`.
8. **Full green**: `pnpm test` + `pnpm lint` + `pnpm build` + `pnpm run build:skill --check`.

## 4. Test strategy

- **Compat gate = the existing test suite passing on the fork.** Every preserved verb has
  test coverage today (`test/commands/*.test.ts`, `test/backends/markdown*.test.ts`, the
  `firstmate-backlog.md` fixture round-trip). Passing these end-to-end IS the byte-exact
  proof of the superset promise for preserved verbs. This is a lighter interpretation of
  the upfront plan's "v0.2.5 golden" — same guarantee (no preserved-verb regression),
  reuse of existing infrastructure. Tests that must be edited on purpose (add now
  requires `--epic`; `--report` no longer appends to title) are documented in-plan as
  intentional per §1.
- **Enforcement (test-first)**: `add x "t"` → `EPIC_REQUIRED`; `add x "t" --epic nope` →
  `EPIC_NOT_FOUND`; `add x "t" --epic fmops` → title `[fmops] t`, dep `parent: fmops`;
  `add x "[fmops] t" --epic fmops` → title unchanged (idempotent); `add child --child-of
  parent` inherits epic from parent.
- **F2b round-trip (test-first)**: `done x --report data/plans/e/reports/x-report.md` →
  `(report: <url>)` tag in the rendered line, URL NOT in title; parse → render restores
  byte-exact; legacy `data/<id>/report.md` in prose still parses on untouched raw lines.
  Also assert the OLD title-embedded shape parses (`- [x] x - t data/x/report.md
  (reported 2026-06-01)`) and re-renders with the URL absent from the title (F2b intent).
- **New verbs**: one focused vitest per file, using a `tmp` `data/plans/` fixture with
  an `epic.md`, a `stories/*.md`, and a `backlog.md`. `epic list --json` returns the
  rollup shape. `story new` writes frontmatter without `status:`. `report path <id>`
  computes the native path. `doctor` exits 1 on a planted orphan / dangling FK. `migrate
  --dry-run` writes nothing; `migrate` is idempotent (second run = no-op); refuses on a
  real-file collision.

## 5. Acceptance (mapped to story DoD)

- Fork builds + tests green. ✓ (test suites above)
- npm name + bin name stay `tasks-axi`; `--version` prints `0.3.0`. ✓ (§2.5 + existing
  `test/bin/version-fast-path.test.ts`)
- Epic/Story/Task/Report first-class. ✓ (§2.4)
- `add` refuses without a resolvable `--epic`. ✓ (§2.2 + tests)
- `report path <id>` prints the native path. ✓ (§2.4)
- F2b out-of-title `report:` token present. ✓ (§2.3 + tests)
- PR-1 opened on the fork against `epic/fmeng-taskops`. ✓ (delivery)

## 6. Deliberate non-goals (defer)

- Migrating any live data (per-home ops step, PR-3 in the upfront plan).
- Firstmate integration wiring (fmops-07: `fm-brief.sh`, `fm-teardown.sh`,
  `fm-captain-hold.sh`, floor bump + probe).
- Dashboard cleanup (fmops-08 / upfront plan PR-4).

## 7. Ponytail lens (rungs actually taken)

- Reuse `epicOfTask` in every new verb — one owner for the parent/tag fallback lookup.
- Reuse `takeFlag`/`takeBoolFlag`/`requirePositionals`/`validateId` — no new arg helpers.
- Reuse `renderMutation`/`taskToJson`/`renderOutput` for command output — no new output
  shape.
- Reuse the extractTags/buildProse tag machinery for the new `(report: …)` — no parallel
  grammar layer.
- Do NOT invent a YAML parser; the tiny frontmatter needle is a regex.
- Do NOT introduce a new store method for epic/story/report — the resolver reads the
  filesystem directly. Adding a Store method for them would carry to sqlite/remote
  backends we do not have.

## 8. Open questions

None blocking. `--story <id>` is included as a natural extension of `--child-of` but not
required by the story DoD; it lands with an inexpensive test.
