import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STORY_HELP, storyCommand } from "../../src/commands/story.js";
import { makeBacklog, seedEpic } from "../helpers.js";

describe("story command", () => {
  describe("new", () => {
    it("writes stories/<id>.md frontmatter WITHOUT status:", async () => {
      const b = makeBacklog();
      try {
        const epicDir = seedEpic(b.dir, "fmops");
        const out = await storyCommand(
          [
            "new",
            "fmops-06-native-engine",
            "--epic",
            "fmops",
            "--repo",
            "tasks-axi",
            "--pr-base",
            "epic/fmops",
            "--kind",
            "ship",
            "--gate",
          ],
          b.ctx,
        );
        expect(out).toContain("ok: story new");
        const storyMd = join(
          epicDir,
          "stories",
          "fmops-06-native-engine.md",
        );
        expect(existsSync(storyMd)).toBe(true);
        const src = readFileSync(storyMd, "utf-8");
        // The deleted-drift-class field must NEVER appear.
        expect(src).not.toMatch(/^status:/m);
        expect(src).toContain("id: fmops-06-native-engine");
        expect(src).toContain("epic: fmops");
        expect(src).toContain("repo: tasks-axi");
        expect(src).toContain("pr_base: epic/fmops");
        expect(src).toContain("kind: ship");
        expect(src).toContain("gate: true");
      } finally {
        b.cleanup();
      }
    });

    it("is idempotent (re-run does not overwrite)", async () => {
      const b = makeBacklog();
      try {
        seedEpic(b.dir, "fmops");
        await storyCommand(
          [
            "new",
            "story-q1",
            "--epic",
            "fmops",
            "--repo",
            "r",
            "--pr-base",
            "main",
          ],
          b.ctx,
        );
        const out = await storyCommand(
          [
            "new",
            "story-q1",
            "--epic",
            "fmops",
            "--repo",
            "r",
            "--pr-base",
            "main",
          ],
          b.ctx,
        );
        expect(out).toContain("already");
      } finally {
        b.cleanup();
      }
    });

    it("refuses when the epic does not resolve", async () => {
      const b = makeBacklog();
      try {
        await expect(
          storyCommand(
            [
              "new",
              "orphan-q1",
              "--epic",
              "nope",
              "--repo",
              "r",
              "--pr-base",
              "main",
            ],
            b.ctx,
          ),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });

    it("requires --epic, --repo, and --pr-base", async () => {
      const b = makeBacklog();
      try {
        await expect(
          storyCommand(["new", "missing-flags"], b.ctx),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      } finally {
        b.cleanup();
      }
    });
  });

  describe("list", () => {
    it("returns stories under an epic sorted by id", async () => {
      const b = makeBacklog();
      try {
        seedEpic(b.dir, "fmops");
        for (const id of ["story-c", "story-a", "story-b"]) {
          await storyCommand(
            [
              "new",
              id,
              "--epic",
              "fmops",
              "--repo",
              "r",
              "--pr-base",
              "main",
            ],
            b.ctx,
          );
        }
        const out = await storyCommand(
          ["list", "--epic", "fmops", "--json"],
          b.ctx,
        );
        const parsed = JSON.parse(out) as {
          stories: Array<{ id: string }>;
        };
        expect(parsed.stories.map((s) => s.id)).toEqual([
          "story-a",
          "story-b",
          "story-c",
        ]);
      } finally {
        b.cleanup();
      }
    });

    it("returns 0 stories when no stories dir exists yet", async () => {
      const b = makeBacklog();
      try {
        seedEpic(b.dir, "fmops");
        const out = await storyCommand(
          ["list", "--epic", "fmops"],
          b.ctx,
        );
        expect(out).toContain("0 stories under fmops");
      } finally {
        b.cleanup();
      }
    });
  });

  it("exposes usage help text", () => {
    expect(STORY_HELP).toContain("usage: tasks-axi story");
  });
});
