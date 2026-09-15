/**
 * End-to-end over the real stack: a fixture plugin, the real loadPlugins →
 * loadGateway → express+yoga app. Covers what the unit tests can't — that
 * introspection, per-request auth headers, reloadPlugins' schema swap and the
 * degradation path actually work over HTTP.
 *
 * Hermetic: the fixture binds an ephemeral port, so nothing needs to be
 * running and the test is CI-safe.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { createApp, loadGatewaySafely } from '../src/http.ts';
import { loadPlugins } from '../src/plugins.ts';
import { type FakePlugin, startFakePlugin } from './fixtures/fake-plugin.ts';

describe('dashboard server over HTTP', () => {
  let plugin: FakePlugin;
  let pluginUrl: string;
  let pluginPort: number;
  let server: Server;
  let base: string;

  before(async () => {
    // Claim an ephemeral port, then release it: the gateway must boot with the
    // plugin *down* so we can prove reloadPlugins picks it up later.
    const probe = await startFakePlugin();
    pluginUrl = probe.url;
    pluginPort = probe.port;
    await probe.close();

    // The real registry, exercising env registration of a brand-new plugin.
    // Filtered to the fixture so the four localhost defaults can't make the
    // test depend on what happens to be running on this machine.
    // Two registrations of the same fixture endpoint: one plain, one reading
    // its credential from a custom header the way eunomia does.
    const plugins = loadPlugins({
      PLUGIN_FAKE_URL: pluginUrl,
      PLUGIN_KEYED_URL: pluginUrl,
      PLUGIN_KEYED_AUTH_HEADER: 'x-api-key',
    }).filter((p) => p.name === 'fake' || p.name === 'keyed');
    assert.deepEqual(
      plugins.map((p) => [p.name, p.authHeader]),
      [
        ['fake', undefined],
        ['keyed', 'x-api-key'],
      ],
    );

    const app = createApp(plugins, await loadGatewaySafely(plugins));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  after(async () => {
    await plugin?.close();
    await new Promise((r) => server.close(r));
  });

  const gql = (query: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query }),
    }).then((r) => r.json() as Promise<{ data?: unknown; errors?: unknown[] }>);

  test('boots with the plugin down and reports it, rather than crashing', async () => {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.deepEqual(
      health.plugins.map((p: { name: string; ok: boolean }) => [p.name, p.ok]),
      [
        ['fake', false],
        ['keyed', false],
      ],
    );
    assert.ok(health.plugins[0].error, 'a down plugin records why');
  });

  const reload = () =>
    gql('mutation { reloadPlugins { name ok schemaSource } }') as Promise<{
      data?: { reloadPlugins: { name: string; ok: boolean }[] };
      errors?: unknown[];
    }>;

  test('reload while still down succeeds and keeps reporting it down', async () => {
    const body = await reload();
    assert.equal(body.errors, undefined);
    assert.equal(body.data?.reloadPlugins[0].ok, false);
  });

  test('reloadPlugins picks up a plugin that came up, no restart', async () => {
    plugin = await startFakePlugin(pluginPort);
    const body = await reload();
    assert.equal(body.errors, undefined);
    assert.equal(body.data?.reloadPlugins[0].ok, true);

    // The schema behind `schema: () => gateway.schema` really swapped.
    assert.deepEqual((await gql('{ fake_me }')).data, { fake_me: 'fake-user' });
  });

  test('x-<plugin>-token reaches the upstream as an Authorization header', async () => {
    const body = await gql('{ fake_whoami }', { 'x-fake-token': 'abc' });
    assert.deepEqual(body.data, { fake_whoami: 'Bearer abc' });
  });

  test('a plugin with a custom auth header gets the raw credential', async () => {
    // No `Bearer ` scheme: eunomia hands an x-api-key value straight to
    // verifyApiKey, so a prefix would make the key fail to verify.
    const body = await gql('{ keyed_header(name: "x-api-key") }', {
      'x-keyed-token': 'dk_abc',
    });
    assert.deepEqual(body.data, { keyed_header: 'dk_abc' });

    // …and it does not also land on Authorization.
    const other = await gql('{ keyed_whoami }', { 'x-keyed-token': 'dk_abc' });
    assert.deepEqual(other.data, { keyed_whoami: '(none)' });
  });

  test('a custom-header plugin still receives a passthrough Authorization', async () => {
    // A bearer session token belongs on Authorization for that app too;
    // renaming it onto x-api-key would strip the only header verifying it.
    const body = await gql('{ keyed_whoami }', {
      authorization: 'Bearer sess',
    });
    assert.deepEqual(body.data, { keyed_whoami: 'Bearer sess' });
  });

  test("the caller's own Authorization header is forwarded verbatim", async () => {
    const body = await gql('{ fake_whoami }', {
      authorization: 'Bearer passthru',
    });
    assert.deepEqual(body.data, { fake_whoami: 'Bearer passthru' });
  });

  test('with no credentials at all, nothing is invented', async () => {
    assert.deepEqual((await gql('{ fake_whoami }')).data, {
      fake_whoami: '(none)',
    });
  });

  test('the dashboard page is served', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /dashboard\.js/);
  });
});
