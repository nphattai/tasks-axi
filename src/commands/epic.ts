import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  requireNonEmptyFlagValue,
  requireNonEmptySingleLineFlagValue,
  requirePositionals,
  takeBoolFlag,
  takeFlag,
} from "../args.js";
import { requireCtx, type TasksContext } from "../context.js";
import {
  dataRoot,
  epicOfTask,
  listEpics,
  resolveEpicDir,
  validateEpicSlug,
} from "../epic-paths.js";
import { AxiError } from "../errors.js";
import type { State, Task } from "../model.js";
import { renderJson } from "../confirm.js";
import { field, renderList, renderOutput, renderScalar } from "../toon.js";

export const EPIC_HELP = `usage: tasks-axi epic <command> [args] [flags]
commands:
  new <slug> --title <t> --repos <a,b> [--homes <a,b>] [--signed-off YYYY-MM-DD] [--json]
    Create an epic at data/plans/<YYMMDD>-epic-<slug>/epic.md (idempotent).
    Slug must be lowercase kebab-case; frontmatter carries slug/title/repos/homes/signed_off.
  list [--json]
    List every epic under data/plans/*-epic-*/epic.md with a task rollup and derived status.
  show <slug> [--json]
    Show one epic's rollup: task counts by state plus its tasks.

Epic status is DERIVED, never stored: draft (unsigned) / active (signed + open work) /
complete (signed + all tasks done). See docs/architecture §4.`;

const EPIC_SUBCOMMANDS: Record<string, string> = {
  new: "usage: tasks-axi epic new <slug> --title <t> --repos <a,b> [--homes <a,b>] [--signed-off YYYY-MM-DD] [--json]",
  list: "usage: tasks-axi epic list [--json]",
  show: "usage: tasks-axi epic show <slug> [--json]",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function epicCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const [subcommand, ...args] = rawArgs;
  switch (subcommand) {
    case "new":
      return epicNew(args, context);
    case "list":
      return epicList(args, context);
    case "show":
      return epicShow(args, context);
    default:
      throw new AxiError(
        subcommand
          ? `Unknown epic command: ${subcommand}`
          : "Missing epic command",
        "VALIDATION_ERROR",
        [EPIC_HELP.split("\n")[0]],
      );
  }
}

// ---------------------------------------------------------------------------
// epic new
// ---------------------------------------------------------------------------

interface EpicNewOptions {
  slug: string;
  title: string;
  repos: string[];
  homes: string[];
  signedOff?: string;
  today: string;
}

function parseCsv(flag: string, raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new AxiError(`${flag} must not be empty`, "VALIDATION_ERROR");
  }
  return parts;
}

