import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownStore } from "../src/backends/markdown.js";
import type { TasksContext } from "../src/context.js";

export const FIXTURE = readFileSync(
  new URL("./fixtures/backlog.md", import.meta.url),
  "utf8",
);

/**
 * A backlog whose lines mirror firstmate's real `data/backlog.md` shape: a
 * `- [ ]` checkbox in-flight item, a `- [ ]` queued item carrying a
 * `blocked-by: <id> - <reason>` edge, and a `- [x]` done item.
 */
export const FIRSTMATE_FIXTURE = readFileSync(
  new URL("./fixtures/firstmate-backlog.md", import.meta.url),
  "utf8",
);

export const MULTI_REASON_FIXTURE = [
  "# Backlog",
  "",
  "## In flight",
  "- [ ] blocker-b - second blocker",
  "",
  "## Queued",
  "- [ ] target-q1 - work (repo: app) blocked-by: blocker-a - first blocker done blocked-by: blocker-b - waits on second blocker",
  "",
  "## Done",
  "- [x] blocker-a - first blocker done",
  "",
].join("\n");

export interface TempBacklog {
  dir: string;
  path: string;
  store: MarkdownStore;
  ctx: TasksContext;
  read(): string;
  archive(): string;
  noteArchive(): string;
  cleanup(): void;
}

/**
 * Default epic slug the test backlog is seeded under. Tests that exercise the
 * `add --epic` enforce-on-write path can pass this without seeding their own
 * epic dir; every `makeBacklog()` call seeds this epic at
 * `<dir>/plans/260824-epic-<slug>/epic.md` automatically.
 */
export const DEFAULT_TEST_EPIC = "ops";

/**
 * Seed an epic frontmatter file at the fmops-native location under a data
 * root. Used by `makeBacklog` and by any test that wants a second epic.
 */
export function seedEpic(dataRoot: string, slug: string): string {
  const epicDir = join(dataRoot, "plans", `260824-epic-${slug}`);
  mkdirSync(epicDir, { recursive: true });
  writeFileSync(
    join(epicDir, "epic.md"),
    ["---", `epic: ${slug}`, "title: Test epic", "---", "", "body"].join("\n"),
    "utf-8",
  );
  return epicDir;
}

/** Create a temp backlog file + a real markdown-backed context with a fixed clock. */
export function makeBacklog(
  content = FIXTURE,
  now = "2026-07-01",
): TempBacklog {
  const dir = mkdtempSync(join(tmpdir(), "tasks-axi-"));
  const path = join(dir, "backlog.md");
  writeFileSync(path, content, "utf8");
  // The engine's enforce-on-write path (`add --epic <slug>`) resolves the
  // slug against `<dataRoot>/plans/*-epic-<slug>/epic.md`, where dataRoot ==
  // dirname(backlog.path). Seeding a default epic here lets every add test
  // pass `--epic ops` without re-seeding per case.
  seedEpic(dir, DEFAULT_TEST_EPIC);
  const store = new MarkdownStore({ path, now: () => now });
  const ctx: TasksContext = {
    store,
    config: { backend: "markdown", path, doneKeep: 10 },
  };
  return {
    dir,
    path,
    store,
    ctx,
    read: () => readFileSync(path, "utf8"),
    archive: () => {
      try {
        return readFileSync(join(dir, "done-archive.md"), "utf8");
      } catch {
        return "";
      }
    },
    noteArchive: () => {
      try {
        return readFileSync(join(dir, "note-archive.md"), "utf8");
      } catch {
        return "";
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
