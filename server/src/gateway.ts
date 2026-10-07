import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Builds the stitched "supergraph": one executable schema that namespaces and
 * merges every reachable plugin, plus a local `plugins` status field.
 *
 * Per plugin: introspect its endpoint (or, when it refuses, read its schema
 * snapshot — see loadSchema) → wrap as a subschema whose types get a `<Name>`
 * prefix and whose root fields get a `<name>_` prefix → stitch.
 * Prefixing makes cross-app collisions impossible; provenance is legible in
 * every query. Subscriptions are filtered out for now (the apps serve them
 * over graphql-ws, which this HTTP gateway doesn't bridge — the page polls).
 *
 * This module is the seam where the .agents/ federation plan slots in later:
 * swapping introspection+prefixing for `/subgraph` endpoints composed by Hive
 * Gateway changes this file, not the plugins or the dashboard server.
 */
import { buildHTTPExecutor } from '@graphql-tools/executor-http';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { stitchSchemas } from '@graphql-tools/stitch';
import {
  RenameRootFields,
  RenameTypes,
  schemaFromExecutor,
} from '@graphql-tools/wrap';
import {
  type ExecutionResult,
  GraphQLSchema,
  buildSchema,
  parse,
} from 'graphql';
import {
  type PluginConfig,
  resolveAuthHeaders,
  typePrefix,
} from './plugins.ts';

export type SchemaSource = 'introspection' | 'snapshot';

export interface PluginStatus {
  name: string;
  url: string;
  ok: boolean;
  /** Where the stitched schema came from; absent when not stitched. */
  schemaSource?: SchemaSource;
  /** Why it isn't stitched — or, with a snapshot, why introspection failed. */
  error?: string;
}

/** The committed snapshots, one `<name>.graphql` per plugin. */
export const DEFAULT_SCHEMA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../schemas',
);

export interface LoadOptions {
  /** Directory of `<name>.graphql` snapshots. Default: repo `schemas/`. */
  schemaDir?: string;
}

export interface Gateway {
  schema: GraphQLSchema;
  statuses: PluginStatus[];
}

/** A plugin whose schema is already in hand (introspected, or local in tests). */
export interface LoadedPlugin {
  plugin: PluginConfig;
  schema: GraphQLSchema;
  /** Absent = execute against `schema` directly (tests). */
  executor?: ReturnType<typeof buildHTTPExecutor>;
}

/** Per-request context the yoga server provides. */
export interface GatewayContext {
  request?: { headers: { get(name: string): string | null } };
  /** Re-load every plugin and swap the served schema; backs `reloadPlugins`. */
  reload?: () => Promise<PluginStatus[]>;
}

/**
 * Drop the Subscription root (the apps serve subscriptions over graphql-ws,
 * which this HTTP gateway doesn't bridge yet — the page polls instead).
 * Removing the whole root type keeps the stitched schema valid; an empty
 * Subscription type would not be.
 */
function withoutSubscriptions(schema: GraphQLSchema): GraphQLSchema {
  const subscription = schema.getSubscriptionType();
  if (!subscription) return schema;
  const config = schema.toConfig();
  return new GraphQLSchema({
    ...config,
    subscription: null,
    types: config.types.filter((t) => t !== subscription),
  });
}

function makeExecutor(plugin: PluginConfig) {
  return buildHTTPExecutor({
    endpoint: plugin.url,
    headers: (executorRequest) => {
      const context = executorRequest?.context as GatewayContext | undefined;
      // The header *name* is per-plugin too — see resolveAuthHeaders.
      return resolveAuthHeaders(plugin, context?.request?.headers);
    },
  });
}

