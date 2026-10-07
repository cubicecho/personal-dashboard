# Project: Personal Dashboard

One page and one GraphQL endpoint over the cubicecho personal cloud. The
dashboard introspects each app's existing `/graphql` — **auto-cal**, **notes**,
**philotes**, **eunomia** — and stitches them into a single namespaced
supergraph. The apps stay completely independent: **no change is ever required
in an app repo to add it here.** That constraint is the whole design, and it is
why this is schema *stitching* rather than federation.

```
browser ── /            static dashboard page, no build step
        └─ /graphql     stitched supergraph + GraphiQL
                ├── autocal_*   → auto-cal   /graphql
                ├── notes_*     → notes      /graphql
                ├── philotes_*  → philotes   /graphql
                ├── eunomia_*   → eunomia    /graphql
                └── plugins     gateway-local health field
```

Not a monorepo of apps — a single npm workspace (`server`) plus a static `app/`.

## Commands

```bash
# Dev
npm run dev              # server + page on :3000, node --watch, loads ../.env
npm start                # same without --watch

# Quality
npm run lint             # biome check .
npm run lint:fix         # biome check --write .
npm run typecheck        # tsc --noEmit
npm test                 # node --test (unit + HTTP smoke)

# A throwaway plugin to develop against
PORT=4321 node server/test/fixtures/fake-plugin.ts
PLUGIN_FAKE_URL=http://localhost:4321/graphql npm run dev

# The whole personal cloud: four apps + one shared postgres + the dashboard
docker compose -f docker-compose.stack.yml up --build
```

The stack runs apps from their **published Docker Hub images only** — never a
sibling checkout as a build context, so it works from this repo alone and runs
what each app actually shipped. An app with no published image stays commented
out until it has one. Read the header of `docker-compose.stack.yml` before
changing it: the image-only, `NODE_ENV` and no-bind-mount choices are all load
bearing, and each has a comment explaining what breaks otherwise.

**Before every commit:** run `npm test` and `npm run lint`, and do not complete
the commit until both pass. CI (`.github/workflows/ci.yml`) runs lint,
typecheck and test on node 26 and will fail if any does not.

## Tech Stack

| Choice | Why |
|--------|-----|
| **`@graphql-tools/stitch`** | Introspect + prefix + merge at runtime. Federation would need a `/subgraph` endpoint added to every app; stitching needs nothing from them. The tradeoff is no cross-app entity joins — see `.agents/federation.md` for the eventual swap |
| **GraphQL Yoga** | Accepts a `schema: () => …` thunk, so the `reloadPlugins` mutation can hot-swap the stitched schema without a restart |
| **Express 4** | Only serving static files and mounting yoga. **It does not catch rejected promises from async handlers** — every async route must try/catch itself |
| **Native TS (node type stripping)** | Node runs `.ts` directly; no build step, no watcher. Requires `.ts` extensions on every relative import, and `erasableSyntaxOnly` — no enums, no parameter properties, no namespaces |
| **Biome** | Single tool for lint + format; enforces `useImportType`, `noUnusedImports`, single quotes, trailing commas |
| **No framework in `app/`** | Vanilla JS + one stylesheet, served straight off disk. The page is a thin client over the supergraph; keep it that way until the Expo shell in `.agents/roadmap.md` Phase 2 replaces it wholesale |
| **`node --test`** | Built in; no vitest/jest dependency for a project this size |

## Layout

```
server/src/plugins.ts   plugin registry + auth header resolution
server/src/gateway.ts   introspect (or snapshot) → prefix → stitch; the federation seam
server/src/http.ts      express: /graphql (yoga), /health, static app/
server/scripts/         schemas:snapshot — refresh schemas/<name>.graphql
schemas/                snapshots for apps that refuse introspection in production
server/src/index.ts     read env, load the gateway, listen
app/                    the dashboard page (no build step)
server/test/            unit tests + the end-to-end HTTP smoke test
```

## Key Conventions

**A plugin is just a GraphQL endpoint.** Adding one is either an entry in
`DEFAULT_PLUGINS` (`server/src/plugins.ts`) or zero code —
`PLUGIN_<NAME>_URL=http://host:port/graphql` in the environment registers it at
runtime. Add a card to `WIDGETS` in `app/dashboard.js` if it should appear on
the page.

**The plugin name is a schema prefix, so it must be a legal GraphQL name.**
It becomes `<name>_rootField`, `<Name>Type`, the `x-<name>-token` header, and
the `PLUGIN_<NAME>_*` env vars. `loadPlugins` validates it and throws naming the
offending variable; never let a bad name reach `stitchSchemas`, where the error
is opaque.

**The gateway mints no identity.** Each app verifies exactly the token it would
verify standalone. `resolveAuthHeaders` resolves, in order: the browser's
`x-<plugin>-token` header → the `PLUGIN_<NAME>_TOKEN` env → the caller's own
`Authorization`, forwarded verbatim. Do not add a code path that issues,
rewrites, or infers a credential.

**The auth header name is per-plugin, and only `Authorization` gets a scheme.**
`PluginConfig.authHeader` (env: `PLUGIN_<NAME>_AUTH_HEADER`) defaults to
`authorization`, where a bare token is sent as `Bearer <token>`; any other
header — `eunomia` defaults to `x-api-key`, the only header its non-expiring
device keys verify on — receives the credential **raw**. Never add a scheme to
a custom header. A passthrough `Authorization` is the exception to the routing:
it stays on `Authorization` even for a custom-header plugin, because it is a
bearer session token and the app that could verify it reads it there.

