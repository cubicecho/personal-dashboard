# Personal Dashboard

One page for your personal cloud: stitches the cubicecho apps — **auto-cal**,
**notes**, **philotes**, **eunomia** — into a single GraphQL endpoint and a
single dashboard page. The apps stay completely independent; the dashboard
introspects each one's existing `/graphql` and namespaces it into a stitched
supergraph. Zero changes required in any app.

```
browser ── / (static dashboard page)
        └─ /graphql (stitched supergraph, GraphiQL)
               │  @graphql-tools/stitch, per-plugin prefixes
               ├── autocal_*   → auto-cal   /graphql
               ├── notes_*     → notes      /graphql
               ├── philotes_*  → philotes   /graphql
               ├── eunomia_*   → eunomia    /graphql
               └── plugins     (gateway-local health field)
```

## Run

```sh
cp .env.example .env    # point PLUGIN_*_URL at your running apps
npm install
npm run dev             # http://localhost:3000 (listens on 0.0.0.0)
```

Apps that are down (or refuse introspection) are skipped with a warning and
the rest still work; `POST /reload` (or the ⟲ button on the page) re-introspects
without a restart.

## Auth

The gateway mints nothing — each app verifies exactly the token it would
standalone. Per plugin, the upstream `Authorization` header is, in order:

1. `x-<plugin>-token` request header — set per-browser in the page's ⚙ panel
   (stored in localStorage), sent as `Bearer <token>`;
2. `PLUGIN_<NAME>_TOKEN` env — a server-side API key/token;
3. the caller's own `Authorization` header, forwarded verbatim.

Mint a token in each app (auto-cal API key, notes `cet_` token, philotes API
key, eunomia API key) and put it in `.env` or the ⚙ panel.

## Adding a plugin

Any GraphQL endpoint is a plugin. Either:

- set `PLUGIN_<NAME>_URL=http://host:port/graphql` in the environment — no code;
- or add an entry to `server/src/plugins.ts`.

Types get prefixed `<Name>*`, root fields `<name>_*`, so cross-app name
collisions are impossible. `<NAME>` must be a legal GraphQL name (it becomes
that prefix) — anything else throws at startup with the offending variable named. Add a card for it in `app/dashboard.js` (`WIDGETS`)
if it should appear on the page. `server/test/fixtures/fake-plugin.ts` is a
runnable minimal example.

## Limitations / next steps

- **Subscriptions are dropped** from the stitched schema (the apps serve them
  over graphql-ws; this gateway doesn't bridge that yet). The page polls.
- One token per app rather than SSO, and no cross-app entity joins (`User` by
  email, philotes `Person` referenced from notes). The full plan for those —
  federation via Hive Gateway + `toSubgraph`, a small OIDC provider, shared UI
  packages — lives in [.agents/](.agents/README.md); the plugin registry and
  gateway module here are the seams it slots into.

## Layout

```
server/src/plugins.ts   plugin registry + auth header resolution
server/src/gateway.ts   introspect → prefix → stitch; /reload support
server/src/http.ts      express: /graphql (yoga), /health, /reload, static app/
server/src/index.ts     read env, load the gateway, listen
app/                    the dashboard page (no build step)
server/test/            unit tests + an end-to-end HTTP smoke test
```
