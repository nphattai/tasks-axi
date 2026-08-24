import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addCommand } from "../../src/commands/crud.js";
import { doneCommand } from "../../src/commands/state.js";
import { DOCTOR_HELP, doctorCommand } from "../../src/commands/doctor.js";
import { makeBacklog, seedEpic } from "../helpers.js";

describe("doctor command", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("reports 0 findings on a clean fmops-shaped backlog", async () => {
    // Use an empty backlog so the default FIXTURE's legacy (non-fmops) tasks
    // don't show up as orphans — this test asserts the clean-state contract,
    // not migration of a legacy corpus.
    const b = makeBacklog("# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n");
    try {
      seedEpic(b.dir, "fmops");
      await addCommand(
        ["clean-q1", "clean task", "--epic", "fmops"],
        b.ctx,
      );
      const out = await doctorCommand(["--json"], b.ctx);
      const parsed = JSON.parse(out) as {
        ok: boolean;
        findings: unknown[];
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.findings).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    } finally {
      b.cleanup();
    }
  });

  it("reports an orphan (planted directly in backlog.md, bypassing enforce)", async () => {
    // A live task with no `[<slug>]` prefix and no `parent:` edge — the exact
    // shape that made the reactive lint necessary before enforce-on-write.
    const src = [
      "# Backlog",
      "",
      "## In flight",
      "",
      "## Queued",
      "- [ ] orphan-q1 - naked title with no epic anywhere",
      "",
      "## Done",
      "",
    ].join("\n");
    const b = makeBacklog(src);
    try {
      const out = await doctorCommand(["--json"], b.ctx);
      const parsed = JSON.parse(out) as {
        ok: boolean;
        findings: Array<{ category: string; target: string }>;
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.findings).toContainEqual({
        category: "orphan",
        target: "orphan-q1",
        detail: expect.any(String),
      });
      expect(process.exitCode).toBe(1);
    } finally {
      b.cleanup();
      process.exitCode = undefined;
    }
  });

  it("reports a missing native report for a Done task", async () => {
    const b = makeBacklog();
    try {
      seedEpic(b.dir, "fmops");
      await addCommand(
        ["repless-q1", "no report", "--epic", "fmops", "--start"],
        b.ctx,
      );
      await doneCommand(["repless-q1"], b.ctx);
      const out = await doctorCommand(["--json"], b.ctx);
      const parsed = JSON.parse(out) as {
        ok: boolean;
        findings: Array<{ category: string; target: string }>;
      };
      expect(parsed.ok).toBe(false);
      expect(
        parsed.findings.some(
          (f) => f.category === "missing-report" && f.target === "repless-q1",
        ),
      ).toBe(true);
    } finally {
      b.cleanup();
      process.exitCode = undefined;
    }
  });

  it("reports a dangling story epic: FK", async () => {
    const b = makeBacklog();
    try {
      // Seed the "ops" epic (default seeded by makeBacklog) and place a story
      // there whose frontmatter names an epic that does not resolve.
      const opsDir = join(b.dir, "plans", "260824-epic-ops");
      const storiesDir = join(opsDir, "stories");
      mkdirSync(storiesDir, { recursive: true });
      writeFileSync(
        join(storiesDir, "wrong-epic-story.md"),
        [
          "---",
          "id: wrong-epic-story",
          "epic: not-real",
          "---",
          "",
          "# story",
          "",
        ].join("\n"),
        "utf-8",
      );
      const out = await doctorCommand(["--json"], b.ctx);
      const parsed = JSON.parse(out) as {
        ok: boolean;
        findings: Array<{ category: string; detail: string }>;
      };
      expect(parsed.ok).toBe(false);
      expect(
        parsed.findings.some((f) => f.category === "dangling"),
      ).toBe(true);
    } finally {
      b.cleanup();
      process.exitCode = undefined;
    }
  });

  it("exposes usage help text", () => {
    expect(DOCTOR_HELP).toContain("usage: tasks-axi doctor");
  });
});
