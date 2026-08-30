/**
 * The dashboard's HTTP surface: /graphql (yoga over the stitched schema),
 * /health, /reload, and the static page. Kept out of index.ts so tests can
 * drive the real app without binding a port at import time.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createYoga } from 'graphql-yoga';
import {
  type Gateway,
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
 * status-only schema so /health, /reload and the page keep working when a load
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
 * bad app can't take the whole dashboard down at boot. POST /reload recovers.
 */
export async function loadGatewaySafely(
  plugins: PluginConfig[],
): Promise<Gateway> {
  try {
    return await loadGateway(plugins);
  } catch (err) {
    console.error(`stitch failed, serving no plugins: ${message(err)}`);
    return failedGateway(plugins, message(err));
  }
}

/** The express app, starting from an already-loaded gateway. */
export function createApp(plugins: PluginConfig[], initial: Gateway) {
  let gateway = initial;

  const yoga = createYoga({
    // Function so POST /reload can swap the schema without restarting.
    schema: () => gateway.schema,
    graphqlEndpoint: '/graphql',
    // Upstream errors (bad token, app down) are the dashboard's UX — show them.
    maskedErrors: false,
  });

  const app = express();
  app.use('/graphql', yoga);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, plugins: gateway.statuses });
  });

  // Re-introspect every plugin — picks up apps that were down at boot and
  // schema changes, no restart needed.
  app.post('/reload', async (_req, res) => {
    try {
      // Assigned only on success: a failed reload keeps the schema that was
      // already working rather than leaving a half-built one behind.
      gateway = await loadGateway(plugins);
      res.json({ ok: true, plugins: gateway.statuses });
    } catch (err) {
      // express 4 does not catch rejected promises from async handlers; without
      // this the request hangs and the process gets an unhandled rejection.
      console.error(`reload failed: ${message(err)}`);
      res
        .status(503)
        .json({ ok: false, error: message(err), plugins: gateway.statuses });
    }
  });

  app.use(express.static(APP_DIR));
  return app;
}
