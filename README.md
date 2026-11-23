# mend

[![bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tiars837/mend-23-nov/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tiars837/mend-23-nov/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four
formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and
text-editor tool calls as JSON — and `mend` reads each one as `SPEC.md` says, changing every file
or nothing: a failed edit changes nothing, the edits after it still run, and when any edit failed
no file is written at all.

## Run it

Node 22, standard library only, no network:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, or `-` (or absent) to read the patch from standard input. `--format`
picks `unified`, `search-replace`, `v4a`, `json`, or `auto` — the default, which detects the format.
`--check` reports what would change without writing anything. `--strict` matches lines exactly
(tier 0 only); without it, lines also match with trailing whitespace ignored, then with leading
and trailing whitespace ignored and the new lines re-indented to the file.

`SPEC.md` is the whole specification. `check.ts` runs the public practice set against `main.ts`:

    node check.ts <practice.json>
    node check.ts <practice.json> u-offset s-basic

## The files

- `main.ts`: the CLI. Sections 1 to 4, 9 and 10 of `SPEC.md` (the command line, output and exit
  codes, safe paths, format detection, JSON edits, the all-or-nothing write) plus sections 5 to 8
  (three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches). Its last lines
  hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's runner. In a trial it reads the checks from the env, runs `main.ts` on
  each one in a fresh directory, and posts the exit code, stdout and files left behind.
- `check.ts`: the practice set on your own machine.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
