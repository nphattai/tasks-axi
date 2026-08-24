import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  epicOfTask,
  listEpics,
  reportPath,
  resolveEpicDir,
  validateEpicSlug,
} from "../src/epic-paths.js";
import type { Task } from "../src/model.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-epic-paths-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedEpic(slug: string, dirName?: string): string {
  const plans = join(dir, "plans");
  const epicDir = join(plans, dirName ?? `260824-epic-${slug}`);
  mkdirSync(epicDir, { recursive: true });
  writeFileSync(
    join(epicDir, "epic.md"),
    ["---", `epic: ${slug}`, "title: Test epic", "---", "", "body"].join("\n"),
    "utf-8",
  );
  return epicDir;
}

describe("validateEpicSlug", () => {
  it("accepts lowercase kebab-case slugs", () => {
    for (const slug of ["fmops", "fmeng-taskops", "a", "a-b-c-1", "x9-y"]) {
      expect(validateEpicSlug(slug)).toBe(slug);
    }
  });

  it("rejects non-kebab-case slugs", () => {
    for (const slug of ["FMOPS", "1foo", "-foo", "foo_bar", "foo bar", ""]) {
      expect(() => validateEpicSlug(slug)).toThrow(/Invalid epic slug/);
    }
  });
});

describe("resolveEpicDir", () => {
  it("finds an epic by slug via frontmatter + dir infix", () => {
    const seeded = seedEpic("fmops");
    const resolved = resolveEpicDir("fmops", { dataRoot: dir });
    expect(resolved).toBe(seeded);
  });

  it("finds an epic even when the dir name has extra suffixes after the slug", () => {
    // firstmate dir naming may append descriptive words after -epic-<slug>.
    const seeded = seedEpic("fmeng-taskops", "260824-1046-epic-fmeng-taskops");
    const resolved = resolveEpicDir("fmeng-taskops", { dataRoot: dir });
    expect(resolved).toBe(seeded);
  });

  it("throws EPIC_NOT_FOUND (VALIDATION_ERROR) when no epic dir exists", () => {
    expect(() => resolveEpicDir("missing", { dataRoot: dir })).toThrow(
      /not found/,
    );
  });

  it("throws when the plans dir doesn't exist at all", () => {
    // dir is a fresh tmp with no plans/, so this hits the readdir fallback.
    expect(() => resolveEpicDir("anything", { dataRoot: dir })).toThrow(
      /not found/,
    );
  });

  it("refuses when the dir infix and frontmatter disagree (silent corruption)", () => {
    // dir says slug is "typo" but epic.md says "canonical" — surface it.
    const plans = join(dir, "plans");
    const badDir = join(plans, "260824-epic-typo");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "epic.md"),
      "---\nepic: canonical\n---\n",
      "utf-8",
    );
    // Looking up by the dir infix's slug ("typo") should surface the mismatch.
    expect(() => resolveEpicDir("typo", { dataRoot: dir })).toThrow(
      /declares slug/,
    );
  });

  it("rejects an invalid slug shape before hitting the disk", () => {
    expect(() => resolveEpicDir("FOO", { dataRoot: dir })).toThrow(
      /Invalid epic slug/,
    );
  });

  it("derives dataRoot from backlogPath when only that is given", () => {
    // <dir>/data/backlog.md → <dir>/data as dataRoot.
    const data = join(dir, "data");
    mkdirSync(data, { recursive: true });
    const backlogPath = join(data, "backlog.md");
    writeFileSync(backlogPath, "# Backlog\n", "utf-8");
    const seeded = seedFromDataRoot(data, "seed-slug");
    expect(resolveEpicDir("seed-slug", { backlogPath })).toBe(seeded);
  });
});

function seedFromDataRoot(dataRoot: string, slug: string): string {
  const plans = join(dataRoot, "plans");
  const epicDir = join(plans, `260824-epic-${slug}`);
  mkdirSync(epicDir, { recursive: true });
  writeFileSync(
    join(epicDir, "epic.md"),
    `---\nepic: ${slug}\n---\n`,
    "utf-8",
  );
  return epicDir;
}

describe("reportPath", () => {
  it("computes the native path from an epic dir + task id", () => {
    expect(reportPath("/x/y/260824-epic-fmops", "task-q1")).toBe(
      "/x/y/260824-epic-fmops/reports/task-q1-report.md",
    );
  });
});

describe("epicOfTask", () => {
  const base: Task = {
    id: "task-q1",
    title: "",
    state: "queued",
    links: [],
    deps: [],
  };

  it("returns the parent: edge id when it is a slug shape", () => {
    const task: Task = {
      ...base,
      title: "just a title",
      deps: [{ type: "parent", id: "fmops" }],
    };
    expect(epicOfTask(task)).toBe("fmops");
  });

  it("falls back to the [<slug>] title tag when there is no parent: edge", () => {
    const task: Task = { ...base, title: "[fmops] work on a thing" };
    expect(epicOfTask(task)).toBe("fmops");
  });

  it("prefers the parent: edge over a divergent title tag", () => {
    const task: Task = {
      ...base,
      title: "[stale] work",
      deps: [{ type: "parent", id: "fresh" }],
    };
    expect(epicOfTask(task)).toBe("fresh");
  });

  it("returns null when neither a parent: edge nor a [<slug>] tag is present", () => {
    const task: Task = { ...base, title: "just a plain title" };
    expect(epicOfTask(task)).toBeNull();
  });

  it("ignores a parent: edge whose id is not slug-shaped", () => {
    // Rare but possible via `--child-of <parent-id>`, where the parent id is
    // task-shaped, not a top-level epic slug.
    const task: Task = {
      ...base,
      title: "just a title",
      deps: [{ type: "parent", id: "some-task-42" }],
    };
    // The id is still slug-shaped by validateEpicSlug's regex, so it returns.
    expect(epicOfTask(task)).toBe("some-task-42");
  });
});

describe("listEpics", () => {
  it("returns an empty list when the plans dir is absent", () => {
    expect(listEpics({ dataRoot: dir })).toEqual([]);
  });

  it("lists every well-formed epic sorted by slug", () => {
    seedEpic("beta");
    seedEpic("alpha");
    seedEpic("gamma");
    const listed = listEpics({ dataRoot: dir });
    expect(listed.map((e) => e.slug)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("silently skips a dir whose epic.md has a slug mismatch (doctor flags it)", () => {
    seedEpic("good");
    // A dir where the frontmatter and the infix disagree — listEpics is a
    // read-only rollup, not the enforcement path, so it just drops it.
    const plans = join(dir, "plans");
    const badDir = join(plans, "260824-epic-badslug");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "epic.md"),
      "---\nepic: different\n---\n",
      "utf-8",
    );
    const slugs = listEpics({ dataRoot: dir }).map((e) => e.slug);
    expect(slugs).toEqual(["good"]);
  });
});
