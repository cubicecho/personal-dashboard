/**
 * Builds the stitched "supergraph": one executable schema that namespaces and
 * merges every reachable plugin, plus a local `plugins` status field.
 *
 * Per plugin: introspect its endpoint → wrap as a subschema whose types get a
 * `<Name>` prefix and whose root fields get a `<name>_` prefix → stitch.
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
import { GraphQLSchema } from 'graphql';
import {
  type PluginConfig,
  resolveAuthHeaders,
  typePrefix,
} from './plugins.ts';

export interface PluginStatus {
  name: string;
  url: string;
  ok: boolean;
  error?: string;
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
interface GatewayContext {
  request?: { headers: { get(name: string): string | null } };
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
        error: String
      }
      type Query {
        "The dashboard's plugin registry and whether each stitched in."
        plugins: [PluginStatus!]!
      }
    `,
    resolvers: { Query: { plugins: () => statuses } },
  });

  return stitchSchemas({ subschemas: [...subschemas, statusSchema] });
}

/**
 * Introspect every plugin and stitch the reachable ones. A plugin that is
 * down or refuses introspection is reported in `statuses` and skipped — the
 * dashboard keeps working with whatever is up. Call again (POST /reload) to
 * retry.
 */
export async function loadGateway(plugins: PluginConfig[]): Promise<Gateway> {
  const statuses: PluginStatus[] = [];
  const loaded: LoadedPlugin[] = [];

  await Promise.all(
    plugins.map(async (plugin) => {
      const executor = makeExecutor(plugin);
      try {
        const schema = await schemaFromExecutor(executor);
        loaded.push({ plugin, schema, executor });
        statuses.push({ name: plugin.name, url: plugin.url, ok: true });
      } catch (err) {
        statuses.push({
          name: plugin.name,
          url: plugin.url,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  // Stable order regardless of which introspection resolved first.
  statuses.sort((a, b) => a.name.localeCompare(b.name));
  loaded.sort((a, b) => a.plugin.name.localeCompare(b.plugin.name));

  return { schema: stitchLoaded(loaded, statuses), statuses };
}
