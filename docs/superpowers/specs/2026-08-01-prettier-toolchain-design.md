# Prettier Toolchain Design

**Date:** 2026-08-01
**Status:** Approved for implementation

## Goal

Give `remote-runner` a deterministic, repository-owned formatting workflow so
agents and contributors do not need to borrow another repository's Prettier
installation or make manual style decisions.

## Decision

Adopt a pinned Prettier 3.9.5 development dependency and format the whole
maintained repository baseline once. Add repository-local `format` and
`format:check` scripts, then make `format:check` the first step of `pnpm verify`.

Use a small explicit configuration:

- `printWidth: 120`, matching the existing compact TypeScript style;
- `proseWrap: preserve`, avoiding unrelated Markdown paragraph reflow;
- generated, dependency, cache, and package-manager-owned paths excluded via
  `.prettierignore`;
- `--ignore-unknown`, so repository-level commands safely skip unsupported
  assets rather than requiring an exhaustive extension list.

## Change Structure

Keep semantic/tooling changes separate from mechanical formatting:

1. Add the pinned dependency, configuration, ignore rules, and formatter
   scripts without changing the existing `verify` gate.
2. Run the repository-owned formatter and commit only its mechanical output.
3. Add the formatting commit SHA to `.git-blame-ignore-revs`, document the
   opt-in blame configuration, and prepend `format:check` to `pnpm verify`.

This ordering keeps the mass rewrite reviewable and gives future blame tools a
stable revision to ignore.

## Alternatives Considered

### Gradual formatting

Format only files touched by future work. This minimizes the initial diff but
leaves mixed style indefinitely and cannot support a whole-repository gate now.

### Tool only, without a verify gate

Provide `format` and `format:check` but do not enforce them. This reduces manual
setup but still permits drift and makes failures appear later in review.

The one-time baseline plus verify gate is preferred because this repository is
small and the resulting contract is immediate and deterministic.

## Verification

Acceptance requires:

- `pnpm format:check` succeeds on the formatted tree;
- `pnpm verify` succeeds with formatting, typecheck, all unit tests, and build;
- a deliberate formatting violation makes `pnpm format:check` fail, after
  which restoring the file returns the tree to green;
- the mechanical formatting commit contains no semantic edits;
- `.git-blame-ignore-revs` names the exact mechanical formatting commit.

## Non-goals

- ESLint or semantic lint rules;
- formatting generated `dist/`, dependency state, CodeGraph state, coverage,
  or `pnpm-lock.yaml`;
- changing runtime behavior or publishing a package version.
