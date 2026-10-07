import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql, printSchema } from 'graphql';
import {
  type PluginStatus,
  loadGateway,
  stitchLoaded,
} from '../src/gateway.ts';
import { loadPlugins, resolveAuthHeaders } from '../src/plugins.ts';
import { fakePluginSdl, startFakePlugin } from './fixtures/fake-plugin.ts';

// Two fixture apps that collide the way the real ones do: both define a
// `Note` type, a `me` root field, and a `requestMagicLink` mutation.
const appA = makeExecutableSchema({
  typeDefs: /* GraphQL */ `
    type Note { id: ID!, title: String! }
    type Query { me: String, notes: [Note!]! }
    type Mutation { requestMagicLink(email: String!): Boolean! }
    type Subscription { dataChanged: String! }
  `,
  resolvers: {
    Query: { me: () => 'alice@a', notes: () => [{ id: '1', title: 'from A' }] },
    Mutation: { requestMagicLink: () => true },
  },
});
const appB = makeExecutableSchema({
  typeDefs: /* GraphQL */ `
    type Note { id: ID!, body: String! }
    type Query { me: String, notes: [Note!]! }
    type Mutation { requestMagicLink(email: String!): Boolean! }
  `,
  resolvers: {
    Query: { me: () => 'alice@b', notes: () => [{ id: '9', body: 'from B' }] },
  },
});

const statuses: PluginStatus[] = [
  { name: 'aaa', url: 'local', ok: true },
  { name: 'bbb', url: 'local', ok: true },
];
const stitched = stitchLoaded(
  [
    { plugin: { name: 'aaa', url: 'local' }, schema: appA },
    { plugin: { name: 'bbb', url: 'local' }, schema: appB },
  ],
  statuses,
);

test('colliding types and root fields coexist under prefixes', async () => {
  const sdl = printSchema(stitched);
  assert.match(sdl, /type AaaNote/);
  assert.match(sdl, /type BbbNote/);
  assert.doesNotMatch(sdl, /\btype Note\b/);

  const result = await graphql({
    schema: stitched,
    source: '{ aaa_me bbb_me aaa_notes { title } bbb_notes { body } }',
  });
  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    aaa_me: 'alice@a',
    bbb_me: 'alice@b',
    aaa_notes: [{ title: 'from A' }],
    bbb_notes: [{ body: 'from B' }],
  });
});

test('colliding mutations are prefixed; subscriptions are dropped', async () => {
  const sdl = printSchema(stitched);
  assert.match(sdl, /aaa_requestMagicLink/);
  assert.match(sdl, /bbb_requestMagicLink/);
  assert.doesNotMatch(sdl, /dataChanged/);
});

test('gateway-local plugins field reports statuses', async () => {
  const result = await graphql({
    schema: stitched,
    source: '{ plugins { name ok } }',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    plugins: [
      { name: 'aaa', ok: true },
      { name: 'bbb', ok: true },
    ],
  });
});

const headers = (map: Record<string, string>) => ({
  get: (name: string) => map[name.toLowerCase()] ?? null,
});

test('resolveAuthHeaders priority: x-token header, then env, then authorization', () => {
  const plugin = { name: 'notes', url: 'local' };

  assert.deepEqual(
    resolveAuthHeaders(plugin, headers({ 'x-notes-token': 'cet_abc' }), {}),
    { authorization: 'Bearer cet_abc' },
  );
  assert.deepEqual(
    resolveAuthHeaders(plugin, headers({}), { PLUGIN_NOTES_TOKEN: 'cet_env' }),
    { authorization: 'Bearer cet_env' },
  );
  assert.deepEqual(
    resolveAuthHeaders(
      plugin,
      headers({ authorization: 'Bearer passthru' }),
      {},
    ),
    { authorization: 'Bearer passthru' },
  );
  assert.deepEqual(resolveAuthHeaders(plugin, headers({}), {}), {});
});

test('resolveAuthHeaders: a custom auth header gets the raw credential', () => {
  // eunomia reads `x-api-key`, and hands the value straight to verifyApiKey —
  // a `Bearer ` scheme there would make the key fail to verify.
  const plugin = { name: 'eunomia', url: 'local', authHeader: 'x-api-key' };

  assert.deepEqual(
    resolveAuthHeaders(plugin, headers({ 'x-eunomia-token': 'dk_abc' }), {}),
    { 'x-api-key': 'dk_abc' },
  );
  assert.deepEqual(
    resolveAuthHeaders(plugin, headers({}), { PLUGIN_EUNOMIA_TOKEN: 'dk_env' }),
    { 'x-api-key': 'dk_env' },
  );
  // The caller's own Authorization stays on Authorization: it is a bearer
  // session token, and renaming it would strip the only header that verifies it.
  assert.deepEqual(
    resolveAuthHeaders(plugin, headers({ authorization: 'Bearer sess' }), {}),
    { authorization: 'Bearer sess' },
  );
});

test('loadPlugins: env overrides defaults and registers new plugins', () => {
  const plugins = loadPlugins({
    PLUGIN_NOTES_URL: 'http://elsewhere:9999/graphql',
    PLUGIN_WEATHER_URL: 'http://weather:1234/graphql',
  });
  assert.equal(
    plugins.find((p) => p.name === 'notes')?.url,
    'http://elsewhere:9999/graphql',
  );
  assert.equal(
    plugins.find((p) => p.name === 'weather')?.url,
    'http://weather:1234/graphql',
  );
  assert.equal(plugins.filter((p) => p.name === 'notes').length, 1);
});

