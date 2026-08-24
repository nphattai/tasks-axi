import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  requireNonEmptySingleLineFlagValue,
  requirePositionals,
  takeBoolFlag,
  takeFlag,
} from "../args.js";
import { renderJson } from "../confirm.js";
import { requireCtx, type TasksContext } from "../context.js";
import { resolveEpicDir, validateEpicSlug } from "../epic-paths.js";
import { AxiError } from "../errors.js";
import { validateId } from "../id.js";
import { field, renderList, renderOutput, renderScalar } from "../toon.js";

export const STORY_HELP = `usage: tasks-axi story <command> [args] [flags]
commands:
  new <id> --epic <slug> --repo <r> --pr-base <b> [--kind ship|scout] [--gate]
           [--depends <a,b>] [--delivery <mode>] [--json]
    Write plans/<epic-dir>/stories/<id>.md frontmatter. NO status: field —
    task state is the single status source (fmops architecture §4).
  list --epic <slug> [--json]
    List every story under an epic.

The story spec is authored (spec + contract). Task state (queued/in_flight/done)
lives in backlog.md and is the SSOT for progress; nothing here writes status:.`;

const STORY_SUBCOMMANDS: Record<string, string> = {
  new: "usage: tasks-axi story new <id> --epic <slug> --repo <r> --pr-base <b> [--kind ship|scout] [--gate] [--depends <a,b>] [--delivery <mode>] [--json]",
  list: "usage: tasks-axi story list --epic <slug> [--json]",
};

const STORY_KIND_RE = /^(ship|scout|docs|persistent-secondmate)$/;

export async function storyCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const [subcommand, ...args] = rawArgs;
  switch (subcommand) {
    case "new":
      return storyNew(args, context);
    case "list":
      return storyList(args, context);
    default:
      throw new AxiError(
        subcommand
          ? `Unknown story command: ${subcommand}`
          : "Missing story command",
        "VALIDATION_ERROR",
        [STORY_HELP.split("\n")[0]],
      );
  }
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

async function storyNew(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { config } = requireCtx(context);
  const args = [...rawArgs];

  const epicFlag = requireNonEmptySingleLineFlagValue(
    "--epic",
    takeFlag(args, "--epic"),
  );
  const repo = requireNonEmptySingleLineFlagValue(
    "--repo",
    takeFlag(args, "--repo"),
  );
  const prBase = requireNonEmptySingleLineFlagValue(
    "--pr-base",
    takeFlag(args, "--pr-base"),
  );
  const kindRaw = takeFlag(args, "--kind");
  const dependsRaw = takeFlag(args, "--depends");
  const delivery = requireNonEmptySingleLineFlagValue(
    "--delivery",
    takeFlag(args, "--delivery"),
  );
  const gate = takeBoolFlag(args, "--gate");
  const json = takeBoolFlag(args, "--json");
  const positionals = requirePositionals(args, 1, 1, STORY_SUBCOMMANDS.new);
  const id = validateId(positionals[0]);

  if (epicFlag === undefined) {
    throw new AxiError("--epic is required", "VALIDATION_ERROR");
  }
  if (repo === undefined) {
    throw new AxiError("--repo is required", "VALIDATION_ERROR");
  }
  if (prBase === undefined) {
    throw new AxiError("--pr-base is required", "VALIDATION_ERROR");
  }
  const kind = kindRaw === undefined ? "ship" : validateStoryKind(kindRaw);
  const depends = parseCsv("--depends", dependsRaw) ?? [];
  const slug = validateEpicSlug(epicFlag);
  const epicDir = resolveEpicDir(slug, { backlogPath: config.path });

  const storiesDir = join(epicDir, "stories");
  mkdirSync(storiesDir, { recursive: true });
  const storyMd = join(storiesDir, `${id}.md`);
  const already = existsSync(storyMd);
  if (!already) {
    writeFileSync(storyMd, renderStoryFrontmatter(id, slug, {
      repo,
      prBase,
      kind,
      gate,
      depends,
      ...(delivery ? { delivery } : {}),
    }), "utf-8");
  }

  if (json) {
    return renderJson({
      ok: true,
      action: "story-new",
      ...(already ? { already: true } : {}),
      id,
      epic: slug,
      path: storyMd,
    });
  }
  const confirm = already
    ? `ok: story new ${id} already -> ${storyMd}`
    : `ok: story new ${id} -> ${storyMd}`;
  return renderOutput([confirm]);
}

