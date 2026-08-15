# Releasing

Publishing runs on a `v*` tag via [`.github/workflows/publish.yml`](.github/workflows/publish.yml),
using npm **trusted publishing** — GitHub mints a short-lived OIDC token and npm
exchanges it for publish rights. There is no `NPM_TOKEN` anywhere in this repo,
and provenance attestation is generated automatically.

## One-time bootstrap

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

`files` in `package.json` limits the tarball to `dist`, `src`, `skills`,
`.claude-plugin`, and the three top-level docs. `src` is included because the
emitted source maps reference it.

Note that npm is not how the Claude Code plugin is consumed — that goes through
the marketplace, which clones this repo and runs `src/cli.ts` directly. Type
stripping works there because the plugin cache is not under `node_modules`. The
npm package exists for `npx` and for anyone wanting the CLI on its own.
