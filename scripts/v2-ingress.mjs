import { createV2Ingress } from '../src/operations/v2-ingress.js';

// Global installation settings only. No customer is configured through this entrypoint.
const port = Number(process.env.V2_INGRESS_PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Porta V2 inválida.');
const server = createV2Ingress({
  surface: process.env.V2_INGRESS_SURFACE,
  origin: process.env.V2_INGRESS_ORIGIN,
  upstream: process.env.V2_INGRESS_UPSTREAM,
  adminPeerAllowlist: process.env.V2_INGRESS_ADMIN_PEER_ALLOWLIST,
  trustedProxyPeers: process.env.V2_INGRESS_TRUSTED_PROXY_PEERS,
  allowInsecure: process.env.NODE_ENV === 'test' && process.env.V2_INGRESS_LOCAL_TEST === 'true',
});
server.listen(port, '0.0.0.0', () => console.log('Gateway V2 iniciado com superfície explícita.'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