function validateStoryKind(raw: string): string {
  if (!STORY_KIND_RE.test(raw)) {
    throw new AxiError(
      "--kind must be one of ship, scout, docs, persistent-secondmate",
      "VALIDATION_ERROR",
    );
  }
  return raw;
}

function renderStoryFrontmatter(
  id: string,
  epic: string,
  opts: {
    repo: string;
    prBase: string;
    kind: string;
    gate: boolean;
    depends: string[];
    delivery?: string;
  },
): string {
  // Deliberate omission: NO `status:` field. Task state (queued/in_flight/done)
  // lives in backlog.md; the story spec is authored contract, not state.
  const lines = [
    "---",
    `id: ${id}`,
    `epic: ${epic}`,
    `repo: ${opts.repo}`,
    `pr_base: ${opts.prBase}`,
    `depends: ${JSON.stringify(opts.depends)}`,
    `kind: ${opts.kind}`,
    `gate: ${opts.gate}`,
  ];
  if (opts.delivery) lines.push(`delivery: ${opts.delivery}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Story ${id}`);
  lines.push("");
  return lines.join("\n");
}

interface StoryEntry {
  id: string;
  path: string;
  kind: string | null;
  repo: string | null;
  pr_base: string | null;
  gate: string | null;
}

function readStoryFrontmatter(path: string): StoryEntry {
  const id = path.split("/").pop()!.replace(/\.md$/, "");
  let src: string;
  try {
    src = readFileSync(path, "utf-8");
  } catch {
    return {
      id,
      path,
      kind: null,
      repo: null,
      pr_base: null,
      gate: null,
    };
  }
  const grab = (key: string): string | null => {
    const m = src.match(new RegExp(`^${key}:\\s*(\\S.*?)\\s*$`, "m"));
    return m ? m[1] : null;
  };
  return {
    id,
    path,
    kind: grab("kind"),
    repo: grab("repo"),
    pr_base: grab("pr_base"),
    gate: grab("gate"),
  };
}

async function storyList(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { config } = requireCtx(context);
  const args = [...rawArgs];
  const epicFlag = requireNonEmptySingleLineFlagValue(
    "--epic",
    takeFlag(args, "--epic"),
  );
  const json = takeBoolFlag(args, "--json");
  requirePositionals(args, 0, 0, STORY_SUBCOMMANDS.list);

  if (epicFlag === undefined) {
    throw new AxiError("--epic is required", "VALIDATION_ERROR");
  }
  const slug = validateEpicSlug(epicFlag);
  const epicDir = resolveEpicDir(slug, { backlogPath: config.path });
  const storiesDir = join(epicDir, "stories");
  const entries: StoryEntry[] = [];
  try {
    for (const name of readdirSync(storiesDir)) {
      if (!name.endsWith(".md")) continue;
      entries.push(readStoryFrontmatter(join(storiesDir, name)));
    }
  } catch {
    // No stories dir yet — return an empty list.
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));

  if (json) {
    return renderJson({
      ok: true,
      action: "story-list",
      epic: slug,
      stories: entries,
    });
  }
  if (entries.length === 0) {
    return renderOutput([renderScalar("stories", `0 stories under ${slug}`)]);
  }
  const schema = [
    field("id"),
    field("kind"),
    field("repo"),
    field("pr_base"),
    field("gate"),
  ];
  const rows: Record<string, unknown>[] = entries.map((e) => ({
    id: e.id,
    kind: e.kind,
    repo: e.repo,
    pr_base: e.pr_base,
    gate: e.gate,
  }));
  return renderOutput([renderList("stories", rows, schema)]);
}
