import {
  requirePositionals,
  requireId,
  takeBoolFlag,
} from "../args.js";
import { renderJson } from "../confirm.js";
import { requireCtx, type TasksContext } from "../context.js";
import {
  epicOfTask,
  reportPath,
  resolveEpicDir,
} from "../epic-paths.js";
import { AxiError, notFound } from "../errors.js";
import { renderOutput } from "../toon.js";

export const REPORT_HELP = `usage: tasks-axi report <command> [args] [flags]
commands:
  path <id> [--json]
    Print the fmops-native report path for a task:
    data/plans/<epic>/reports/<id>-report.md
    Resolved from the task's parent: <epic> edge or [<epic>] title tag.
    Under enforce-on-write, a task always has a resolvable epic.

The engine owns only the location. The report file itself is authored by the
worker and lives on disk at the returned path.`;

const REPORT_SUBCOMMANDS: Record<string, string> = {
  path: "usage: tasks-axi report path <id> [--json]",
};

export async function reportCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const [subcommand, ...args] = rawArgs;
  switch (subcommand) {
    case "path":
      return reportPathCmd(args, context);
    default:
      throw new AxiError(
        subcommand
          ? `Unknown report command: ${subcommand}`
          : "Missing report command",
        "VALIDATION_ERROR",
        [REPORT_HELP.split("\n")[0]],
      );
  }
}

async function reportPathCmd(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store, config } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  const positionals = requirePositionals(args, 1, 1, REPORT_SUBCOMMANDS.path);
  const id = requireId(positionals[0], "id");

  const task = await store.get(id);
  if (!task) throw notFound(id);

  const slug = epicOfTask(task);
  if (slug === null) {
    throw new AxiError(
      `Task "${id}" has no derivable epic`,
      "VALIDATION_ERROR",
      [
        `Attach it via \`tasks-axi update ${id}\` and a manual edit, or migrate the backlog with \`tasks-axi migrate\``,
      ],
    );
  }
  // Throws EPIC_NOT_FOUND when the task's declared epic dir is absent from disk
  // (dangling FK). doctor is the read-only net that names both cases; this
  // command surfaces the disk failure directly so scripts fail loudly.
  const epicDir = resolveEpicDir(slug, { backlogPath: config.path });
  const path = reportPath(epicDir, id);

  if (json) {
    return renderJson({
      ok: true,
      action: "report-path",
      id,
      epic: slug,
      path,
    });
  }
  // Report path is a machine-readable scalar; emit it as a plain line so a
  // caller (fm-brief.sh writes the brief target from this) can shell it.
  return renderOutput([`ok: report path ${id} -> ${path}`, `path: ${path}`]);
}
