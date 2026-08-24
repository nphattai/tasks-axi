import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { requirePositionals, takeBoolFlag } from "../args.js";
import { renderJson } from "../confirm.js";
import { requireCtx, type TasksContext } from "../context.js";
import {
  dataRoot,
  epicOfTask,
  listEpics,
  reportPath,
  resolveEpicDir,
} from "../epic-paths.js";
import { field, renderList, renderOutput } from "../toon.js";

export const MIGRATE_HELP = `usage: tasks-axi migrate [--dry-run] [--json]
Three idempotent transforms to bring a home onto the fmops-native shape:
  1. strip-status   — remove \`status:\` from every data/plans/*/stories/*.md
                       (task state is the single status source; the field is dead-weight drift).
  2. relocate-report — move data/<id>/report.md → data/plans/<epic>/reports/<id>-report.md
                       (replaces a legacy symlink; refuses on a real-file collision).
  3. backfill-membership — attach a live orphan task to its inferable epic, or "ops"
                       (never touches Done tasks; their state is frozen).

--dry-run prints the plan (counts + samples), writes NOTHING. Run this ALWAYS first,
review the diff, back up the data dir (git commit + tar), then apply.`;

interface MigrateSample {
  transform: "strip-status" | "relocate-report" | "backfill-membership";
  target: string;
  detail: string;
}

interface MigrateReport {
  strip_status: MigrateSample[];
  relocate_report: MigrateSample[];
  backfill_membership: MigrateSample[];
  collisions: MigrateSample[];
}

function emptyReport(): MigrateReport {
  return {
    strip_status: [],
    relocate_report: [],
    backfill_membership: [],
    collisions: [],
  };
}

export async function migrateCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store, config } = requireCtx(context);
  const args = [...rawArgs];
  const dryRun = takeBoolFlag(args, "--dry-run");
  const json = takeBoolFlag(args, "--json");
  requirePositionals(args, 0, 0, MIGRATE_HELP.split("\n")[0]);

  const root = dataRoot({ backlogPath: config.path });
  const tasks = (await store.list({})).items;
  const report = emptyReport();

  // Transform #1: strip story `status:` lines.
  for (const epic of listEpics({ dataRoot: root })) {
    const storiesDir = join(epic.dir, "stories");
    if (!existsSync(storiesDir)) continue;
    for (const name of safeReaddir(storiesDir)) {
      if (!name.endsWith(".md")) continue;
      const path = join(storiesDir, name);
      const src = readFileSync(path, "utf-8");
      const stripped = stripStatus(src);
      if (stripped === src) continue;
      report.strip_status.push({
        transform: "strip-status",
        target: path,
        detail: `remove status: line`,
      });
      if (!dryRun) writeFileSync(path, stripped, "utf-8");
    }
  }

  // Transform #2: relocate reports.
  const legacyReportsDir = safeReaddir(root);
  for (const name of legacyReportsDir) {
    // The layout is data/<id>/report.md — skip data/plans and any other dir.
    if (name === "plans") continue;
    const dir = join(root, name);
    const src = join(dir, "report.md");
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entryStat;
    try {
      entryStat = lstatSync(src);
    } catch {
      continue;
    }
    // We need to figure out which epic the id belongs to. Try to find the task.
    const task = tasks.find((t) => t.id === name);
    const slug = task ? epicOfTask(task) : null;
    if (slug === null) {
      report.collisions.push({
        transform: "relocate-report",
        target: src,
        detail: `no derivable epic for id "${name}"; leaving in place for backfill`,
      });
      continue;
    }
    let epicDir: string;
    try {
      epicDir = resolveEpicDir(slug, { dataRoot: root });
    } catch {
      report.collisions.push({
        transform: "relocate-report",
        target: src,
        detail: `epic "${slug}" does not resolve; leaving in place`,
      });
      continue;
    }
    const dest = reportPath(epicDir, name);
    if (existsSync(dest)) {
      // Refuse on a real-file collision (review F5). A symlink at dest is safe
      // to replace with the real file.
      const destStat = lstatSync(dest);
      if (!destStat.isSymbolicLink()) {
        report.collisions.push({
          transform: "relocate-report",
          target: src,
          detail: `destination file already exists: ${dest}; refusing to overwrite`,
        });
        continue;
      }
      if (!dryRun) unlinkSync(dest);
    }
    report.relocate_report.push({
      transform: "relocate-report",
      target: src,
      detail: `move to ${dest}${entryStat.isSymbolicLink() ? " (replacing legacy symlink)" : ""}`,
    });
    if (dryRun) continue;
    mkdirSync(dirname(dest), { recursive: true });
    if (entryStat.isSymbolicLink()) {
      unlinkSync(src);
      // The prior symlink pointed at the native path; nothing to move.
    } else {
      renameSync(src, dest);
    }
    // Best-effort: drop the emptied legacy dir.
    try {
      const remaining = readdirSync(dir);
      if (remaining.length === 0) rmdirSync(dir);
    } catch {
      // leave the dir alone if we can't be sure it's empty
    }
  }

  // Transform #3: backfill membership on live orphans. All unresolvable live
  // orphans fall back to the standing "ops" catch-all — the per-home migration
  // runbook seeds ops first. Never touches Done tasks; their state is frozen.
  for (const task of tasks) {
    if (task.state === "done") continue;
    if (epicOfTask(task) !== null) continue;
    const target = "ops";
    report.backfill_membership.push({
      transform: "backfill-membership",
      target: task.id,
      detail: `attach to epic "${target}"`,
    });
    if (dryRun) continue;
    // Non-destructive stamp: prepend [<slug>] and add a parent: <slug> edge.
    const patch = {
      title: task.title.match(/^\[[a-z][a-z0-9-]*\]\s/)
        ? task.title
        : `[${target}] ${task.title}`,
    };
    await store.update(task.id, patch);
    // Add the parent edge if not already present.
    if (!task.deps.some((d) => d.type === "parent")) {
      await store.addDep(task.id, { type: "parent", id: target });
    }
  }

  return renderMigrateReport(report, dryRun, json);
}

function stripStatus(src: string): string {
  return src.replace(/^status:\s*.*\n/gm, "");
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function renderMigrateReport(
  report: MigrateReport,
  dryRun: boolean,
  json: boolean,
): string {
  const totals = {
    strip_status: report.strip_status.length,
    relocate_report: report.relocate_report.length,
    backfill_membership: report.backfill_membership.length,
    collisions: report.collisions.length,
  };
  const mode = dryRun ? "dry-run" : "applied";

  if (json) {
    return renderJson({
      ok: totals.collisions === 0,
      action: "migrate",
      mode,
      totals,
      samples: {
        strip_status: report.strip_status,
        relocate_report: report.relocate_report,
        backfill_membership: report.backfill_membership,
        collisions: report.collisions,
      },
    });
  }
  const blocks: string[] = [
    `ok: migrate (${mode}) -> strip:${totals.strip_status} relocate:${totals.relocate_report} backfill:${totals.backfill_membership} collisions:${totals.collisions}`,
  ];
  const rows: MigrateSample[] = [
    ...report.strip_status,
    ...report.relocate_report,
    ...report.backfill_membership,
    ...report.collisions,
  ];
  if (rows.length > 0) {
    blocks.push(
      renderList(
        "samples",
        rows.map((r) => ({
          transform: r.transform,
          target: r.target,
          detail: r.detail,
        })),
        [field("transform"), field("target"), field("detail")],
      ),
    );
  }
  if (totals.collisions > 0) {
    process.exitCode = 1;
  }
  return renderOutput(blocks);
}
