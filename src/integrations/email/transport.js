export class FakeEmailTransport {
  constructor({ environment }) {
    if (!['test','development'].includes(environment)) throw new Error('E-mail fake proibido neste ambiente.');
    this.messages = new Map();
  }
  async send(message) { this.messages.set(message.idempotencyKey, structuredClone(message)); }
}

// Contrato para gateway transacional da plataforma. URL/remetente nao sao controlados por tenants.
export class HttpEmailTransport {
  constructor({ endpoint, token, from, fetchImpl = fetch }) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || !token || !from) throw new Error('Gateway de e-mail inválido.');
    Object.assign(this, { endpoint, token, from, fetchImpl });
  }
  async send(message) {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}`, 'idempotency-key': message.idempotencyKey },
      body: JSON.stringify({ from: this.from, to: message.to, template: message.purpose, variables: { url: message.url } }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('EMAIL_DELIVERY_FAILED');
  }
}

export function startAccountEmailWorker(service, transport, { intervalMs = 5000 } = {}) {
  let pending = null;
  const tick = () => {
    if (!pending) pending = service.deliverNext(transport).catch(() => {}).finally(() => { pending = null; });
  };
  const timer = setInterval(tick, intervalMs); timer.unref(); tick();
  return { async close() { clearInterval(timer); await pending; } };
}
