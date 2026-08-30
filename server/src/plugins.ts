/**
 * The plugin registry: every app that appears on the dashboard is one entry
 * here. Each plugin is an ordinary GraphQL endpoint that the gateway
 * introspects and stitches in under a prefix, so nothing in the source app
 * changes and name collisions across apps (`Note`, `me`, the magic-link
 * mutations…) are impossible by construction.
 *
 * Adding a plugin = one entry in DEFAULT_PLUGINS, or zero code at all:
 * setting `PLUGIN_<NAME>_URL` in the environment registers a new plugin named
 * `<name>` at runtime. `PLUGIN_<NAME>_TOKEN` supplies a server-side token and
 * `PLUGIN_<NAME>_AUTH_HEADER` the header it rides in.
 * `<NAME>` must be a legal GraphQL name (it becomes a field/type prefix);
 * anything else throws at startup rather than failing opaquely at stitch time.
 */

export interface PluginConfig {
  /** Slug used for the root-field prefix (`<name>_myTodos`), the type prefix
   * (capitalized), the `x-<name>-token` header, and the env var names. */
  name: string;
  /** The app's existing GraphQL endpoint. */
  url: string;
  /** Header this app reads its credential from. Default `authorization`,
   * which also gets a `Bearer ` scheme; any other header (eunomia's
   * `x-api-key`) receives the bare credential, since a custom header carries
   * no scheme. */
  authHeader?: string;
}

const DEFAULT_AUTH_HEADER = 'authorization';

const DEFAULT_PLUGINS: PluginConfig[] = [
  { name: 'autocal', url: 'http://localhost:3001/graphql' },
  { name: 'notes', url: 'http://localhost:3002/graphql' },
  { name: 'philotes', url: 'http://localhost:3003/graphql' },
  // eunomia reads `x-api-key` before falling back to a session bearer, and the
  // only non-expiring credential it issues (a device key from `registerDevice`)
  // is only accepted there. See its apps/server/src/app.ts context factory.
  {
    name: 'eunomia',
    url: 'http://localhost:4000/graphql',
    authHeader: 'x-api-key',
  },
];

const URL_ENV = /^PLUGIN_(.+)_URL$/;

/** GraphQL's Name grammar. A plugin name is interpolated straight into
 * `<name>_field` and `<Name>Type`, so a name that isn't a legal Name makes
 * the whole stitched schema fail to build. */
const GRAPHQL_NAME = /^[_a-z][_0-9a-z]*$/;

const authHeaderEnv = (name: string, env: NodeJS.ProcessEnv) =>
  env[`PLUGIN_${name.toUpperCase()}_AUTH_HEADER`];

/** DEFAULT_PLUGINS with env URL/auth-header overrides, plus any
 * PLUGIN_<NAME>_URL that names a plugin not in the defaults. */
export function loadPlugins(
  env: NodeJS.ProcessEnv = process.env,
): PluginConfig[] {
  const plugins = DEFAULT_PLUGINS.map((p) => ({
    ...p,
    url: env[`PLUGIN_${p.name.toUpperCase()}_URL`] ?? p.url,
    authHeader: authHeaderEnv(p.name, env) ?? p.authHeader,
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
      plugins.push({ name, url: value, authHeader: authHeaderEnv(name, env) });
  }
  return plugins;
}

/** `autocal` → `Autocal` — the type-name prefix. */
export function typePrefix(plugin: PluginConfig): string {
  return plugin.name.charAt(0).toUpperCase() + plugin.name.slice(1);
}

/**
 * The auth headers to send upstream for one plugin, per request — `{}` when
 * there is no credential to send. The gateway never mints identity: each app
 * verifies whatever token it receives exactly as it does standalone.
 *
 * A credential addressed to *this* plugin — the browser's `x-<name>-token`
 * header (the page's settings panel) or the server-side `PLUGIN_<NAME>_TOKEN`
 * env — goes in the plugin's own `authHeader`, `Bearer `-prefixed only for
 * `authorization` (a custom header like `x-api-key` wants the raw key).
 *
 * Failing that, the caller's own `Authorization` is forwarded verbatim, and
 * stays on `authorization` — it is a bearer token, so renaming it onto a
 * custom header would only strip the one app that could verify it.
 */
export function resolveAuthHeaders(
  plugin: PluginConfig,
  requestHeaders?: { get(name: string): string | null },
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const header = (plugin.authHeader ?? DEFAULT_AUTH_HEADER).toLowerCase();
  const token =
    requestHeaders?.get(`x-${plugin.name}-token`) ??
    env[`PLUGIN_${plugin.name.toUpperCase()}_TOKEN`];
  if (token)
    return {
      [header]:
        header === DEFAULT_AUTH_HEADER && !/^bearer\s/i.test(token)
          ? `Bearer ${token}`
          : token,
    };
  const passthrough = requestHeaders?.get('authorization');
  return passthrough ? { [DEFAULT_AUTH_HEADER]: passthrough } : {};
}
