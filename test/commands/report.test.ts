import { describe, expect, it } from "vitest";
import { addCommand } from "../../src/commands/crud.js";
import { REPORT_HELP, reportCommand } from "../../src/commands/report.js";
import { makeBacklog, seedEpic } from "../helpers.js";

describe("report command", () => {
  it("computes the fmops-native path from a task's epic membership", async () => {
    const b = makeBacklog();
    try {
      const epicDir = seedEpic(b.dir, "fmops");
      await addCommand(
        ["task-r1", "does a thing", "--epic", "fmops"],
        b.ctx,
      );
      const out = await reportCommand(["path", "task-r1"], b.ctx);
      // Native shape: <epicDir>/reports/<id>-report.md
      const expected = `${epicDir}/reports/task-r1-report.md`;
      expect(out).toContain(`ok: report path task-r1 -> ${expected}`);
      expect(out).toContain(`path: ${expected}`);
    } finally {
      b.cleanup();
    }
  });

  it("emits a machine-readable payload under --json", async () => {
    const b = makeBacklog();
    try {
      const epicDir = seedEpic(b.dir, "fmops");
      await addCommand(
        ["task-r2", "does a thing", "--epic", "fmops"],
        b.ctx,
      );
      const out = await reportCommand(["path", "task-r2", "--json"], b.ctx);
      const parsed = JSON.parse(out) as {
        ok: boolean;
        id: string;
        epic: string;
        path: string;
      };
      expect(parsed).toEqual({
        ok: true,
        action: "report-path",
        id: "task-r2",
        epic: "fmops",
        path: `${epicDir}/reports/task-r2-report.md`,
      });
    } finally {
      b.cleanup();
    }
  });

  it("resolves membership from the parent: edge (not the title tag)", async () => {
    const b = makeBacklog();
    try {
      // With enforce-on-write, every add stamps BOTH [<slug>] and parent:.
      // Removing the title tag should still resolve via parent:.
      const epicDir = seedEpic(b.dir, "fmops");
      await addCommand(
        ["task-r3", "no tag", "--epic", "fmops"],
        b.ctx,
      );
      const out = await reportCommand(["path", "task-r3"], b.ctx);
      expect(out).toContain(`${epicDir}/reports/task-r3-report.md`);
    } finally {
      b.cleanup();
    }
  });

  it("throws NOT_FOUND on an unknown task id", async () => {
    const b = makeBacklog();
    try {
      await expect(
        reportCommand(["path", "nope"], b.ctx),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      b.cleanup();
    }
  });

  it("exposes usage help text", () => {
    expect(REPORT_HELP).toContain("usage: tasks-axi report");
  });
});
