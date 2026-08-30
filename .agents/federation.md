# GraphQL Federation

## Gateway: Hive Gateway

Evaluated for self-hosted federation with **no cloud accounts**:

| Option | Subscriptions | Composition w/o cloud | Verdict |
|---|---|---|---|
| `@apollo/gateway` (JS) | None at all — auto-cal's `dataChanged` cache invalidation dies | IntrospectAndCompose works | Reject |
| Apollo Router (Rust) | Federated subscriptions are GraphOS/enterprise-licensed | needs `rover supergraph compose` | Reject |
| GraphQL Mesh | its gateway component *is* Hive Gateway now | — | superseded |
| **Hive Gateway** (`ghcr.io/graphql-hive/gateway`, MIT) | Full: clients via graphql-ws or SSE; per-subgraph WS transport | `supergraph: './supergraph.graphql'` from a local file | **Chosen** |

Load-bearing config (`gateway/gateway.config.ts`):

```ts
import { defineConfig } from '@graphql-hive/gateway';

export const gatewayConfig = defineConfig({
  supergraph: './supergraph.graphql',
  propagateHeaders: {
    fromClientToSubgraphs: ({ request }) => ({
      authorization: request.headers.get('authorization') ?? '',
    }),
  },
  transportEntries: {
    autocal: {                       // only auto-cal has subscriptions
      options: {
        subscriptions: {
          kind: 'ws',
          location: '/subgraph',
          connectionParams: { authorization: '{context.headers.authorization}' },
        },
      },
    },
  },
});
```

The `connectionParams.authorization` mapping matches what auto-cal's `useServer` context already reads over WS. Run the gateway as the official container — no gateway code to maintain.

## Composition (offline, checked in)

`gateway/scripts/compose.ts` fetches `{ _service { sdl } }` from each `SUBGRAPH_*_URL`, runs `composeServices` from `@theguild/federation-composition`, and writes:

- `gateway/supergraph.graphql` — consumed by the gateway
- `gateway/api-schema.graphql` — public schema (via `transformSupergraphToPublicSchema`) consumed by dashboard client codegen and `/mcp` tool descriptors

Both files are committed. Composition failures = collision regressions; the same check runs in each app's CI via `assertComposes` (below).

## `@cubicecho/federation` — subgraph-ifying programmatically-built schemas

The app schemas are executable `GraphQLSchema` objects (drizzle-graphql + in-place transforms), not SDL-first, and naive composition is guaranteed to fail on collisions:

- `requestMagicLink` / `verifyMagicLink` defined by **all three** apps
- `Note` type in notes **and** philotes (different shapes)
- `ApiKey` in auto-cal **and** philotes
- drizzle-generated `User` + `UserFilters`-style inputs in all three

Renaming these on `/graphql` would break every existing client and codegen pipeline. So each app builds a **filtered/renamed federation variant** and mounts it at a **new `POST /subgraph` endpoint**. `/graphql` stays byte-for-byte identical → standalone mode preserved by construction.

### API

New repo `cubicecho/federation`, published as `@cubicecho/federation` (exports `.` and `./auth`), modeled on the `graphql-mcp` repo conventions (no-build TS source + tsc emit for publish, node --test, Biome, semantic-release):

```ts
export function toSubgraph(schema: GraphQLSchema, opts: {
  /** Entities: type → key fields, with reference resolver. */
  entities: Record<string, {
    key: string;                                   // e.g. 'email'
    resolveReference?: GraphQLFieldResolver<any, any>;
    shareable?: string[];                          // fields marked @shareable
  }>;
  /** Root Query/Mutation/Subscription fields to drop from the federated variant. */
  omitRootFields?: string[];
  /** Type renames applied everywhere (defs, field types, resolver map keys). */
  renameTypes?: Record<string, string>;            // { Note: 'PersonNote' }
  /** Drop types that become unreachable after omission (default true). */
  pruneOrphans?: boolean;
}): GraphQLSchema;

/** Wraps composeServices; for each app's CI so new drizzle tables can't silently collide. */
export function assertComposes(sdls: { name: string; sdl: string }[]): void;
```

### Implementation sketch (~200 lines)

1. `printSchemaWithDirectives(schema)` → `parse()` — recovers SDL including hand-written extensions.
2. AST visit: apply `renameTypes`, remove `omitRootFields`, prune orphaned types (`pruneSchema` after rebuild).
3. Inject `@key(fields: …)` on entities, `@shareable` on listed fields, prepend `extend schema @link(url: "https://specs.apollo.dev/federation/v2.6", import: ["@key","@shareable","@inaccessible"])`.
4. `getResolversFromSchema(schema)` (`@graphql-tools/utils`) — **captures the live security-wrapped resolver closures**: CASL wrappers (notes), `blockUnscopedResolvers` throws (auto-cal), user-scope wrappers (philotes) all survive because they are the current `field.resolve` functions.
5. Rename resolver-map keys per `renameTypes`, delete omitted fields, add `__resolveReference` per entity.
6. `buildSubgraphSchema({ typeDefs, resolvers })` from `@apollo/subgraph` (adds `_service { sdl }` / `_entities`).

