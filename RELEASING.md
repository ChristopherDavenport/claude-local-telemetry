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

```sh
npm version patch          # or minor / major — commits and tags
git push --follow-tags
```

Check `npm --version` first. A Node installed without its bundled npm — a
`nodejs` build from a distro, or a `/usr/local` install where only `node` and
`corepack` landed — leaves a much older npm ahead on `PATH`; this machine had
npm 9 against Node 25. `npm version` will still run, but it is not the client
anything else here assumes. `corepack npm@11 version patch` pins it without
touching the system install.

The workflow then builds, tests, typechecks, asserts the tag matches
`package.json`, installs the packed tarball and runs the binary from it, and
publishes.

That last check is not ceremony. Node refuses to strip TypeScript types under
`node_modules`, so a package shipping only `.ts` installs cleanly and fails on
first use — which is precisely what happened here before `dist/` existed. The
smoke step is the only thing that would catch it recurring.

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
