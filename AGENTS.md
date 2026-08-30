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
```

**Before every commit:** run `npm test` and `npm run lint`, and do not complete
the commit until both pass. CI (`.github/workflows/ci.yml`) runs lint,
typecheck and test on node 26 and will fail if any does not.

## Tech Stack

| Choice | Why |
|--------|-----|
| **`@graphql-tools/stitch`** | Introspect + prefix + merge at runtime. Federation would need a `/subgraph` endpoint added to every app; stitching needs nothing from them. The tradeoff is no cross-app entity joins — see `.agents/federation.md` for the eventual swap |
| **GraphQL Yoga** | Accepts a `schema: () => …` thunk, so `POST /reload` can hot-swap the stitched schema without a restart |
| **Express 4** | Only serving static files and mounting yoga. **It does not catch rejected promises from async handlers** — every async route must try/catch itself |
| **Native TS (node type stripping)** | Node runs `.ts` directly; no build step, no watcher. Requires `.ts` extensions on every relative import, and `erasableSyntaxOnly` — no enums, no parameter properties, no namespaces |
| **Biome** | Single tool for lint + format; enforces `useImportType`, `noUnusedImports`, single quotes, trailing commas |
| **No framework in `app/`** | Vanilla JS + one stylesheet, served straight off disk. The page is a thin client over the supergraph; keep it that way until the Expo shell in `.agents/roadmap.md` Phase 2 replaces it wholesale |
| **`node --test`** | Built in; no vitest/jest dependency for a project this size |

## Layout

```
server/src/plugins.ts   plugin registry + auth header resolution
server/src/gateway.ts   introspect → prefix → stitch; the federation seam
server/src/http.ts      express: /graphql (yoga), /health, /reload, static app/
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
verify standalone. `resolveAuthHeader` resolves, in order: the browser's
`x-<plugin>-token` header → the `PLUGIN_<NAME>_TOKEN` env → the caller's own
`Authorization`, forwarded verbatim. Do not add a code path that issues,
rewrites, or infers a credential.

**Degrade, never crash.** The dashboard's contract is that it works with
whatever is up. A plugin that is down or refuses introspection is recorded in
`statuses` and skipped; a stitch failure at boot serves the status-only schema
instead of exiting; a failed `/reload` answers 503 and keeps the schema that was
already working. When adding a failure path, decide what it degrades *to*.

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
anything beyond the LAN, along with the unauthenticated `/health` and `/reload`.

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
  `Note`, `me`, `requestMagicLink`).
- `server/test/smoke.test.ts` — the real `loadPlugins → loadGateway →
  express+yoga` stack over HTTP: introspection, `/reload`'s schema swap, the
  down-plugin path, and proof that auth headers reach upstream.

Anything touching auth header resolution needs a smoke-test assertion, not just
a unit test — `resolveAuthHeader` being correct in isolation does not prove the
executor puts its output on the wire.

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
