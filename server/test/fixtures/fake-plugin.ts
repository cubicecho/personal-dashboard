/**
 * The smallest possible dashboard plugin: any GraphQL endpoint. Used by the
 * HTTP smoke test (test/smoke.test.ts), which starts it on an ephemeral port;
 * run standalone with
 *   PORT=4321 node test/fixtures/fake-plugin.ts
 * then register it via PLUGIN_FAKE_URL=http://localhost:4321/graphql.
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { NoSchemaIntrospectionCustomRule, printSchema } from 'graphql';
import { type Plugin, createYoga } from 'graphql-yoga';

const schema = makeExecutableSchema({
  typeDefs: /* GraphQL */ `
    type Query {
      me: String
      "Echoes the Authorization header the plugin received — auth passthrough proof."
      whoami: String
      "Echoes any received header, for plugins that read a custom one (x-api-key)."
      header(name: String!): String
    }
  `,
  resolvers: {
    Query: {
      me: () => 'fake-user',
      whoami: (_src, _args, ctx) =>
        ctx.request.headers.get('authorization') ?? '(none)',
      header: (_src, args: { name: string }, ctx) =>
        ctx.request.headers.get(args.name) ?? '(none)',
    },
  },
});

/** The fixture's SDL — what a committed `schemas/<name>.graphql` would hold. */
export const fakePluginSdl = printSchema(schema);

export interface FakePlugin {
  /** The /graphql endpoint to hand to PLUGIN_<NAME>_URL. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Start the fixture. Port 0 (the default) picks a free one — tests can run
 * concurrently and need nothing listening beforehand. `introspection: false`
 * mimics an Apollo app under NODE_ENV=production. */
export function startFakePlugin(
  port = 0,
  { introspection = true }: { introspection?: boolean } = {},
): Promise<FakePlugin> {
  const refuseIntrospection: Plugin = {
    onValidate({ addValidationRule }) {
      addValidationRule(NoSchemaIntrospectionCustomRule);
    },
  };
  const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    plugins: introspection ? [] : [refuseIntrospection],
  });
  const server = createServer(yoga);
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound =
        typeof address === 'object' && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${bound}/graphql`,
        port: bound,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((err) => (err ? fail(err) : done())),
          ),
      });
    });
  });
}

// Standalone mode: `node test/fixtures/fake-plugin.ts`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startFakePlugin(Number(process.env.PORT ?? 4321));
  console.log(`fake plugin on :${port}`);
}
