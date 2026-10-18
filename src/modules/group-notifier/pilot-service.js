const failure = (code) => Object.assign(new Error(code), { code });
const reference = (value) => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)) throw failure("INVALID_COMPANY");
  return value;
};

export function createGroupNotifierPilot({ session, clock = () => new Date() } = {}) {
  const routes = new Map(), attempts = new Map();
  let busy = false;

  function snapshot() {
    const { qr, qrAt, expectedPhone, connectedPhone, ...connection } = session.snapshot();
    const masked = (value) => value ? `••••${value.slice(-4)}` : null;
    return {
      connection: { ...connection, expectedPhone: masked(expectedPhone), connectedPhone: masked(connectedPhone) },
      busy, routes: [...routes.values()], attempts: [...attempts.values()],
    };
  }

  return {
    snapshot,
    async connect(phone) {
      if (busy) throw failure("BUSY");
      if (routes.size) throw failure("DISCONNECT_FIRST");
      busy = true;
      try { await session.connect(phone); } finally { busy = false; }
    },
    async disconnect() {
      if (busy) throw failure("BUSY");
      busy = true;
      try {
        const result = await session.disconnect();
        routes.clear(); // attempts intentionally remain visible for manual reconciliation
        return result;
      } finally { busy = false; }
    },
    async listGroups() {
      return session.listGroups();
    },
    async configureRoute({ companyRef, companyName, groupId }) {
      const ref = reference(companyRef);
      if (typeof companyName !== "string" || !companyName.trim() || companyName.length > 100 || /[\r\n\p{Cc}]/u.test(companyName)) throw failure("INVALID_COMPANY");
      if (busy) throw failure("BUSY");
      busy = true;
      try {
        if ([...routes.values()].some((route) => route.groupId === groupId && route.companyRef !== ref)) throw failure("GROUP_ALREADY_ASSIGNED");
        const group = await session.groupMetadata(groupId);
        const route = { companyRef: ref, companyName: companyName.trim(), groupId: group.id, groupName: group.name };
        routes.set(ref, route);
        return route;
      } finally { busy = false; }
    },
    async sendTest(companyRef) {
      const ref = reference(companyRef), route = routes.get(ref);
      if (!route) throw failure("ROUTE_NOT_FOUND");
      const attemptKey = `${ref}:${route.groupId}`;
      if (attempts.has(attemptKey)) return attempts.get(attemptKey);
      if (busy) throw failure("BUSY");
      busy = true;
      try {
        // Authoritative membership/permissions check, not just the cached group selector.
        await session.groupMetadata(route.groupId);
        const attempt = { companyRef: ref, groupId: route.groupId, groupName: route.groupName, status: "sending", createdAt: clock().toISOString() };
        attempts.set(attemptKey, attempt);
        const text = `[TESTE WAIA — DADOS FICTÍCIOS]\n\nEmpresa: ${route.companyName}\nNome: Lead fictício de teste\nResumo do caso: Simulação para validar o envio ao grupo correto.\nQualificação: Triagem fictícia concluída; requer análise humana.\nNúmero do lead: +55 (00) 00000-0000\n\nEsta mensagem é um teste de conexão. Nenhum lead real foi enviado.`;
        try {
          const result = await session.sendText(route.groupId, text);
          attempt.status = "accepted"; attempt.messageId = result.messageId;
        } catch {
          // Network failure may happen after WhatsApp accepts the message. Never auto-retry.
          attempt.status = "unconfirmed";
        }
        return attempt;
      } finally { busy = false; }
    },
  };
}