function today(): string {
  const d = new Date();
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

async function epicNew(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { config } = requireCtx(context);
  const args = [...rawArgs];

  const title = requireNonEmptyFlagValue("--title", takeFlag(args, "--title"));
  const reposRaw = requireNonEmptyFlagValue("--repos", takeFlag(args, "--repos"));
  const homesRaw = takeFlag(args, "--homes");
  const signedOff = requireNonEmptySingleLineFlagValue(
    "--signed-off",
    takeFlag(args, "--signed-off"),
  );
  const json = takeBoolFlag(args, "--json");
  const positionals = requirePositionals(args, 1, 1, EPIC_SUBCOMMANDS.new);
  const slug = validateEpicSlug(positionals[0]);

  if (title === undefined) {
    throw new AxiError("--title is required", "VALIDATION_ERROR");
  }
  if (reposRaw === undefined) {
    throw new AxiError("--repos is required", "VALIDATION_ERROR");
  }
  const repos = parseCsv("--repos", reposRaw)!;
  const homes = parseCsv("--homes", homesRaw) ?? [];
  if (signedOff !== undefined && !DATE_RE.test(signedOff)) {
    throw new AxiError(
      "--signed-off must be YYYY-MM-DD",
      "VALIDATION_ERROR",
    );
  }

  // Idempotency: if the epic already resolves, this is a no-op success. Callers
  // rely on `epic new` being safe to re-run.
  try {
    const existingDir = resolveEpicDir(slug, { backlogPath: config.path });
    return renderEpicNewResult(json, slug, existingDir, true);
  } catch {
    // Not found — proceed to create.
  }

  const opts: EpicNewOptions = {
    slug,
    title,
    repos,
    homes,
    today: today(),
    ...(signedOff ? { signedOff } : {}),
  };
  const dir = writeEpicMd(config.path, opts);
  return renderEpicNewResult(json, slug, dir, false);
}

function writeEpicMd(backlogPath: string, opts: EpicNewOptions): string {
  const root = dataRoot({ backlogPath });
  const epicDir = join(root, "plans", `${opts.today}-epic-${opts.slug}`);
  const epicMd = join(epicDir, "epic.md");
  mkdirSync(dirname(epicMd), { recursive: true });
  const lines = [
    "---",
    `epic: ${opts.slug}`,
    `title: ${opts.title}`,
    `repos: ${JSON.stringify(opts.repos)}`,
    `homes: ${JSON.stringify(opts.homes)}`,
    opts.signedOff ? `signed_off: ${opts.signedOff}` : "signed_off: null",
    "---",
    "",
    `# ${opts.title}`,
    "",
  ];
  writeFileSync(epicMd, lines.join("\n"), "utf-8");
  return epicDir;
}

function renderEpicNewResult(
  json: boolean,
  slug: string,
  dir: string,
  already: boolean,
): string {
  if (json) {
    return renderJson({
      ok: true,
      action: "epic-new",
      ...(already ? { already: true } : {}),
      slug,
      dir,
    });
  }
  const confirm = already
    ? `ok: epic new ${slug} already -> ${dir}`
    : `ok: epic new ${slug} -> ${dir}`;
  return renderOutput([confirm]);
}

// ---------------------------------------------------------------------------
// epic list / show
// ---------------------------------------------------------------------------

interface EpicRollup {
  slug: string;
  dir: string;
  signed_off: string | null;
  total: number;
  in_flight: number;
  queued: number;
  done: number;
  status: "draft" | "active" | "complete";
}

function readSignedOff(epicMd: string): string | null {
  try {
    const src = readFileSync(epicMd, "utf-8");
    const m = src.match(/^signed_off:\s*(\S+)\s*$/m);
    if (!m) return null;
    if (m[1] === "null") return null;
    return m[1];
  } catch {
    return null;
  }
}

function computeRollup(
  slug: string,
  dir: string,
  tasks: Task[],
): EpicRollup {
  const own = tasks.filter((t) => epicOfTask(t) === slug);
  const counts: Record<State, number> = { in_flight: 0, queued: 0, done: 0 };
  for (const t of own) counts[t.state]++;
  const signed = readSignedOff(join(dir, "epic.md"));
  const total = own.length;
  const openCount = counts.in_flight + counts.queued;
  const status: EpicRollup["status"] =
    signed === null
      ? "draft"
      : total > 0 && openCount === 0
        ? "complete"
        : "active";
  return {
    slug,
    dir,
    signed_off: signed,
    total,
    in_flight: counts.in_flight,
    queued: counts.queued,
    done: counts.done,
    status,
  };
}

async function epicList(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store, config } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  requirePositionals(args, 0, 0, EPIC_SUBCOMMANDS.list);

  const tasks = (await store.list({})).items;
  const epics = listEpics({ backlogPath: config.path });
  const rollups = epics.map((e) => computeRollup(e.slug, e.dir, tasks));

  if (json) {
    return renderJson({ ok: true, action: "epic-list", epics: rollups });
  }
  if (rollups.length === 0) {
    return renderOutput([renderScalar("epics", "0 epics")]);
  }
  const schema = [
    field("slug"),
    field("status"),
    field("total"),
    field("in_flight"),
    field("queued"),
    field("done"),
  ];
  const rows = rollups.map((r) => ({
    slug: r.slug,
    status: r.status,
    total: r.total,
    in_flight: r.in_flight,
    queued: r.queued,
    done: r.done,
  }));
  return renderOutput([renderList("epics", rows, schema)]);
}

async function epicShow(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store, config } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const positionals = requirePositionals(args, 1, 1, EPIC_SUBCOMMANDS.show);
  const slug = validateEpicSlug(positionals[0]);

  // Resolve — throws EPIC_NOT_FOUND with a helpful hint when absent.
  const dir = resolveEpicDir(slug, { backlogPath: config.path });
  const tasks = (await store.list({})).items;
  const rollup = computeRollup(slug, dir, tasks);
  const own = tasks.filter((t) => epicOfTask(t) === slug);

  if (json) {
    return renderJson({
      ok: true,
      action: "epic-show",
      epic: rollup,
      tasks: own.map((t) => ({ id: t.id, state: t.state, title: t.title })),
    });
  }
  const blocks: string[] = [
    renderScalar("slug", rollup.slug),
    renderScalar("status", rollup.status),
    renderScalar("dir", rollup.dir),
    renderScalar(
      "counts",
      `total ${rollup.total}, in_flight ${rollup.in_flight}, queued ${rollup.queued}, done ${rollup.done}`,
    ),
  ];
  if (own.length > 0) {
    const rows = own.map((t) => ({
      id: t.id,
      state: t.state,
      title: t.title,
    }));
    blocks.push(
      renderList(
        "tasks",
        rows,
        [field("id"), field("state"), field("title")],
      ),
    );
  }
  return renderOutput(blocks);
}
