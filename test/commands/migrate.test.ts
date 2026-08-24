import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATE_HELP, migrateCommand } from "../../src/commands/migrate.js";
import { makeBacklog, seedEpic } from "../helpers.js";

describe("migrate command", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  describe("--dry-run", () => {
    it("writes NOTHING and reports the planned transforms", async () => {
      const b = makeBacklog();
      try {
        // Seed a story with a status: field to be stripped.
        const opsDir = join(b.dir, "plans", "260824-epic-ops");
        const storiesDir = join(opsDir, "stories");
        mkdirSync(storiesDir, { recursive: true });
        const storyMd = join(storiesDir, "story-1.md");
        writeFileSync(
          storyMd,
          [
            "---",
            "id: story-1",
            "epic: ops",
            "status: in_progress",
            "---",
            "",
            "# story",
            "",
          ].join("\n"),
          "utf-8",
        );

        const out = await migrateCommand(["--dry-run", "--json"], b.ctx);
        const parsed = JSON.parse(out) as {
          mode: string;
          totals: { strip_status: number };
        };
        expect(parsed.mode).toBe("dry-run");
        expect(parsed.totals.strip_status).toBe(1);
        // The file should NOT have been modified.
        expect(readFileSync(storyMd, "utf-8")).toContain(
          "status: in_progress",
        );
      } finally {
        b.cleanup();
      }
    });
  });

  describe("apply", () => {
    it("strips status: from every story file (idempotent second run)", async () => {
      const b = makeBacklog();
      try {
        const opsDir = join(b.dir, "plans", "260824-epic-ops");
        const storiesDir = join(opsDir, "stories");
        mkdirSync(storiesDir, { recursive: true });
        const paths = ["a.md", "b.md"].map((n) => join(storiesDir, n));
        for (const p of paths) {
          writeFileSync(
            p,
            [
              "---",
              "id: whatever",
              "epic: ops",
              "status: stale",
              "---",
              "",
              "body",
              "",
            ].join("\n"),
            "utf-8",
          );
        }
        await migrateCommand([], b.ctx);
        for (const p of paths) {
          const src = readFileSync(p, "utf-8");
          expect(src).not.toMatch(/^status:/m);
        }
        // Second run: no changes, exit clean.
        const out2 = await migrateCommand(["--json"], b.ctx);
        const parsed2 = JSON.parse(out2) as {
          totals: { strip_status: number; collisions: number };
        };
        expect(parsed2.totals.strip_status).toBe(0);
        expect(parsed2.totals.collisions).toBe(0);
      } finally {
        b.cleanup();
      }
    });

    it("refuses on a real-file report collision (never overwrites)", async () => {
      const b = makeBacklog();
      try {
        // Seed a native path already existing as a real file, AND a legacy
        // path also as a real file — the collision case per review §F5.
        const opsDir = seedEpic(b.dir, "ops");
        const nativeDir = join(opsDir, "reports");
        mkdirSync(nativeDir, { recursive: true });
        writeFileSync(
          join(nativeDir, "colliding-h1-report.md"),
          "native content",
          "utf-8",
        );
        const legacyDir = join(b.dir, "colliding-h1");
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(
          join(legacyDir, "report.md"),
          "legacy content",
          "utf-8",
        );
        // Seed a live task at that id under ops.
        const src = [
          "# Backlog",
          "",
          "## In flight",
          "",
          "## Queued",
          "- [ ] colliding-h1 - [ops] work parent: ops",
          "",
          "## Done",
          "",
        ].join("\n");
        writeFileSync(b.path, src, "utf-8");

        const out = await migrateCommand(["--json"], b.ctx);
        const parsed = JSON.parse(out) as {
          ok: boolean;
          totals: { collisions: number };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.totals.collisions).toBeGreaterThan(0);
        // The native file was NOT overwritten.
        expect(
          readFileSync(join(nativeDir, "colliding-h1-report.md"), "utf-8"),
        ).toBe("native content");
        // The legacy file was NOT deleted either (refused).
        expect(existsSync(join(legacyDir, "report.md"))).toBe(true);
      } finally {
        b.cleanup();
        process.exitCode = undefined;
      }
    });

    it("relocates a legacy report to the native path when no collision", async () => {
      const b = makeBacklog();
      try {
        const opsDir = seedEpic(b.dir, "ops");
        const legacyDir = join(b.dir, "movable-h1");
        mkdirSync(legacyDir, { recursive: true });
        const legacyReport = join(legacyDir, "report.md");
        writeFileSync(legacyReport, "the deliverable body", "utf-8");
        // Seed a live task under ops with a matching id.
        writeFileSync(
          b.path,
          [
            "# Backlog",
            "",
            "## In flight",
            "",
            "## Queued",
            "- [ ] movable-h1 - [ops] work parent: ops",
            "",
            "## Done",
            "",
          ].join("\n"),
          "utf-8",
        );
        await migrateCommand([], b.ctx);
        const nativePath = join(opsDir, "reports", "movable-h1-report.md");
        expect(existsSync(nativePath)).toBe(true);
        expect(readFileSync(nativePath, "utf-8")).toBe(
          "the deliverable body",
        );
        // The legacy file is gone.
        expect(existsSync(legacyReport)).toBe(false);
      } finally {
        b.cleanup();
      }
    });
  });

  it("exposes usage help text", () => {
    expect(MIGRATE_HELP).toContain("usage: tasks-axi migrate");
  });
});
