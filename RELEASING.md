# Releasing

Publishing runs on a `v*` tag via [`.github/workflows/publish.yml`](.github/workflows/publish.yml),
using npm **trusted publishing** — GitHub mints a short-lived OIDC token and npm
exchanges it for publish rights. There is no `NPM_TOKEN` anywhere in this repo,
and provenance attestation is generated automatically.

## One-time bootstrap — done, kept as a record

**This is complete. `0.1.0` went out manually on 2026-08-16 and the trusted
publisher is configured.** Nothing below needs doing again; it is here so the
shape of the problem is legible if the package is ever renamed or re-created,
which resets the trusted-publisher config.

Trusted publishing is configured **per package**, on a page that only exists for
a package that has already been published. So the first version cannot use it.

**1. Publish `0.1.0` once, manually.**

```sh
npm login                 # or: npm login --auth-type=web
npm run build
npm publish --access public
```

`publishConfig.provenance` is deliberately *not* set, so this manual publish
works. It ships without provenance; every later release gets it.

In practice this step needed 2FA at the terminal — npm now refuses tokens that
bypass 2FA for direct publishing, so `EOTP` and a browser round-trip is the
expected path, not a misconfiguration. It is also the reason the rest of this
document exists: OIDC is the only way back to a non-interactive publish.

**2. Configure the trusted publisher.**

npmjs.com → Packages → `claude-local-telemetry` → Settings → Trusted publishing:

| Field | Value |
|---|---|
| Organization or user | `ChristopherDavenport` |
| Repository | `claude-local-telemetry` |
| Workflow filename | `publish.yml` |
| Environment | *(blank)* |
| Allowed actions | `npm publish` |

npm does **not** validate this when you save it. A typo surfaces later as
`ENEEDAUTH` on the publish step, not here.

**3. Optional, once OIDC works.** In npm account settings, require 2FA and
disallow tokens, then revoke any automation tokens. That setting only affects
traditional token auth, so it cannot lock out the workflow.

## Every release after that

**The tag is the version.** Bump `.claude-plugin/plugin.json` in the PR, merge
it, then tag:

```sh
git tag v0.1.2
git push origin v0.1.2
```

That is the whole release. There is no bump commit and no `npm version` run:
`package.json` carries `0.0.0` in the repo, and the workflow writes the real
number from the tag before it builds. The two cannot disagree, because only one
of them is ever authored.

`git push origin <tag>` rather than `--follow-tags`, deliberately. `--follow-tags`
pushes *every* annotated tag reachable from the commits it sends, so a tag kept
back on purpose — a local marker, a release being staged — rides along and
triggers a publish nobody asked for.

Two things the workflow checks that you should know it checks:

- **`plugin.json` must already equal the tag's release core.** It is
  hand-maintained because the marketplace clones this repo and never sees the
  tarball, so a version CI wrote at pack time would not reach plugin users. A
  mismatch fails the run before anything is published — delete the tag, bump the
  file, tag again. It drifted silently from `0.1.0` through the whole of `0.1.1`,
  which is why this is enforced rather than trusted.
- **A prerelease tag publishes under `next`, not `latest`.** `v0.2.0-rc.1` is
  detected by the hyphen. npm hands `latest` to whatever was published most
  recently unless told otherwise, so without this an rc would become the default
  install for everyone. The `plugin.json` check compares the *core* — `0.1.2`
  for `v0.1.2-rc.1` — so it holds the version being worked toward and every rc
  for it passes. Demanding an exact match would mean committing `0.1.2-rc.1` and
  then `0.1.2`, reintroducing the churn the tag exists to remove.

Running the workflow manually (`workflow_dispatch`) does everything except
publish — a dry run of the whole pipeline against whatever `main` is.

The workflow builds, tests, typechecks, derives the version, installs the packed
tarball and runs the binary from it, confirms the packed version matches the
tag, and publishes.

That last check is not ceremony. Node refuses to strip TypeScript types under
`node_modules`, so a package shipping only `.ts` installs cleanly and fails on
first use — which is precisely what happened here before `dist/` existed. The
smoke step is the only thing that would catch it recurring.

## Where the version lives

Three places, and only one of them is authored by hand:

| | Value in the repo | Who writes it |
|---|---|---|
| `package.json` | `0.0.0` | CI, from the tag, at release time |
| `.claude-plugin/plugin.json` | the real version | you, in the PR before the tag |
| MCP `serverInfo` | — | read from `plugin.json` at runtime |

`0.0.0` in `package.json` is a placeholder, not a mistake. Packing from a clone
produces `claude-local-telemetry-0.0.0.tgz`, which is the honest answer: that
tarball is not a release.

`serverInfo` reads `plugin.json` rather than `package.json` because it is the
one manifest correct in both channels — the tag only reaches `package.json`
inside CI, so a marketplace clone running from `src/` would report the
placeholder. `../.claude-plugin/plugin.json` resolves identically from `src/`
and `dist/`, since both sit one level under the package root. It was hardcoded
before, and reported `0.1.0` for the whole of the `0.1.1` release.

## Requirements

Trusted publishing needs npm ≥ 11.5.1 and Node ≥ 22.14.0 on the runner; the
workflow pins Node 24, which this project requires anyway for `node:sqlite`.
Cloud runners only — self-hosted cannot mint the token.

Provenance additionally requires the repository and the package to both be
public. Both are.

## What ships

`files` limits the tarball to `dist/**/*.js`, `skills`, `.claude-plugin` and the
three top-level docs — 14 files, 37 KB.

No declarations, no source maps, no `src`. This is a CLI: `package.json`
declares a `bin` and no `main`/`exports`, so nothing is importable and `.d.ts`
files would describe an API no consumer can reach. The programmatic interface is
`api.ts` over HTTP, which is how the dashboard consumes it and how anything else
can. Adding a module export would be a second, redundant surface plus a semver
commitment on `queries.ts`.

Source maps went with them: they are only useful alongside `src/`, and the two
together were 55% of a tarball for a tool normally run from a clone.

Note that npm is not how the Claude Code plugin is consumed — that goes through
the marketplace, which clones this repo and runs `src/cli.ts` directly. Type
stripping works there because the plugin cache is not under `node_modules`. The
npm package exists for `npx` and for anyone wanting the CLI on its own.
