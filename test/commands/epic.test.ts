import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addCommand } from "../../src/commands/crud.js";
import { doneCommand } from "../../src/commands/state.js";
import { EPIC_HELP, epicCommand } from "../../src/commands/epic.js";
import { makeBacklog, seedEpic } from "../helpers.js";

describe("epic command", () => {
  describe("new", () => {
    it("writes an epic.md at the fmops-native path (frontmatter, no status)", async () => {
      const b = makeBacklog();
      try {
        const out = await epicCommand(
          [
            "new",
            "fmops",
            "--title",
            "Fmops",
            "--repos",
            "distro,firstmate",
            "--homes",
            "distro",
          ],
          b.ctx,
        );
        expect(out).toContain("ok: epic new fmops");
        // Find the file that was written.
        const plans = join(b.dir, "plans");
        const dir = existsSync(plans)
          ? readEntries(plans).find((d) => d.includes("-epic-fmops"))
          : undefined;
        expect(dir).toBeDefined();
        const epicMd = join(plans, dir!, "epic.md");
        const src = readFileSync(epicMd, "utf-8");
        expect(src).toContain("epic: fmops");
        expect(src).toContain("title: Fmops");
        expect(src).toContain('repos: ["distro","firstmate"]');
        expect(src).toContain('homes: ["distro"]');
        // status: field must NEVER appear here — epic status is derived.
        expect(src).not.toMatch(/^status:/m);
      } finally {
        b.cleanup();
      }
    });

    it("is idempotent when the epic already resolves", async () => {
      const b = makeBacklog();
      try {
        await epicCommand(
          ["new", "extra", "--title", "Extra", "--repos", "a"],
          b.ctx,
        );
        const out = await epicCommand(
          ["new", "extra", "--title", "Extra", "--repos", "a"],
          b.ctx,
        );
        expect(out).toContain("already");
      } finally {
        b.cleanup();
      }
    });

    it("rejects an invalid slug shape", async () => {
      const b = makeBacklog();
      try {
        await expect(
          epicCommand(["new", "BadSlug", "--title", "t", "--repos", "r"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("requires --title and --repos", async () => {
      const b = makeBacklog();
      try {
        await expect(
          epicCommand(["new", "noflags"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });
  });

  describe("list / show", () => {
    it("list returns a rollup with derived status per epic", async () => {
      const b = makeBacklog();
      try {
        seedEpic(b.dir, "fmops");
        // Seed a task under fmops.
        await addCommand(
          ["fmops-work-q1", "work", "--epic", "fmops"],
          b.ctx,
        );
        const out = await epicCommand(["list", "--json"], b.ctx);
        const parsed = JSON.parse(out) as {
          ok: boolean;
          epics: Array<{
            slug: string;
            status: string;
            total: number;
            queued: number;
          }>;
        };
        expect(parsed.ok).toBe(true);
        const fmops = parsed.epics.find((e) => e.slug === "fmops");
        expect(fmops?.total).toBe(1);
        expect(fmops?.queued).toBe(1);
        // No signed_off yet -> draft.
        expect(fmops?.status).toBe("draft");
      } finally {
        b.cleanup();
      }
    });

    it("show reports 'complete' after all tasks are done AND signed_off is set", async () => {
      const b = makeBacklog();
      try {
        // Create an already-signed epic.
        await epicCommand(
          [
            "new",
            "shipdone",
            "--title",
            "Ship & done",
            "--repos",
            "app",
            "--signed-off",
            "2026-08-24",
          ],
          b.ctx,
        );
        await addCommand(
          ["shipdone-h1", "the ship", "--epic", "shipdone", "--start"],
          b.ctx,
        );
        await doneCommand(["shipdone-h1", "--pr", "https://github.com/o/r/pull/1"], b.ctx);
        const out = await epicCommand(["show", "shipdone", "--json"], b.ctx);
        const parsed = JSON.parse(out) as {
          epic: { status: string; total: number; done: number };
        };
        expect(parsed.epic.total).toBe(1);
        expect(parsed.epic.done).toBe(1);
        expect(parsed.epic.status).toBe("complete");
      } finally {
        b.cleanup();
      }
    });

    it("show throws EPIC_NOT_FOUND on an unknown slug", async () => {
      const b = makeBacklog();
      try {
        await expect(epicCommand(["show", "nope"], b.ctx)).rejects.toMatchObject(
          {
            code: "VALIDATION_ERROR",
          },
        );
      } finally {
        b.cleanup();
      }
    });
  });

  it("exposes usage help text", () => {
    expect(EPIC_HELP).toContain("usage: tasks-axi epic");
  });
});

function readEntries(path: string): string[] {
  return readdirSync(path);
}
