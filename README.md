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

## Running the whole stack

`docker-compose.stack.yml` brings up the apps, the dashboard, and **one shared
Postgres** — each app gets its own role and database inside it
(`deploy/postgres/`), so every app sees exactly the database it sees standalone
and its `DATABASE_URL` differs only in host.

```bash
cp .env.example .env      # set JWT_SECRET and PUBLIC_HOST
docker compose -f docker-compose.stack.yml up --build
```

Apps run from their **published Docker Hub images**, never from a sibling
checkout, so the stack works from this repo alone and you get what that app
actually shipped. Apps with no published image are commented out in the file;
uncomment them once they are pushed. Only the dashboard is built, from here.

| | image | host port | container |
|---|---|---|---|
| dashboard | built from this repo | 3000 | `dashboard:3000` |
| auto-cal | `vantreeseba/auto-cal` | 3001 | `autocal:3001` |
| philotes | `vantreeseba/philotes` | 3003 | `philotes:3001` |
| postgres | built from `deploy/postgres` | 5434 (loopback) | `postgres:5432` |
| notes | **not published** — commented out | 3002 | |
| eunomia | **not published** — commented out | 4000 | |

The dashboard reaches stack apps by service name over the compose network, so
the host ports are only for you. An app running *outside* the stack is reached
over the host instead — `PLUGIN_EUNOMIA_URL` defaults to `PUBLIC_HOST:4000`
for exactly that reason. Every app runs its own migrations on boot; there is
no manual migration step.

Two things to know before running it:

- **Introspection.** auto-cal, notes and philotes serve GraphQL through Apollo,
  which refuses introspection under `NODE_ENV=production` and so cannot be
  stitched at all. Since no app repo changes to appear on the dashboard, the
  stack leaves `NODE_ENV` empty for them. That is not free — the header of
  `docker-compose.stack.yml` lists exactly what each one trades, and
  `<APP>_NODE_ENV=production` takes any of them back at the cost of dropping
  off the dashboard.
- **Remote daemons.** If `docker context ls` shows a remote daemon, published
  ports land on *that* host — set `PUBLIC_HOST` to it. Nothing in the stack is
  bind-mounted for the same reason (a bind mount would resolve on the daemon's
  filesystem and silently mount an empty directory), which is why the Postgres
  bootstrap is baked into an image rather than mounted.

## Auth

The gateway mints nothing — each app verifies exactly the token it would
standalone. Per plugin, the credential sent upstream is, in order:

1. `x-<plugin>-token` request header — set per-browser in the page's ⚙ panel
   (stored in localStorage);
2. `PLUGIN_<NAME>_TOKEN` env — a server-side API key/token;
3. the caller's own `Authorization` header, forwarded verbatim.

**Which header it rides in is per-plugin.** The default is `Authorization`, and
a token going there gets a `Bearer ` scheme. `PLUGIN_<NAME>_AUTH_HEADER` (or an
`authHeader` in `server/src/plugins.ts`) sends it somewhere else instead, raw —
a custom header carries no scheme. `eunomia` defaults to `x-api-key`, because
that is the only header its non-expiring device keys are accepted on. A
passthrough `Authorization` (case 3) always stays on `Authorization`: it is a
bearer session token, and renaming it would strip the header that verifies it.

Mint a token in each app (auto-cal API key, notes `cet_` token, philotes API
key, eunomia device key via `registerDevice`) and put it in `.env` or the ⚙
panel.

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
deploy/postgres/        the shared Postgres image + per-app role/db bootstrap
docker-compose.stack.yml  all four apps + shared postgres + the dashboard
```
