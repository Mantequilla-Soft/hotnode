const path = require('path');

const ROOT = path.join(__dirname, '../..');

// config.js exits the process without this, and there's no .env in CI.
process.env.SUPERNODE_API = process.env.SUPERNODE_API || 'http://supernode.test';

/**
 * Replace a project module in require's cache so later requires get `exports`.
 * Must be called before the module under test is required.
 */
function stubModule(relPath, exports) {
  const resolved = require.resolve(path.join(ROOT, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  return exports;
}

/** Require a project module fresh, dropping any cached copy first. */
function loadFresh(relPath) {
  const resolved = require.resolve(path.join(ROOT, relPath));
  delete require.cache[resolved];
  return require(resolved);
}

// The real logger writes to logs/*.log; keep tests off the filesystem.
const logs = [];
const silentLogger = stubModule('utils/logger', {
  info: (...a) => logs.push(['info', ...a]),
  warn: (...a) => logs.push(['warn', ...a]),
  error: (...a) => logs.push(['error', ...a]),
  debug: () => {}
});

/** Minimal Express-style response that records status and JSON body. */
function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

/** Find a route handler on an express.Router by method and path. */
function routeHandler(router, method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${routePath} route`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

module.exports = { stubModule, loadFresh, fakeRes, routeHandler, logs, silentLogger };
