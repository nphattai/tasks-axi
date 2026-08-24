# tasks-axi is a hard fork

`nphattai/tasks-axi` is a hard fork of `kunchenguid/tasks-axi@0.2.5` (MIT).
It ships as a backward-compatible SUPERSET: every preserved verb + flag keeps
byte-exact behavior, and Epic / Story / Task / Report become first-class in
the tool (enforce-on-write, single status source, native report path). See
`plans/fmops-06-native-engine-plan/plan.md` for the build contract.

No upstream-merge tracking. The npm package name and the bin name stay
`tasks-axi` (`src/version.ts` asserts the name at startup, and the fleet
compat probe reads `--version`), so the fork installs over the upstream
without touching any downstream call site.
