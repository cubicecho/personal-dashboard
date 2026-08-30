# Roadmap & Risks

Four phases; **each phase leaves every app's standalone mode working**.

## Phase 1 — Federation + SSO backbone

1. New repo `cubicecho/federation` → publish `@cubicecho/federation`:
   - `toSubgraph`, `assertComposes`, `./auth` (`createOidcVerifier`), `findOrCreateUserByEmail` helper contract
   - tests against fixture schemas replicating the real collision cases (dupe `Note`, dupe magic-link mutations, dupe drizzle `User` inputs) and a CASL-wrapped fixture proving security wrappers survive
2. Per-app changes (see [federation.md](federation.md) + [auth.md](auth.md)): `/subgraph` endpoint + OIDC context branch, behind env vars.
3. Scaffold this repo: `auth/` OIDC service, `gateway/scripts/compose.ts`, `gateway.config.ts`, `docker-compose.yml`.

**Verify:**
- `compose.ts` succeeds (composition errors = collision regressions)
- with one OIDC token through the gateway: `{ myTodos { id } }`, `{ myNotes { id } }`, `{ persons { id } }` all work and three per-app user rows auto-provision with the same email
- `graphql-ws` subscribe to `dataChanged` through the gateway; mutate a todo directly against auto-cal; observe the event
- each app standalone still magic-link-logs-in with `OIDC_ISSUER` unset

## Phase 2 — Dashboard shell + first widgets

1. `app/` Expo shell: PKCE login flow, Apollo Client v4 → same-origin `/graphql`, home screen with 2–3 *new* widgets written directly against the supergraph (today's schedule, recent notes, upcoming philotes dates) — proves cross-subgraph queries in one operation.
2. `server/` container: static serve + `/graphql` proxy + Dockerfile; add to compose.

**Verify:** login round-trip on the home server; one query touching all three subgraphs renders; token-expiry re-auth works; codegen against `gateway/api-schema.graphql` typechecks.

## Phase 3 — Component extraction + reuse

1. Publish `@cubicecho/tailwind-preset`. Per app: add `ui/` workspace, move/re-export 2–3 highest-value components each (todo list item + schedule block; note list/editor preview; person card + upcoming dates) with `Ac*`/`Notes*`/`Ph*`-prefixed fragments; semantic-release publishes. philotes-ui written against Apollo v4 (see [ui-sharing.md](ui-sharing.md)).
2. Dashboard installs the three `-ui` packages, swaps hand-rolled widget internals for them; extends tailwind content globs + codegen documents into `node_modules`.

**Verify:** each app's standalone bundle still builds (apps consume their own `ui/` workspace by path — no behavior change); dashboard visual check on web; `npx expo export` succeeds (Metro transpiles published TS source).

## Phase 4 — Cross-app entity links + MCP

1. `Person @key(fields: "id")` entity in philotes; notes adds `Note.mentionedPersons: [Person]` stubs — **gated on notes storing philotes person ids**. Render person chips in dashboard note widgets.
2. `/mcp` on the dashboard server via `createHttpExecutor(GATEWAY_URL)` — first confirm/add auth-header forwarding in `graphql-mcp/src/executor.ts` (our package). Register in MCP client config (or as a remote in mcp-router).

**Verify:** entity resolution through a mention (`_entities` → person name); MCP tool list matches supergraph root fields; MCP call with OIDC token mutates through the gateway; MCP call with a philotes-only API key correctly **fails** on notes fields (zero-trust proof).

## Later / out of scope here

- **Extract tasks/habits/projects from auto-cal** into its own service: becomes a 4th subgraph claiming those root fields + re-compose. From the auto-cal exploration: projects+projectNotes are the cleanest extraction (scheduler never reads projects); habits are moderately separable but are first-class scheduler inputs; todos are the most entangled (todo → list → activityType indirection, scheduler writeback, iCal, stats, Google Tasks import). The hard dependency for any split is `activityTypes` + `timeBlocks` — the shared substrate a standalone service must own or reference via entities.
- notes standalone auth hardening (raw-UUID sessions → signed tokens) — in the notes repo.
- philotes Apollo Client v3 → v4 upgrade — in the philotes repo; unblocks growing philotes-ui.
- Refresh-token rotation in the auth service.

## Risks

| Risk | Mitigation |
|---|---|
| **Subscriptions through the gateway** (sharpest edge): auto-cal's subgraph WS endpoint must serve the *subgraph* schema and accept `connectionParams.authorization` | Phase 1 verifies explicitly; fallback = SSE from Hive Gateway or polling; standalone auto-cal WS untouched either way |
| New drizzle tables silently introduce new composition collisions | `assertComposes` in each app's CI — not optional |
| In-place schema transforms + custom scalars vs `toSubgraph` snapshot | run `toSubgraph` after all transforms; re-attach scalar serialize/parse fns; covered by fixtures |
| PGlite under concurrent gateway fan-out | all stack services on real Postgres; PGlite dev-only |
| Apollo v3/v4 drift (philotes) | philotes-ui stays small until philotes upgrades to v4 |
| DIY OIDC (`oidc-provider`) key handling/upgrades | acceptable LAN-only single-user; never internet-expose the issuer without revisiting (or swap to Zitadel) |
| notes raw-UUID sessions | OIDC path checked first in dashboard mode; standalone fix scheduled in notes repo |
| Issuer URL reachability browser-vs-containers | single LAN hostname (`auth.home`), never `localhost` |
