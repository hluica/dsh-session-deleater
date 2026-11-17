/**
 * Host-half contract probe for dsh-session-deleater.
 *
 * Verifies the Loader identity, required injections, the owner-only API route,
 * and a minimal `/health` response. Startup recovery is intentionally not run
 * here: it touches the real profile home and is covered by functional acceptance.
 *
 * @module scripts/host-contract
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runProbe } from './lib/probe-runner.mjs';

/**
 * Assert the Host-half contract.
 * @param context - `{ root, patchId, check }`.
 * @returns `{ identity }`.
 */
export async function probeHost({ root, patchId, check }) {
  process.env.DSH_HOME = join(root, '.probe-home');
  const mod = await import(pathToFileURL(join(root, 'index.js')).href);

  check('exports apply()', typeof mod.apply === 'function');
  const strings = Object.entries(mod).filter(([, value]) => typeof value === 'string');
  const identity = strings.find(([, value]) => value === patchId)?.[1];
  check(`an exported id constant equals the patch id (${patchId})`, identity !== undefined, `exported strings: ${strings.map(([name]) => name).join(', ') || 'none'}`);
  check('exports the required Host injections',
    Array.isArray(mod.inject)
      && ['webServer', 'connection', 'sessionPersistence'].every(name => mod.inject.includes(name)),
    JSON.stringify(mod.inject));

  const routes = [];
  const effects = [];
  const injections = [];
  let response;
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    get() { return undefined; },
    effect(callback) {
      const cleanup = callback();
      effects.push(cleanup);
      return () => { if (typeof cleanup === 'function') cleanup(); };
    },
    inject(dependencies, callback) {
      injections.push(dependencies);
      // Do not run startup recovery against the host profile during a probe.
    },
    on() { return () => {}; },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    connection: {
      admit() { return { peer: { principal: { kind: 'owner' } } }; },
    },
  };

  mod.apply(ctx);

  check('registers exactly one prefix route', routes.length === 1 && routes[0].kind === 'prefix', JSON.stringify(routes));
  check('the route owns /session-deleater/api', routes[0]?.path === '/session-deleater/api', JSON.stringify(routes[0]));
  check('requests sessionPersistence for startup recovery', injections.some(deps => deps.includes('sessionPersistence')), JSON.stringify(injections));

  await routes[0].handler(
    { method: 'GET', url: '/session-deleater/api/health', headers: {} },
    res,
  );
  response = res.body === undefined ? undefined : JSON.parse(res.body);
  check('answers /health with ok', res.status === 200 && response?.ok === true, JSON.stringify(response));
  check('reports its API prefix and capabilities', response?.result?.api === '/session-deleater/api' && typeof response?.result?.capabilities === 'object', JSON.stringify(response?.result));
  check('does not claim hot readiness without live services', response?.result?.hotReady === false, JSON.stringify(response?.result));

  for (const cleanup of effects) {
    if (typeof cleanup === 'function') await cleanup();
  }

  return { identity };
}

runProbe(import.meta.url, probeHost);
