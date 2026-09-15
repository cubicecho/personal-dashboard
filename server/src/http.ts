/**
 * The dashboard's HTTP surface: /graphql (yoga over the stitched schema),
 * /health, and the static page. Kept out of index.ts so tests can
 * drive the real app without binding a port at import time.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createYoga } from 'graphql-yoga';
import {
  type Gateway,
  type LoadOptions,
  type PluginStatus,
  loadGateway,
  stitchLoaded,
} from './gateway.ts';
import type { PluginConfig } from './plugins.ts';

const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../app',
);

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * A gateway that stitched nothing, every plugin reported failed. Serves the
 * status-only schema so /health, reloadPlugins and the page keep working when a load
 * throws outright.
 */
function failedGateway(plugins: PluginConfig[], error: string): Gateway {
  const statuses: PluginStatus[] = plugins
    .map((p) => ({ name: p.name, url: p.url, ok: false, error }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { schema: stitchLoaded([], statuses), statuses };
}

/**
 * loadGateway already degrades per plugin; this catches the one failure it
 * doesn't — stitching itself throwing on a malformed upstream schema — so a
 * bad app can't take the whole dashboard down at boot. reloadPlugins recovers.
 */
export async function loadGatewaySafely(
  plugins: PluginConfig[],
  options?: LoadOptions,
): Promise<Gateway> {
  try {
    return await loadGateway(plugins, options);
  } catch (err) {
    console.error(`stitch failed, serving no plugins: ${message(err)}`);
    return failedGateway(plugins, message(err));
  }
}

/** The express app, starting from an already-loaded gateway. */
export function createApp(
  plugins: PluginConfig[],
  initial: Gateway,
  options?: LoadOptions,
) {
  let gateway = initial;

  // Re-load every plugin — picks up apps that were down at boot and schema
  // changes, no restart needed. Assigned only on success: a failed reload
  // keeps the schema that was already working rather than a half-built one.
  // Exposed as the `reloadPlugins` mutation, not a REST route, so every
  // client→server call stays on /graphql.
  const reload = async () => {
    try {
      gateway = await loadGateway(plugins, options);
      return gateway.statuses;
    } catch (err) {
      console.error(`reload failed: ${message(err)}`);
      throw err;
    }
  };

  const yoga = createYoga({
    // Function so reloadPlugins can swap the schema without restarting.
    schema: () => gateway.schema,
    context: { reload },
    graphqlEndpoint: '/graphql',
    // Upstream errors (bad token, app down) are the dashboard's UX — show them.
    maskedErrors: false,
  });

  const app = express();
  app.use('/graphql', yoga);

  // NOT GraphQL, deliberately: a liveness probe for docker/uptime checks, which
  // can't speak GraphQL. The page itself reads the `plugins` query instead.
  app.get('/health', (_req, res) => {
    res.json({ ok: true, plugins: gateway.statuses });
  });

  app.use(express.static(APP_DIR));
  return app;
}
