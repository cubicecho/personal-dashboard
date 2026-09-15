/**
 * Refresh the committed schema snapshots in `schemas/<name>.graphql`.
 *
 * The gateway stitches a plugin from its snapshot only when the app refuses
 * introspection — which Apollo Server does under NODE_ENV=production — so
 * point this at a *dev* instance of each app (NODE_ENV unset) running the
 * same version as the image the stack deploys:
 *
 *   npm run schemas:snapshot                    # every registered plugin
 *   npm run schemas:snapshot -- autocal notes   # just these
 *   PLUGIN_AUTOCAL_URL=http://localhost:3001/graphql npm run schemas:snapshot -- autocal
 *
 * A stale snapshot fails loudly rather than silently: queries still execute
 * against the live app, which rejects fields it no longer has.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildHTTPExecutor } from '@graphql-tools/executor-http';
import { schemaFromExecutor } from '@graphql-tools/wrap';
import { lexicographicSortSchema, printSchema } from 'graphql';
import { DEFAULT_SCHEMA_DIR } from '../src/gateway.ts';
import { loadPlugins, resolveAuthHeaders } from '../src/plugins.ts';

const only = process.argv.slice(2);
const plugins = loadPlugins().filter(
  (p) => only.length === 0 || only.includes(p.name),
);
const unknown = only.filter((name) => !plugins.some((p) => p.name === name));
if (unknown.length) {
  console.error(`unknown plugin(s): ${unknown.join(', ')}`);
  process.exit(1);
}

await mkdir(DEFAULT_SCHEMA_DIR, { recursive: true });
let failed = false;
for (const plugin of plugins) {
  try {
    const schema = await schemaFromExecutor(
      buildHTTPExecutor({
        endpoint: plugin.url,
        headers: resolveAuthHeaders(plugin),
      }),
    );
    const file = path.join(DEFAULT_SCHEMA_DIR, `${plugin.name}.graphql`);
    await writeFile(
      file,
      `# Schema snapshot of the ${plugin.name} plugin. The gateway uses it only when
# the app refuses introspection (NODE_ENV=production). Regenerate with
#   npm run schemas:snapshot -- ${plugin.name}

${printSchema(lexicographicSortSchema(schema))}
`,
    );
    console.log(`  ✓ ${plugin.name} ← ${plugin.url}`);
  } catch (err) {
    failed = true;
    console.error(
      `  ✗ ${plugin.name} ← ${plugin.url} (${err instanceof Error ? err.message : err})`,
    );
  }
}
// Snapshotting everything tolerates apps that aren't running; naming one
// means you expected it to work.
if (failed && only.length) process.exitCode = 1;