**Degrade, never crash.** The dashboard's contract is that it works with
whatever is up. A plugin that is down, or refuses introspection and has no
snapshot, is recorded in `statuses` and skipped; a stitch failure at boot serves
the status-only schema instead of exiting; a failed `reloadPlugins` returns the
error and keeps the schema that was already working. When adding a failure path, decide what it degrades *to*.

```typescript
// ✅ a failure is reported and survivable
catch (err) { statuses.push({ name, url, ok: false, error: message(err) }); }

// ❌ one bad app takes the dashboard down
const schema = await schemaFromExecutor(executor);
```

**Partial GraphQL responses are the normal case.** Under stitching, one upstream
field erroring says nothing about the rest of the response. `gql()` in
`app/dashboard.js` returns `{ data, errors }` and cards render what resolved —
never throw away `data` because `errors` is non-empty.

**Errors are the UX.** `maskedErrors: false` is deliberate: "bad token", "app
down" and friends are exactly what the user needs to see. This is safe only
because the deployment is LAN-only and single-user — revisit before exposing
anything beyond the LAN, along with the unauthenticated `/health` and
`reloadPlugins`.

**Client→server is GraphQL.** The page talks only to `/graphql`; gateway
operations (`plugins`, `reloadPlugins`) are gateway-local fields in the stitched
schema, not REST routes. `/health` is the one exception, for probes that can't
speak GraphQL. Don't add another route without flagging it for review.

**Apps run in production mode; snapshots cover introspection.** Apollo apps
refuse introspection under `NODE_ENV=production`, and they must not change to be
stitched, so `loadSchema` falls back to `schemas/<name>.graphql` — only after
introspection fails, and only after a `{ __typename }` probe shows the app is
up. Never set an app's `NODE_ENV` to something else to make it stitchable:
that turns on its development auth shortcuts. When an app's schema changes,
refresh its snapshot with `npm run schemas:snapshot -- <name>`.

**`server/src/gateway.ts` is the seam the federation phase replaces.** Swapping
introspection+prefixing for composed `/subgraph` endpoints should change that
file and nothing else. Keep `plugins.ts`, `http.ts` and the page from growing a
dependency on how the schema got built.

**Imports:** relative imports carry the `.ts` extension, and type-only imports
use `import type` (`verbatimModuleSyntax`).

## Testing

`npm test` must pass on a machine with **nothing running**. Tests that need a
plugin start `startFakePlugin()` from `server/test/fixtures/fake-plugin.ts`,
which binds an ephemeral port; never point a test at `localhost:3001` or any
other real app, and never depend on the `DEFAULT_PLUGINS` defaults resolving.

- `server/test/gateway.test.ts` — stitching and registry behavior against
  in-memory fixture schemas that collide the way the real apps do (duplicate
  `Note`, `me`, `requestMagicLink`), plus the snapshot fallback against a
  fixture started with `introspection: false`.
- `server/test/smoke.test.ts` — the real `loadPlugins → loadGateway →
  express+yoga` stack over HTTP: introspection, `reloadPlugins`' schema swap, the
  down-plugin path, and proof that auth headers reach upstream.

Anything touching auth header resolution needs a smoke-test assertion, not just
a unit test — `resolveAuthHeaders` being correct in isolation does not prove the
executor puts its output on the wire. The fixture's `header(name:)` field echoes
any received header, so a custom-header plugin can be asserted on directly.

## Running Commands

Prefer scripts defined in `package.json` over ad-hoc invocations (`npx tsc …`,
`npx biome …`). The scripts wrap env loading and workspace targeting.

## Finding files, text or other code

Prefer using an LSP and finding definitions and references through it instead of
grep. Scan the project to detect which LSP makes the most sense to start with.

## Agent File Convention

All files related to project structure, tasks, planning, and feature tracking
live in `.agents/`. Agents must read from and write to `.agents/` for any such
files — never create them at the repo root. Always add new `.agents/` files to
the reference list below.

Note the split: **`.agents/` describes the federated architecture this project
is heading toward; the code implements the stitching MVP that came first.**
Where the two disagree, the code is what runs. Do not "fix" the code to match
the docs, or the docs to match the code, without saying which side you are
moving.

## Agent Reference Files

- [`.agents/README.md`](.agents/README.md) — Index of the design docs, plus the status note on how the MVP relates to them
- [`.agents/architecture.md`](.agents/architecture.md) — Target system overview, decision summary, repo layout, related repos
- [`.agents/federation.md`](.agents/federation.md) — Hive Gateway, offline composition, `@cubicecho/federation` `toSubgraph()`, collision handling, entity graph, per-app change lists, MCP at the gateway
- [`.agents/auth.md`](.agents/auth.md) — OIDC SSO on panva `oidc-provider`, map-by-email, `createOidcVerifier`, zero-trust token flow, standalone fallback
- [`.agents/ui-sharing.md`](.agents/ui-sharing.md) — `@cubicecho/*-ui` packages, fragments, one Apollo v4 client, codegen, Metro/NativeWind, Apollo v3/v4 skew
- [`.agents/deployment.md`](.agents/deployment.md) — Docker Compose stack, port map, env conventions, issuer-URL gotcha
- [`.agents/roadmap.md`](.agents/roadmap.md) — Four phases with per-phase verification, deferred work, risk table
