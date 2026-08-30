import { createApp, loadGatewaySafely } from './http.ts';
import { loadPlugins } from './plugins.ts';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const plugins = loadPlugins();

const gateway = await loadGatewaySafely(plugins);
for (const s of gateway.statuses) {
  console.log(
    s.ok ? `  ✓ ${s.name} ← ${s.url}` : `  ✗ ${s.name} ← ${s.url} (${s.error})`,
  );
}

createApp(plugins, gateway).listen(PORT, HOST, () => {
  console.log(
    `personal-dashboard on http://${HOST}:${PORT} (graphiql at /graphql)`,
  );
});
