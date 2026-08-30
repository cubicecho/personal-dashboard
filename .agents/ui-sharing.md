# UI Component Sharing

Each app publishes its reusable domain components as an npm package — `@cubicecho/autocal-ui`, `@cubicecho/notes-ui`, `@cubicecho/philotes-ui` — which the dashboard installs as normal versioned deps. Apps keep their standalone UIs; the dashboard composes the packages plus its own new unifying UI.

## Package shape (identical for all three)

New workspace in each app repo, e.g. `auto-cal/ui/`:

```
ui/
  package.json      # name: @cubicecho/autocal-ui, files: ["src"], exports: { ".": "./src/index.ts" }
  src/index.ts
  src/todo-card.tsx # component + colocated fragment
  src/fragments.ts
```

- **Publish raw `.tsx` source** — no build step, matching the org ethos. Expo's Metro transpiles TS inside `node_modules` (babel-preset-expo applies project-wide), and consumer tsconfig `moduleResolution: "bundler"` type-checks source imports directly. Keep internal imports extensionless or `.ts`; the org's existing metro `resolveRequest` shim (`notes/app/metro.config.js`) handles `.js → .ts`.
- **peerDependencies:** `react`, `react-native`, `react-native-web`, `nativewind`, `@apollo/client@^4`, `graphql`. **No `expo-router` imports** — navigation callbacks come in as props.
- semantic-release in each repo publishes on merge (already set up everywhere).

## How the GraphQL works (the key question)

- **One Apollo Client (v4) in the dashboard shell**, pointed at the gateway (`/graphql`, same-origin via the dashboard server proxy), provided via `ApolloProvider`. Packages never instantiate clients.
- **Default: presentational components + exported fragments.**

  ```ts
  // in @cubicecho/autocal-ui
  export const AcTodoCardFragment = gql`
    fragment AcTodoCard on Todo { id title dueAt scheduledAt }
  `;
  export function AcTodoCard({ todo }: { todo: AcTodoCardFragmentType }) { … }
  ```

  Dashboard widgets compose them into their own queries:

  ```ts
  gql`query DashboardToday { myTodos { ...AcTodoCard } } ${AcTodoCardFragment}`
  ```

- **Container components** (own `useQuery`/`useMutation`/`useSubscription`) are allowed for heavier widgets. They work unchanged against the gateway because the supergraph exposes the same field names as each app's `/graphql` — minus the omitted auth/api-key fields, plus the philotes renames. Therefore **philotes-ui fragments are written against `PersonNote`/`CrmTask`** (see [federation.md](federation.md)).
- **Operation/fragment naming:** `@graphql-codegen` client-preset hard-errors on duplicate names across scanned documents. Convention enforced at extraction: prefix with app — `Ac*`, `Notes*`, `Ph*`.
- **Dashboard codegen** (`codegen.ts`):

  ```ts
  schema: 'gateway/api-schema.graphql',   // public schema emitted by the compose script
  documents: [
    'app/src/**/*.{ts,tsx}', 'app/app/**/*.{ts,tsx}',
    'node_modules/@cubicecho/*-ui/src/**/*.{ts,tsx}',  // re-derive package fragment types against the supergraph
  ],
  generates: { 'app/src/__generated__/': { preset: 'client', presetConfig: { fragmentMasking: false } } },
  ```

  Packages ship their *own* generated fragment types (generated in their home repo against the app schema) for standalone typing; the dashboard re-derives the same types against the supergraph — they agree because the selections are identical.

## Apollo Client v3 vs v4 (philotes)

`@cubicecho/philotes-ui` is written against **v4** (`@apollo/client/react` hook imports) from day one — the dashboard is its first consumer. The philotes standalone app stays on v3 with its in-repo components until its own v4 upgrade, after which it adopts the package. **Never ship two Apollo runtimes/caches in one bundle.** Keep philotes-ui small until the upgrade to limit drift.

## NativeWind / Tailwind

- className strings must be scanned: dashboard `tailwind.config.ts` adds
  `content: [..., './node_modules/@cubicecho/*-ui/src/**/*.{ts,tsx}']`.
- Extract the shared shadcn-style theme (the three apps' configs are near-identical, see `notes/app/tailwind.config.ts`) into **`@cubicecho/tailwind-preset`** so tokens like `bg-card` / `text-muted-foreground` resolve identically in every consumer.

## Metro (dashboard app)

Standard Expo config + the org's `.js→.ts` resolver shim (clone from `notes/app/metro.config.js`) + `watchFolders: [workspaceRoot]`. No module federation, no extra transpilation config beyond defaults — Metro compiles the published TS source in `node_modules`.
