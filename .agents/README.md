# Personal Dashboard — Agent Docs

Design docs for composing the cubicecho apps (auto-cal, notes, philotes) into one dashboard of federated microapps. Nothing is implemented yet — these docs are the plan.

| Doc | Contents |
|---|---|
| [architecture.md](architecture.md) | System overview, decision summary, why the shared stack makes this tractable, repo layout, related repos |
| [federation.md](federation.md) | Hive Gateway choice + config, offline composition, `@cubicecho/federation` `toSubgraph()` design, collision handling, entity graph, per-app change lists, MCP at the gateway |
| [auth.md](auth.md) | OIDC SSO on panva `oidc-provider`, map-by-email, `createOidcVerifier`, zero-trust token flow, standalone fallback |
| [ui-sharing.md](ui-sharing.md) | `@cubicecho/*-ui` npm packages (raw TS source), fragments + one Apollo v4 client against the supergraph, codegen, Metro/NativeWind mechanics, Apollo v3/v4 skew |
| [deployment.md](deployment.md) | Docker Compose stack, port map (fixes the auto-cal/philotes 3001 clash), env conventions, issuer-URL gotcha |
| [roadmap.md](roadmap.md) | Four phases with per-phase verification, deferred work (incl. the future tasks/habits/projects extraction), risk table |

> **Status update (2026-08):** an MVP is now implemented in this repo — schema
> *stitching* (not federation) via `@graphql-tools/stitch` with per-plugin
> prefixes, per-app tokens instead of OIDC, and a no-build static dashboard
> page. See the root [README](../README.md). These docs remain the plan for
> the federation/SSO/UI-package phases; the MVP's plugin registry
> (`server/src/plugins.ts`) and gateway module (`server/src/gateway.ts`) are
> the seams they replace.
