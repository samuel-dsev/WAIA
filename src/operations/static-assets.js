import express from 'express';

// Only files used by the shipped interfaces belong on the HTTP surface.
// Local pilots, backups and untracked experiments must never become assets.
export const STATIC_ASSETS = Object.freeze({
  panel: Object.freeze(["index.html","app.js","styles.css","attendance-script.js","group-notifier.js","onboarding.js","ai-usage.js"]),
  portal: Object.freeze(["index.html","app.js","styles.css"]),
});

export const PANEL_CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-src blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
export const PORTAL_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

export function createStaticAssetRouter({ surface, directory }) {
  if (!STATIC_ASSETS[surface]) throw new TypeError('Superfície estática inválida.');
  const allowed = new Set(['/', ...STATIC_ASSETS[surface].map(file => `/${file}`)]);
  const router = express.Router();
  router.use((request, response, next) => {
    response.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': surface === 'panel' ? PANEL_CSP : PORTAL_CSP,
    });
    const path = request.url.split('?', 1)[0];
    if (!['GET', 'HEAD'].includes(request.method) || !allowed.has(path)) return response.sendStatus(404);
    return next();
  });
  router.use(express.static(directory, { index: 'index.html', dotfiles: 'deny', fallthrough: false }));
  return router;
}
