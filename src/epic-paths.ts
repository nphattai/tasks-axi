import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { AxiError } from "./errors.js";
import type { Task } from "./model.js";

/**
 * The one owner of epic → filesystem lookups.
 *
 * Every fmops-first-class verb (add enforcement, `report path`, `doctor`,
 * `migrate`) needs the same three primitives, so they live here rather than
 * re-implemented per command:
 *   - `resolveEpicDir(slug)` scans `<dataRoot>/plans/*` for an `epic.md` whose
 *     frontmatter carries the slug (asserts the dir infix `-epic-<slug>`
 *     agrees). Returns the dir absolute path or throws EPIC_NOT_FOUND.
 *   - `reportPath(epicDir, id)` computes the native report path a task should
 *     land at: `<epicDir>/reports/<id>-report.md`.
 *   - `epicOfTask(task)` reads the task's epic membership from a `parent:`
 *     dep edge first, falling back to a `[<slug>]` title prefix. Returns the
 *     slug or `null` when the task is orphan.
 *
 * `dataRoot` defaults to `dirname(backlog.path)`, matching firstmate's
 * `<home>/data/backlog.md` layout: the epics live at `<home>/data/plans/*`.
 *
 * This module is I/O-only in one direction (readdir/readFile). It does not
 * validate the epic.md is well-formed beyond the minimum needed to match a
 * slug; that check belongs in `doctor`.
 */

const EPIC_SLUG_RE = /^[a-z][a-z0-9-]*$/;
const EPIC_DIR_INFIX_RE = /-epic-([a-z][a-z0-9-]*)(?:$|-)/;
const FRONTMATTER_EPIC_RE = /^epic:\s*(\S+)\s*$/m;
const TITLE_TAG_RE = /^\[([a-z][a-z0-9-]*)\]\s+/;

/** Validate a caller-supplied epic slug shape (before touching the disk). */
export function validateEpicSlug(slug: string): string {
  if (!EPIC_SLUG_RE.test(slug)) {
    throw new AxiError(
      `Invalid epic slug "${slug}"`,
      "VALIDATION_ERROR",
      ["An epic slug must be lowercase kebab-case (e.g. `fmops`, `dcen-11`)"],
    );
  }
  return slug;
}

/** Compute the fmops-native report path for a task under an epic. */
export function reportPath(epicDir: string, id: string): string {
  return join(epicDir, "reports", `${id}-report.md`);
}

/**
 * Read the epic frontmatter needle out of an `epic.md` source. Not a general
 * YAML parser — the plan intentionally scopes this to matching one field.
 */
function readEpicSlug(source: string): string | undefined {
  const match = source.match(FRONTMATTER_EPIC_RE);
  return match ? match[1].trim() : undefined;
}

/**
 * Read a task's epic membership. Preference order:
 *   1. a `parent:` dep edge whose id is a slug shape (`[a-z][a-z0-9-]*`);
 *   2. a leading `[<slug>]` title tag.
 * Returns the raw slug candidate; the caller decides whether to verify it
 * against a real epic dir (`add` does; `doctor` does; `report path` does).
 */
export function epicOfTask(task: Task): string | null {
  for (const dep of task.deps) {
    if (dep.type !== "parent") continue;
    if (EPIC_SLUG_RE.test(dep.id)) return dep.id;
  }
  const match = task.title.match(TITLE_TAG_RE);
  if (match && EPIC_SLUG_RE.test(match[1])) return match[1];
  return null;
}

export interface ResolveOpts {
  /** Root directory that contains `plans/`. Defaults to `dirname(backlogPath)`. */
  dataRoot?: string;
  /** The backlog path — used to derive `dataRoot` when not passed. */
  backlogPath?: string;
}

/**
 * Resolve `<dataRoot>` from the options bag. Callers should pass one of
 * `dataRoot` (explicit) or `backlogPath` (derives from `<home>/data/backlog.md`
 * → `<home>/data`).
 */
export function dataRoot(opts: ResolveOpts): string {
  if (opts.dataRoot) return opts.dataRoot;
  if (opts.backlogPath) return dirname(opts.backlogPath);
  throw new AxiError(
    "epic-paths: no dataRoot or backlogPath provided",
    "UNKNOWN",
  );
}

/**
 * Scan `<dataRoot>/plans/*` for an epic dir whose `epic.md` frontmatter carries
 * the supplied slug. Asserts the dir name's `-epic-<slug>` infix agrees so a
 * typo in either place surfaces here, not silently later. Throws
 * EPIC_NOT_FOUND (VALIDATION_ERROR) on miss.
 */
export function resolveEpicDir(slug: string, opts: ResolveOpts): string {
  validateEpicSlug(slug);
  const plansDir = join(dataRoot(opts), "plans");
  let entries: string[];
  try {
    entries = readdirSync(plansDir);
  } catch {
    throw new AxiError(
      `Epic "${slug}" not found`,
      "VALIDATION_ERROR",
      [`No \`${plansDir}\` directory; create the epic with \`tasks-axi epic new ${slug} ...\``],
    );
  }

  for (const name of entries) {
    const full = join(plansDir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const infix = name.match(EPIC_DIR_INFIX_RE);
    if (!infix || infix[1] !== slug) continue;

    const epicMd = join(full, "epic.md");
    let source: string;
    try {
      source = readFileSync(epicMd, "utf-8");
    } catch {
      continue;
    }
    const declared = readEpicSlug(source);
    if (declared !== slug) {
      throw new AxiError(
        `Epic dir "${name}" declares slug "${declared ?? "(missing)"}" but the dir infix says "${slug}"`,
        "VALIDATION_ERROR",
      );
    }
    return full;
  }

  throw new AxiError(
    `Epic "${slug}" not found`,
    "VALIDATION_ERROR",
    [
      `No \`data/plans/*-epic-${slug}/epic.md\` under ${plansDir}`,
      `Create it with \`tasks-axi epic new ${slug} --title "..." --repos <repo>\``,
    ],
  );
}

/**
 * List every epic dir under `<dataRoot>/plans/*`. Used by `epic list` and
 * `doctor`. Returns tuples of `(slug, epicDir)` in a stable sorted-by-slug
 * order. Silently skips dirs whose `epic.md` is missing or doesn't declare a
 * slug — those are pre-existing corruption, `doctor`'s job to flag, not
 * `epic list`'s.
 */
export function listEpics(opts: ResolveOpts): Array<{ slug: string; dir: string }> {
  const plansDir = join(dataRoot(opts), "plans");
  let entries: string[];
  try {
    entries = readdirSync(plansDir);
  } catch {
    return [];
  }
  const out: Array<{ slug: string; dir: string }> = [];
  for (const name of entries) {
    const full = join(plansDir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const infix = name.match(EPIC_DIR_INFIX_RE);
    if (!infix) continue;
    let source: string;
    try {
      source = readFileSync(join(full, "epic.md"), "utf-8");
    } catch {
      continue;
    }
    const declared = readEpicSlug(source);
    if (declared !== infix[1]) continue;
    out.push({ slug: declared, dir: full });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}