Constraints:
- `toSubgraph` must run **after** all in-place schema transforms (it snapshots them).
- Custom scalars (philotes) must have serialize/parse re-attached — `printSchemaWithDirectives` keeps defs but not functions; the helper copies scalar configs from the source schema.
- Test fixtures must replicate the real collision cases (dupe `Note`, dupe magic-link mutations, dupe `User` inputs).

### Per-app subgraph config (v1)

| App | subgraph name | entities | omitRootFields | renameTypes |
|---|---|---|---|---|
| auto-cal | `autocal` | `User { key: 'email' }` | magic-link mutations, all non-`my*` drizzle CRUD (dead anyway — removes colliding `User` CRUD inputs), api-key fields | — |
| notes | `notes` | `User { key: 'email' }` | magic-link mutations, apiToken fields | — |
| philotes | `philotes` | `User { key: 'email' }` | magic-link mutations, apiKey fields, import/dedupe admin mutations (optional) | `Note → PersonNote`, `Task → CrmTask` (+ their inputs/list types) |
| eunomia | `eunomia` | `User { key: 'email' }` | magic-link mutations, device API-key fields | **TBD — not yet audited for collisions.** Added to the dashboard after these docs were written; it is Yoga + drizzle-graphql + graphql-casl like the others, so expect the same dupe-`User`-input class of collision |

### Entity graph (v1 minimal)

- **`User @key(fields: "email")`** in all three subgraphs — the only v1 entity. All three users tables have `email text unique`. Expose `email` + each app's distinctive fields; **omit local `id`/`createdAt`/`updatedAt`** (their values differ per subgraph — three different UUIDs — so they can't be `@shareable`). `resolveReference: ({ email }, ctx) => findOrCreateUserByEmail(ctx.db, email)`.
- **Later (Phase 4):** `Person @key(fields: "id")` owned by philotes, referenced from notes `Note.mentionedPersons` (gated on notes storing philotes person ids). `Todo @key(fields: "id")` owned by autocal similarly.
- **Future extraction:** a tasks/habits/projects service is just a 4th `/subgraph` claiming those root fields + re-running compose — nothing in the gateway or dashboard hard-codes "auto-cal owns todos".

### Per-app change list (~3 small edits each)

- **auto-cal**
  - `server/src/schema/subgraph.ts` — `toSubgraph(schema, …)` config
  - `server/src/index.ts` — mount a second `expressMiddleware` at `/subgraph` with the same `buildContext`; point a second `useServer` WS at `/subgraph` serving the subgraph schema (keep `/graphql` WS as-is)
  - `buildContext` — OIDC branch (see [auth.md](auth.md))
- **notes**
  - `server/src/schema/subgraph.ts`; mount `/subgraph` in `server/src/index.ts`; OIDC branch in `server/src/context.ts`
- **philotes**
  - `server/src/subgraph.ts` (config incl. renames); mount in `server/src/index.ts`; OIDC branch in the auth verify path
- **eunomia** — a fourth app, stitched into the dashboard but not yet audited for
  federation. Its server lives at `apps/server` inside its own monorepo and uses
  better-auth (sessions + device API keys) rather than the others' magic-link +
  API-key pair, so its OIDC branch is the one unknown. Audit before Phase 1.

All behind env vars; standalone `docker compose up` per repo unchanged.

## MCP at the gateway

One `/mcp` on the dashboard server, mirroring the security model of `notes/server/src/mcp.ts` but remote:

```ts
import { createHttpHandler, createHttpExecutor } from '@cubicecho/graphql-mcp';
import { buildSchema as buildFromSDL } from 'graphql';

const apiSchema = buildFromSDL(readFileSync('gateway/api-schema.graphql', 'utf8')); // tool descriptors
export const mcpHandler = createHttpHandler({
  schema: apiSchema,
  executor: createHttpExecutor(`${process.env.GATEWAY_URL}/graphql`, {
    /* forward the caller's Authorization header — verify/add this option in
       graphql-mcp/src/executor.ts (it's our package) */
  }),
});
```

Permission-safe because every tool call round-trips through the gateway to the CASL/scope-wrapped subgraph resolvers with the caller's own token — an MCP caller can do exactly what it could over `/graphql`, no more.
