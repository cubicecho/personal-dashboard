/**
 * The plugin registry: every app that appears on the dashboard is one entry
 * here. Each plugin is an ordinary GraphQL endpoint that the gateway
 * introspects and stitches in under a prefix, so nothing in the source app
 * changes and name collisions across apps (`Note`, `me`, the magic-link
 * mutations…) are impossible by construction.
 *
 * Adding a plugin = one entry in DEFAULT_PLUGINS, or zero code at all:
 * setting `PLUGIN_<NAME>_URL` in the environment registers a new plugin named
 * `<name>` at runtime. `PLUGIN_<NAME>_TOKEN` supplies a server-side token.
 * `<NAME>` must be a legal GraphQL name (it becomes a field/type prefix);
 * anything else throws at startup rather than failing opaquely at stitch time.
 */

export interface PluginConfig {
  /** Slug used for the root-field prefix (`<name>_myTodos`), the type prefix
   * (capitalized), the `x-<name>-token` header, and the env var names. */
  name: string;
  /** The app's existing GraphQL endpoint. */
  url: string;
}

const DEFAULT_PLUGINS: PluginConfig[] = [
  { name: 'autocal', url: 'http://localhost:3001/graphql' },
  { name: 'notes', url: 'http://localhost:3002/graphql' },
  { name: 'philotes', url: 'http://localhost:3003/graphql' },
  { name: 'eunomia', url: 'http://localhost:4000/graphql' },
];

const URL_ENV = /^PLUGIN_(.+)_URL$/;

/** GraphQL's Name grammar. A plugin name is interpolated straight into
 * `<name>_field` and `<Name>Type`, so a name that isn't a legal Name makes
 * the whole stitched schema fail to build. */
const GRAPHQL_NAME = /^[_a-z][_0-9a-z]*$/;

/** DEFAULT_PLUGINS with env URL overrides, plus any PLUGIN_<NAME>_URL that
 * names a plugin not in the defaults. */
export function loadPlugins(
  env: NodeJS.ProcessEnv = process.env,
): PluginConfig[] {
  const plugins = DEFAULT_PLUGINS.map((p) => ({
    ...p,
    url: env[`PLUGIN_${p.name.toUpperCase()}_URL`] ?? p.url,
  }));
  for (const [key, value] of Object.entries(env)) {
    const match = URL_ENV.exec(key);
    if (!match || !value) continue;
    const name = match[1].toLowerCase();
    if (!GRAPHQL_NAME.test(name))
      throw new Error(
        `${key}: '${name}' is not a valid GraphQL name prefix — a plugin name must match ${GRAPHQL_NAME.source}`,
      );
    if (!plugins.some((p) => p.name === name))
      plugins.push({ name, url: value });
  }
  return plugins;
}

/** `autocal` → `Autocal` — the type-name prefix. */
export function typePrefix(plugin: PluginConfig): string {
  return plugin.name.charAt(0).toUpperCase() + plugin.name.slice(1);
}

/**
 * The Authorization header to send upstream for one plugin, per request.
 * Priority: browser-supplied `x-<name>-token` header (the dashboard page's
 * settings panel) → server-side `PLUGIN_<NAME>_TOKEN` env → the caller's own
 * `Authorization` header, forwarded verbatim. The gateway never mints
 * identity — each app verifies whatever token it receives exactly as it does
 * standalone.
 */
export function resolveAuthHeader(
  plugin: PluginConfig,
  requestHeaders?: { get(name: string): string | null },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const token =
    requestHeaders?.get(`x-${plugin.name}-token`) ??
    env[`PLUGIN_${plugin.name.toUpperCase()}_TOKEN`];
  if (token) return /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
  return requestHeaders?.get('authorization') ?? undefined;
}