test('loadPlugins: auth header defaults per plugin and is env-overridable', () => {
  const plugins = loadPlugins({
    PLUGIN_EUNOMIA_AUTH_HEADER: 'x-other-key',
    PLUGIN_WEATHER_URL: 'http://weather:1234/graphql',
    PLUGIN_WEATHER_AUTH_HEADER: 'x-api-key',
  });
  assert.equal(
    plugins.find((p) => p.name === 'eunomia')?.authHeader,
    'x-other-key',
  );
  assert.equal(
    plugins.find((p) => p.name === 'weather')?.authHeader,
    'x-api-key',
  );
  // Plugins that say nothing keep the Authorization default.
  assert.equal(plugins.find((p) => p.name === 'notes')?.authHeader, undefined);
});

test('loadPlugins: eunomia defaults to x-api-key', () => {
  // Its only non-expiring credential (a registerDevice device key) is accepted
  // on that header alone.
  assert.equal(
    loadPlugins({}).find((p) => p.name === 'eunomia')?.authHeader,
    'x-api-key',
  );
});

test('loadPlugins: a name that is not a legal GraphQL name is rejected', () => {
  // `2fa_myField` / `2faNote` would not parse, so the whole stitched schema
  // would fail to build — fail here, named, instead of opaquely at stitch time.
  assert.throws(
    () => loadPlugins({ PLUGIN_2FA_URL: 'http://x/graphql' }),
    /PLUGIN_2FA_URL: '2fa' is not a valid GraphQL name prefix/,
  );
  // Underscores are legal in a GraphQL name, so this one registers.
  assert.equal(
    loadPlugins({ PLUGIN_MY_APP_URL: 'http://x/graphql' }).find(
      (p) => p.name === 'my_app',
    )?.url,
    'http://x/graphql',
  );
});

test('loadGateway: an unreachable plugin is reported and skipped, the rest stitch', async () => {
  const live = await startFakePlugin();
  // Claim an ephemeral port and release it — nothing is listening there.
  const dead = await startFakePlugin();
  const deadUrl = dead.url;
  await dead.close();

  try {
    // Deliberately reverse-ordered so the sort is doing real work, and the
    // live plugin is the one that resolves last.
    const gateway = await loadGateway([
      { name: 'zzz', url: live.url },
      { name: 'aaa', url: deadUrl },
    ]);

    assert.deepEqual(
      gateway.statuses.map((s) => [s.name, s.ok]),
      [
        ['aaa', false],
        ['zzz', true],
      ],
      'statuses come back name-sorted regardless of which introspection won',
    );
    assert.ok(gateway.statuses[0].error, 'the dead plugin records why');
    assert.equal(gateway.statuses[1].error, undefined);

    // The reachable plugin still works, and only its fields exist.
    const result = await graphql({
      schema: gateway.schema,
      source: '{ zzz_me plugins { name ok } }',
    });
    assert.equal(result.errors, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
      zzz_me: 'fake-user',
      plugins: [
        { name: 'aaa', ok: false },
        { name: 'zzz', ok: true },
      ],
    });
    assert.doesNotMatch(printSchema(gateway.schema), /aaa_me/);
  } finally {
    await live.close();
  }
});

test('an app refusing introspection is stitched from its snapshot, executed live', async () => {
  const closed = await startFakePlugin(0, { introspection: false });
  const schemaDir = await mkdtemp(path.join(tmpdir(), 'pd-schemas-'));
  try {
    const plugin = { name: 'fake', url: closed.url };

    // No snapshot: reported down, and the error says why it had no fallback.
    const bare = await loadGateway([plugin], { schemaDir });
    assert.equal(bare.statuses[0].ok, false);
    assert.match(bare.statuses[0].error ?? '', /no snapshot/);

    await writeFile(path.join(schemaDir, 'fake.graphql'), fakePluginSdl);
    const gateway = await loadGateway([plugin], { schemaDir });
    assert.equal(gateway.statuses[0].ok, true);
    assert.equal(gateway.statuses[0].schemaSource, 'snapshot');
    assert.match(gateway.statuses[0].error ?? '', /introspection refused/);

    const result = await graphql({
      schema: gateway.schema,
      source: '{ fake_me plugins { name schemaSource } }',
    });
    assert.equal(result.errors, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
      fake_me: 'fake-user',
      plugins: [{ name: 'fake', schemaSource: 'SNAPSHOT' }],
    });
  } finally {
    await closed.close();
    await rm(schemaDir, { recursive: true, force: true });
  }
});

test('a snapshot does not make a down app look up', async () => {
  const probe = await startFakePlugin();
  await probe.close();
  const schemaDir = await mkdtemp(path.join(tmpdir(), 'pd-schemas-'));
  try {
    await writeFile(path.join(schemaDir, 'fake.graphql'), fakePluginSdl);
    const gateway = await loadGateway([{ name: 'fake', url: probe.url }], {
      schemaDir,
    });
    assert.equal(gateway.statuses[0].ok, false);
    assert.equal(gateway.statuses[0].schemaSource, undefined);
  } finally {
    await rm(schemaDir, { recursive: true, force: true });
  }
});

test('introspection wins over a snapshot when the app allows it', async () => {
  const open = await startFakePlugin();
  const schemaDir = await mkdtemp(path.join(tmpdir(), 'pd-schemas-'));
  try {
    // A deliberately wrong snapshot proves it was never read.
    await writeFile(
      path.join(schemaDir, 'fake.graphql'),
      'type Query { stale: String }',
    );
    const gateway = await loadGateway([{ name: 'fake', url: open.url }], {
      schemaDir,
    });
    assert.equal(gateway.statuses[0].schemaSource, 'introspection');
    assert.match(printSchema(gateway.schema), /fake_whoami/);
    assert.doesNotMatch(printSchema(gateway.schema), /fake_stale/);
  } finally {
    await open.close();
    await rm(schemaDir, { recursive: true, force: true });
  }
});
