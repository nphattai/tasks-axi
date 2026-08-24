import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requirePositionals, takeBoolFlag } from "../args.js";
import { renderJson } from "../confirm.js";
import { requireCtx, type TasksContext } from "../context.js";
import {
  epicOfTask,
  listEpics,
  reportPath,
  resolveEpicDir,
} from "../epic-paths.js";
import { field, renderList, renderOutput, renderScalar } from "../toon.js";

export const DOCTOR_HELP = `usage: tasks-axi doctor [--json]
Read-only integrity net. Reports (does NOT repair) three drift classes:
  1. orphan     — a live task with no derivable epic membership (parent: / [<slug>]).
  2. dangling   — a story frontmatter epic: <slug> that does not resolve to a real epic dir.
  3. missing-report — a Done task whose native report file is absent on disk.

Exit code:
  0   no findings.
  1   at least one finding (script-friendly gate).

Enforcement lives on \`add\` (--epic required). doctor is the net that catches
pre-existing drift; new writes cannot introduce these classes.`;

interface Finding {
  category: "orphan" | "dangling" | "missing-report";
  target: string;
  detail: string;
}

export async function doctorCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store, config } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  requirePositionals(args, 0, 0, DOCTOR_HELP.split("\n")[0]);

  const tasks = (await store.list({})).items;
  const findings: Finding[] = [];

  // 1. Orphans: live tasks with no derivable epic.
  for (const task of tasks) {
    if (task.state === "done") continue; // frozen; migrate handles legacy done tasks.
    if (epicOfTask(task) === null) {
      findings.push({
        category: "orphan",
        target: task.id,
        detail: "no parent: <slug> edge and no [<slug>] title tag",
      });
    }
  }

  // 2. Dangling story epic: FKs and 3. missing reports: iterate epics on disk.
  const epics = listEpics({ backlogPath: config.path });
  const knownSlugs = new Set(epics.map((e) => e.slug));
  for (const epic of epics) {
    const storiesDir = join(epic.dir, "stories");
    if (!existsSync(storiesDir)) continue;
    for (const name of safeReaddir(storiesDir)) {
      if (!name.endsWith(".md")) continue;
      const declared = readStoryEpic(join(storiesDir, name));
      if (declared && declared !== epic.slug) {
        // The story's frontmatter names a slug different from its parent dir.
        if (!knownSlugs.has(declared)) {
          findings.push({
            category: "dangling",
            target: join(epic.dir, "stories", name),
            detail: `story epic: "${declared}" does not resolve to an existing epic dir`,
          });
        }
      }
    }
  }

  // 3. Missing native reports for Done tasks.
  for (const task of tasks) {
    if (task.state !== "done") continue;
    const slug = epicOfTask(task);
    if (slug === null) continue;
    let epicDir: string;
    try {
      epicDir = resolveEpicDir(slug, { backlogPath: config.path });
    } catch {
      continue; // Reported as orphan-like (dangling) via the epic list scan.
    }
    const path = reportPath(epicDir, task.id);
    if (!existsSync(path)) {
      findings.push({
        category: "missing-report",
        target: task.id,
        detail: `expected report at ${path}`,
      });
    }
  }

  const ok = findings.length === 0;
  if (!ok) process.exitCode = 1;

  if (json) {
    return renderJson({
      ok,
      action: "doctor",
      findings,
    });
  }
  const blocks: string[] = [
    renderScalar(
      "doctor",
      ok
        ? "0 findings"
        : `${findings.length} finding${findings.length === 1 ? "" : "s"}`,
    ),
  ];
  if (!ok) {
    const rows = findings.map((f) => ({
      category: f.category,
      target: f.target,
      detail: f.detail,
    }));
    blocks.push(
      renderList(
        "findings",
        rows,
        [field("category"), field("target"), field("detail")],
      ),
    );
  }
  return renderOutput(blocks);
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function readStoryEpic(path: string): string | undefined {
  try {
    const src = readFileSync(path, "utf-8");
    const m = src.match(/^epic:\s*(\S+)\s*$/m);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}
