// Shared outbound-only transport. The standalone pilot uses memory; the daemon supplies encrypted authStore.
const GROUP_ID = /^\d+(?:-\d+)?@g\.us$/u;
const failure = (code) => Object.assign(new Error(code), { code });

export function normalizePilotPhone(value) {
  const phone = String(value || "").trim();
  if (!/^\+[1-9]\d{7,14}$/u.test(phone)) throw failure("INVALID_PHONE");
  return phone;
}

function memoryAuth(provider) {
  const values = new Map();
  return {
    creds: provider.initAuthCreds(),
    keys: {
      async get(type, ids) {
        const result = {};
        for (const id of ids) {
          let value = values.get(`${type}:${id}`);
          if (type === "app-state-sync-key" && value) value = provider.proto.Message.AppStateSyncKeyData.fromObject(value);
          result[id] = value;
        }
        return result;
      },
      async set(data) {
        for (const [type, items] of Object.entries(data)) {
          for (const [id, value] of Object.entries(items)) {
            if (value == null) values.delete(`${type}:${id}`);
            else values.set(`${type}:${id}`, value);
          }
        }
      },
    },
  };
}

async function loadBaileys() {
  const provider = await import("@whiskeysockets/baileys");
  // Explicit no-op logger: provider errors/keys/QR must never reach our terminal.
  const logger = { level: "silent", trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
  return { ...provider, logger };
}

export function createWhatsAppWebGroupSession({
  loadProvider = loadBaileys, authStore = null, clock = () => Date.now(), schedule = setTimeout, unschedule = clearTimeout,
} = {}) {
  let provider, auth, socket, generation = 0, retryTimer, retryCount = 0;
  let authWrites = Promise.resolve();
  let state = { phase: "disconnected", expectedPhone: null, connectedPhone: null, qr: null, qrAt: null, error: null };

  const detach = (target) => {
    target?.ev?.removeAllListeners?.("connection.update");
    target?.ev?.removeAllListeners?.("creds.update");
  };
  const reset = () => {
    generation += 1;
    if (retryTimer) unschedule(retryTimer);
    retryTimer = null;
    detach(socket);
    socket?.end?.(undefined);
    socket = null;
    auth = null;
    retryCount = 0;
    state = { phase: "disconnected", expectedPhone: null, connectedPhone: null, qr: null, qrAt: null, error: null };
  };

  async function openSocket(activeGeneration) {
    if (generation !== activeGeneration) return;
    const active = provider.default({
      auth, logger: provider.logger,
      browser: ["WAIA Notificações", "Chrome", "1.0.0"],
      markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
      // Ignore incoming conversations. This session is never an attendance bot.
      shouldIgnoreJid: () => true,
      connectTimeoutMs: 20_000, defaultQueryTimeoutMs: 15_000, qrTimeout: 60_000,
      getMessage: async () => undefined,
    });
    socket = active;
    active.ev.on("creds.update", (update) => {
      if (generation === activeGeneration && socket === active) {
        Object.assign(auth.creds, update);
        if (authStore) {
          const creds = structuredClone(auth.creds);
          authWrites = authWrites.then(() => authStore.saveCredentials(creds));
          void authWrites.catch(() => {
            if (generation === activeGeneration) { reset(); state.phase = "failed"; state.error = "AUTH_PERSISTENCE_FAILED"; }
          });
        }
      }
    });
    active.ev.on("connection.update", (update) => {
      void handleUpdate(update, active, activeGeneration).catch(() => {
        if (generation === activeGeneration) {
          reset();
          state.phase = "failed"; state.error = "CONNECTION_FAILED";
        }
      });
    });
  }

  async function handleUpdate(update, active, activeGeneration) {
    if (generation !== activeGeneration || socket !== active) return;
    if (update.qr) state = { ...state, phase: "qr", qr: update.qr, qrAt: clock(), error: null };
    if (update.connection === "open") {
      await authWrites;
      if (generation !== activeGeneration || socket !== active) return;
      const jid = provider.jidNormalizedUser(active.user?.id || "");
      const actual = `+${jid.split("@")[0]}`;
      if (actual !== state.expectedPhone) {
        generation += 1; detach(active);
        await active.logout?.().catch(() => {});
        await authStore?.clear?.().catch(() => {});
        active.end?.(undefined); socket = null; auth = null;
        state = { ...state, phase: "failed", connectedPhone: null, qr: null, qrAt: null, error: "NUMBER_MISMATCH" };
        return;
      }
      retryCount = 0;
      state = { ...state, phase: "connected", connectedPhone: actual, qr: null, qrAt: null, error: null };
    }
    if (update.connection === "close") {
      detach(active); socket = null;
      state = { ...state, phase: "reconnecting", connectedPhone: null, qr: null, qrAt: null };
      const reason = update.lastDisconnect?.error?.output?.statusCode;
      if (reason === provider.DisconnectReason.loggedOut || ++retryCount > 6) {
        if (reason === provider.DisconnectReason.loggedOut) {
          await authWrites.catch(() => {});
          await authStore?.clear?.().catch(() => {});
        }
        auth = null; state.phase = "failed"; state.error = "RELINK_REQUIRED";
        return;
      }
      const delay = reason === provider.DisconnectReason.restartRequired ? 100 : Math.min(1_000 * 2 ** (retryCount - 1), 30_000);
      retryTimer = schedule(() => {
        retryTimer = null;
        void openSocket(activeGeneration).catch(() => {
          if (generation === activeGeneration) { state.phase = "failed"; state.error = "CONNECTION_FAILED"; }
        });
      }, delay);
      retryTimer?.unref?.();
    }
  }

  function connected() {
    if (!socket || state.phase !== "connected") throw failure("NOT_CONNECTED");
    return socket;
  }

  async function groupMetadata(id) {
    if (!GROUP_ID.test(String(id || ""))) throw failure("INVALID_GROUP");
    const active = connected();
    let data;
    try { data = await active.groupMetadata(id); } catch { throw failure("GROUP_UNAVAILABLE"); }
    if (socket !== active || state.phase !== "connected") throw failure("NOT_CONNECTED");
    const own = data?.participants?.find((participant) => provider.jidNormalizedUser(participant.id) === provider.jidNormalizedUser(active.user.id)
      || (participant.phoneNumber && provider.jidNormalizedUser(participant.phoneNumber) === provider.jidNormalizedUser(active.user.id)));
    if (!own || data.id !== id) throw failure("GROUP_UNAVAILABLE");
    if (data.announce && !own.admin) throw failure("GROUP_SEND_FORBIDDEN");
    return { id, name: String(data.subject || "Grupo sem nome").slice(0, 128) };
  }

  return {
    snapshot() {
      const expired = state.qr && clock() - state.qrAt >= 55_000;
      return { ...state, ...(expired ? { phase: "qr_expired", qr: null } : {}) };
    },
    async connect(expectedPhone) {
      const phone = normalizePilotPhone(expectedPhone);
      if (!["disconnected", "failed"].includes(state.phase)) throw failure("ALREADY_CONNECTING");
      reset(); const activeGeneration = generation;
      state = { ...state, expectedPhone: phone, phase: "connecting" };
      try {
        provider = await loadProvider();
        if (generation !== activeGeneration) return;
        authWrites = Promise.resolve();
        auth = authStore ? await authStore.open(provider) : memoryAuth(provider);
        if (generation !== activeGeneration) return;
        if (authStore) await authStore.saveCredentials(auth.creds);
        if (generation !== activeGeneration) return;
        await openSocket(activeGeneration);
      } catch {
        if (generation === activeGeneration) { reset(); state.phase = "failed"; state.error = "PROVIDER_UNAVAILABLE"; }
        throw failure("PROVIDER_UNAVAILABLE");
      }
    },
    async listGroups() {
      const active = connected(); let groups;
      try { groups = await active.groupFetchAllParticipating(); } catch { throw failure("GROUPS_UNAVAILABLE"); }
      if (socket !== active || state.phase !== "connected") throw failure("NOT_CONNECTED");
      return Object.values(groups).filter((group) => GROUP_ID.test(group.id)).map((group) => ({
        id: group.id, name: String(group.subject || "Grupo sem nome").slice(0, 128),
      })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    },
    groupMetadata,
    async sendText(id, text) {
      // Caller must validate metadata before recording the attempt. No retry after send begins.
      const active = connected();
      if (!GROUP_ID.test(id) || typeof text !== "string" || !text || text.length > 4096) throw failure("INVALID_MESSAGE");
      try {
        const result = await active.sendMessage(id, { text }, { useCachedGroupMetadata: false });
        if (typeof result?.key?.id !== "string" || !result.key.id) throw failure("SEND_UNCONFIRMED");
        return { messageId: result.key.id };
      } catch { throw failure("SEND_UNCONFIRMED"); }
    },
    async disconnect() {
      const active = socket;
      const linked = state.phase === "connected";
      let revoked = false;
      if (linked) {
        generation += 1; detach(active); state.phase = "disconnecting";
        try { await active.logout(); revoked = true; } catch { /* remove manually on phone */ }
      }
      reset();
      return { revoked };
    },
    close: reset,
    flushAuth: () => authWrites,
  };
}