/** Namespace + merge already-loaded plugins into one schema. */
export function stitchLoaded(
  loaded: LoadedPlugin[],
  statuses: PluginStatus[],
): GraphQLSchema {
  const subschemas = loaded.map(({ plugin, schema, executor }) => ({
    schema: withoutSubscriptions(schema),
    ...(executor ? { executor } : {}),
    transforms: [
      new RenameTypes((name) => `${typePrefix(plugin)}${name}`),
      new RenameRootFields(
        (_operation, fieldName) => `${plugin.name}_${fieldName}`,
      ),
    ],
  }));

  const statusSchema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      "Gateway-side health of one stitched plugin."
      type PluginStatus {
        name: String!
        url: String!
        ok: Boolean!
        "INTROSPECTION, or SNAPSHOT when the app refused introspection."
        schemaSource: SchemaSource
        error: String
      }
      enum SchemaSource {
        INTROSPECTION
        SNAPSHOT
      }
      type Query {
        "The dashboard's plugin registry and whether each stitched in."
        plugins: [PluginStatus!]!
      }
      type Mutation {
        "Re-load every plugin's schema and swap the stitched schema in place."
        reloadPlugins: [PluginStatus!]!
      }
    `,
    resolvers: {
      Query: { plugins: () => statuses },
      PluginStatus: {
        schemaSource: (s: PluginStatus) => s.schemaSource?.toUpperCase(),
      },
      Mutation: {
        reloadPlugins: (_: unknown, __: unknown, ctx: GatewayContext) => {
          if (!ctx.reload) throw new Error('reload is not available here');
          return ctx.reload();
        },
      },
    },
  });

  return stitchSchemas({ subschemas: [...subschemas, statusSchema] });
}

/**
 * A plugin's schema, from introspection when the app allows it, else from its
 * snapshot. Apollo Server refuses introspection under NODE_ENV=production
 * (auto-cal, notes and philotes all take that default), and the apps must not
 * change to be stitched — so a production app is stitched from
 * `schemas/<name>.graphql`, while its queries still execute live against the
 * app. Refresh snapshots with `npm run schemas:snapshot` against a dev instance.
 *
 * Throws when neither works; the error names both failures.
 */
async function loadSchema(
  plugin: PluginConfig,
  executor: ReturnType<typeof buildHTTPExecutor>,
  schemaDir: string,
): Promise<{ schema: GraphQLSchema; source: SchemaSource; error?: string }> {
  let introspectionError: string;
  try {
    return {
      schema: await schemaFromExecutor(executor),
      source: 'introspection',
    };
  } catch (err) {
    introspectionError = message(err);
  }
  const file = path.join(schemaDir, `${plugin.name}.graphql`);
  let sdl: string;
  try {
    sdl = await readFile(file, 'utf8');
  } catch {
    throw new Error(`${introspectionError} (and no snapshot at ${file})`);
  }
  // A snapshot says nothing about whether the app is up; ask it something
  // every GraphQL server answers so a down app still reports down.
  const probe = (await executor({
    document: parse('{ __typename }'),
  })) as ExecutionResult;
  if (probe.errors?.length && !probe.data)
    throw new Error(probe.errors.map((e) => e.message).join('; '));
  return {
    schema: buildSchema(sdl),
    source: 'snapshot',
    error: `introspection refused: ${introspectionError}`,
  };
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * Load every plugin's schema and stitch the reachable ones. A plugin that is
 * down, or refuses introspection with no snapshot, is reported in `statuses`
 * and skipped — the dashboard keeps working with whatever is up. Call again
 * (the `reloadPlugins` mutation) to retry.
 */
export async function loadGateway(
  plugins: PluginConfig[],
  { schemaDir = DEFAULT_SCHEMA_DIR }: LoadOptions = {},
): Promise<Gateway> {
  const statuses: PluginStatus[] = [];
  const loaded: LoadedPlugin[] = [];

  await Promise.all(
    plugins.map(async (plugin) => {
      const executor = makeExecutor(plugin);
      try {
        const { schema, source, error } = await loadSchema(
          plugin,
          executor,
          schemaDir,
        );
        loaded.push({ plugin, schema, executor });
        statuses.push({
          name: plugin.name,
          url: plugin.url,
          ok: true,
          schemaSource: source,
          ...(error ? { error } : {}),
        });
      } catch (err) {
        statuses.push({
          name: plugin.name,
          url: plugin.url,
          ok: false,
          error: message(err),
        });
      }
    }),
  );

  // Stable order regardless of which load resolved first.
  statuses.sort((a, b) => a.name.localeCompare(b.name));
  loaded.sort((a, b) => a.plugin.name.localeCompare(b.plugin.name));

  return { schema: stitchLoaded(loaded, statuses), statuses };
}
