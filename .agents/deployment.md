# Deployment

Docker Compose stack on the home server. **All services run on real Postgres in the stack** — PGlite is single-connection and busy-waits on idle; it stays a dev/standalone convenience only. Auto-provisioning-by-email plus gateway fan-out means concurrent requests per app.

## Ports

| Service | container port | host port | notes |
|---|---|---|---|
| postgres | 5432 | 5432 | initdb script creates `autocal`, `notes`, `philotes`, `auth` databases (eunomia still has its own) |
| auto-cal | 3001 | 3001 | repo default unchanged |
| notes | 4000 | 3002 | host remap only |
| philotes | 3001 | 3003 | host remap only — fixes the 3001 clash with auto-cal without touching either repo |
| eunomia | 4000 | 4000 | own compose today (own postgres on 5433); not yet folded into this stack |
| auth (OIDC) | 3004 | 3004 | must be reachable by browser **and** containers at the same issuer URL |
| gateway (Hive) | 4000 | — | internal only; dashboard proxies to it |
| dashboard | 8080 | 8080 | serves SPA, `/mcp`, proxies `/graphql` (HTTP + WS) |

## Compose sketch (load-bearing parts)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    volumes: [ "pgdata:/var/lib/postgresql/data", "./initdb:/docker-entrypoint-initdb.d" ]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 5s, retries: 5 }
  auth:
    build: ./auth
    environment:
      - OIDC_ISSUER=http://auth.home:3004        # one hostname valid from browser AND containers
      - DATABASE_URL=postgresql://postgres:...@postgres:5432/auth
    ports: ["3004:3004"]
  autocal:
    image: ghcr.io/cubicecho/auto-cal:latest      # or build: ../auto-cal
    environment:
      - DATABASE_URL=postgresql://...@postgres:5432/autocal
      - OIDC_ISSUER=http://auth.home:3004
      - OIDC_AUDIENCE=cubicecho
    ports: ["3001:3001"]
  notes:    { ..., ports: ["3002:4000"] }
  philotes: { ..., ports: ["3003:3001"] }
  gateway:
    image: ghcr.io/graphql-hive/gateway
    command: supergraph
    volumes:
      - ./gateway/supergraph.graphql:/gateway/supergraph.graphql
      - ./gateway/gateway.config.ts:/gateway/gateway.config.ts
    depends_on: [autocal, notes, philotes]
  dashboard:
    build: .
    environment: [ "GATEWAY_URL=http://gateway:4000", "OIDC_ISSUER=http://auth.home:3004" ]
    ports: ["8080:8080"]
volumes: { pgdata: }
```

## Environment variable conventions

| Variable | Consumed by | Meaning |
|---|---|---|
| `OIDC_ISSUER` / `OIDC_AUDIENCE` | every app + dashboard | presence toggles SSO mode per app; unset = standalone behavior, bit-identical to today |
| `DATABASE_URL` | every app + auth | per-app Postgres database |
| `GATEWAY_URL` | dashboard server | proxy + `/mcp` executor target |
| `SUBGRAPH_AUTOCAL_URL` / `SUBGRAPH_NOTES_URL` / `SUBGRAPH_PHILOTES_URL` | `gateway/scripts/compose.ts` only | where to fetch `{_service{sdl}}` during composition |

## OIDC issuer URL gotcha

The issuer string baked into tokens must match what subgraphs verify **and** be reachable from both the browser (login redirect) and containers (JWKS fetch). Use one LAN hostname (e.g. `auth.home` via router DNS, or `/etc/hosts` on clients + `extra_hosts` in compose). `localhost` will not work — it resolves differently inside containers.

## Dashboard image

Same shape as the notes Dockerfile: build the Expo web bundle outside Docker, image installs prod deps and copies `server/` TS source (run via `--experimental-strip-types`) + `app/dist`. The server proxies `/graphql` with WS upgrade (`http-proxy-middleware`, `ws: true`) so the client keeps same-origin relative URLs — no CORS.
