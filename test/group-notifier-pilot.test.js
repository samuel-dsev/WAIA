import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { request } from "node:http";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { createWhatsAppWebGroupSession } from "../src/integrations/whatsapp-web/group-session.js";
import { createGroupNotifierPilot } from "../src/modules/group-notifier/pilot-service.js";
import { createGroupNotifierPilotApp } from "../src/modules/group-notifier/pilot-http.js";

const PHONE = "+5511999990001", GROUP_A = "120363000000001@g.us", GROUP_B = "120363000000002@g.us";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function connectionFixture() {
  const sockets = [], timers = [], calls = [];
  let now = 0;
  const jidNormalizedUser = (value) => String(value || "").replace(/:\d+@/u, "@");
  const provider = {
    initAuthCreds: () => ({}), jidNormalizedUser, logger: {},
    proto: { Message: { AppStateSyncKeyData: { fromObject: (value) => value } } },
    DisconnectReason: { loggedOut: 401, restartRequired: 515 },
    default(options) {
      const socket = {
        options, ev: new EventEmitter(), user: { id: `${PHONE.slice(1)}:1@s.whatsapp.net` },
        metadata: { id: GROUP_A, subject: "Grupo Filaretti", participants: [{ id: `${PHONE.slice(1)}@s.whatsapp.net`, admin: null }] },
        async groupMetadata(id) { calls.push(["metadata", id]); return { ...this.metadata, id }; },
        async groupFetchAllParticipating() { return { [GROUP_A]: this.metadata }; },
        async sendMessage(id, message) { calls.push(["send", id, message]); return { key: { id: "message-synthetic" } }; },
        async logout() { calls.push(["logout"]); }, end() { calls.push(["end"]); },
      };
      sockets.push(socket); return socket;
    },
  };
  const session = createWhatsAppWebGroupSession({ loadProvider: async () => provider, clock: () => now,
    schedule: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    unschedule: (timer) => { timer.cancelled = true; },
  });
  return { session, calls, sockets, timers, advance: (value) => { now += value; },
    async open() { await session.connect(PHONE); sockets.at(-1).ev.emit("connection.update", { connection: "open" }); await tick(); },
  };
}

test("piloto confere o número dedicado, não responde a entradas e mantém credenciais só em memória", async () => {
  const f = connectionFixture(); await f.open();
  assert.equal(f.session.snapshot().phase, "connected");
  const socket = f.sockets[0];
  assert.equal(socket.options.syncFullHistory, false);
  assert.equal(socket.options.shouldSyncHistoryMessage({}), false);
  assert.equal(socket.options.shouldIgnoreJid(GROUP_A), true);
  assert.equal(socket.ev.listenerCount("messages.upsert"), 0);
  await socket.options.auth.keys.set({ test: { key: Buffer.from("synthetic") } });
  assert.deepEqual((await socket.options.auth.keys.get("test", ["key"])).key, Buffer.from("synthetic"));
  await socket.options.auth.keys.set({ test: { key: null } });
  assert.equal((await socket.options.auth.keys.get("test", ["key"])).key, undefined);
  await f.session.disconnect();
  assert.deepEqual(f.calls.slice(-2), [["logout"], ["end"]]);
  assert.equal(f.session.snapshot().phase, "disconnected");
});

test("QR lido por outro número é recusado e revogado", async () => {
  const f = connectionFixture(); await f.session.connect(PHONE);
  f.sockets[0].user.id = "5511999990002@s.whatsapp.net";
  f.sockets[0].ev.emit("connection.update", { connection: "open" }); await tick();
  assert.equal(f.session.snapshot().error, "NUMBER_MISMATCH");
  assert.equal(f.session.snapshot().connectedPhone, null);
  assert.ok(f.calls.some(([action]) => action === "logout"));
  await assert.rejects(f.session.listGroups(), { code: "NOT_CONNECTED" });
});

test("QR expira e evento de socket antigo não recupera uma sessão encerrada", async () => {
  const f = connectionFixture(); await f.session.connect(PHONE);
  f.sockets[0].ev.emit("connection.update", { qr: "synthetic-qr" });
  assert.equal(f.session.snapshot().qr, "synthetic-qr");
  f.advance(55_000); assert.equal(f.session.snapshot().qr, null);
  assert.equal(f.session.snapshot().phase, "qr_expired");
  f.sockets[0].ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
  assert.equal(f.timers[0].delay, 100);
  f.session.close(); assert.equal(f.timers[0].cancelled, true);
  f.timers[0].callback(); await tick(); assert.equal(f.sockets.length, 1);
});

test("adapter exige participação e permissão no grupo, recusando destinatário individual", async () => {
  const f = connectionFixture(); await f.open();
  await assert.rejects(f.session.groupMetadata("5511999990002@s.whatsapp.net"), { code: "INVALID_GROUP" });
  f.sockets[0].metadata.participants = [];
  await assert.rejects(f.session.groupMetadata(GROUP_A), { code: "GROUP_UNAVAILABLE" });
  f.sockets[0].metadata.participants = [{ id: `${PHONE.slice(1)}@s.whatsapp.net`, admin: null }];
  f.sockets[0].metadata.announce = true;
  await assert.rejects(f.session.groupMetadata(GROUP_A), { code: "GROUP_SEND_FORBIDDEN" });
  f.sockets[0].metadata.participants[0].admin = "admin";
  assert.equal((await f.session.groupMetadata(GROUP_A)).id, GROUP_A);
  f.session.close();
});

function routingFixture() {
  const calls = [], session = {
    snapshot: () => ({ phase: "connected", qr: "synthetic-qr", qrAt: 0, expectedPhone: PHONE, connectedPhone: PHONE }),
    async groupMetadata(id) { calls.push(["metadata", id]); return { id, name: id === GROUP_A ? "Grupo Filaretti" : "Grupo ALFATECH" }; },
    async sendText(id, text) { calls.push(["send", id, text]); return { messageId: "synthetic-message" }; },
    async connect() {}, async disconnect() { return { revoked: true }; }, async listGroups() { return []; },
  };
  return { session, calls, service: createGroupNotifierPilot({ session }) };
}

test("remetente central usa apenas o destino configurado para cada empresa", async () => {
  const f = routingFixture();
  await f.service.configureRoute({ companyRef: "filaretti", companyName: "Filaretti", groupId: GROUP_A });
  await f.service.configureRoute({ companyRef: "alfatech", companyName: "ALFATECH", groupId: GROUP_B });
  await assert.rejects(f.service.configureRoute({ companyRef: "outra", companyName: "Outra", groupId: GROUP_A }), { code: "GROUP_ALREADY_ASSIGNED" });
  await assert.rejects(f.service.sendTest("desconhecida"), { code: "ROUTE_NOT_FOUND" });
  await f.service.sendTest("filaretti"); await f.service.sendTest("alfatech");
  const sends = f.calls.filter(([action]) => action === "send");
  assert.deepEqual(sends.map(([, id]) => id), [GROUP_A, GROUP_B]);
  assert.match(sends[0][2], /Empresa: Filaretti/u);
  assert.doesNotMatch(sends[0][2], /ALFATECH/u);
  for (const field of ["Nome:", "Resumo do caso:", "Qualificação:", "Número do lead:", "DADOS FICTÍCIOS"]) assert.ok(sends[0][2].includes(field));
  const data = f.service.snapshot();
  assert.equal(data.connection.expectedPhone, "••••0001"); assert.equal(data.connection.qr, undefined);
});

test("resultado incerto não é reenviado, mesmo depois de desconectar e refazer o destino", async () => {
  const f = routingFixture();
  f.session.sendText = async () => { f.calls.push(["send"]); throw new Error("provider-secret-must-not-leak"); };
  const route = { companyRef: "filaretti", companyName: "Filaretti", groupId: GROUP_A };
  await f.service.configureRoute(route);
  assert.equal((await f.service.sendTest("filaretti")).status, "unconfirmed");
  await f.service.sendTest("filaretti");
  await f.service.disconnect(); await f.service.configureRoute(route); await f.service.sendTest("filaretti");
  assert.equal(f.calls.filter(([action]) => action === "send").length, 1);
  assert.doesNotMatch(JSON.stringify(f.service.snapshot()), /provider-secret/u);
});

test("alteração de destino e segundo envio são recusados durante o envio", async () => {
  const f = routingFixture(); let release;
  const pending = new Promise((resolve) => { release = resolve; });
  f.session.sendText = async () => { await pending; return { messageId: "synthetic" }; };
  await f.service.configureRoute({ companyRef: "filaretti", companyName: "Filaretti", groupId: GROUP_A });
  await f.service.configureRoute({ companyRef: "alfatech", companyName: "ALFATECH", groupId: GROUP_B });
  const send = f.service.sendTest("filaretti"); await tick();
  await assert.rejects(f.service.configureRoute({ companyRef: "filaretti", companyName: "Filaretti", groupId: GROUP_B }), { code: "BUSY" });
  await assert.rejects(f.service.sendTest("alfatech"), { code: "BUSY" });
  assert.equal((await f.service.sendTest("filaretti")).status, "sending");
  release(); assert.equal((await send).status, "accepted");
});

test("perda da participação no grupo impede o teste antes de tentar enviar", async () => {
  const f = routingFixture();
  await f.service.configureRoute({ companyRef: "filaretti", companyName: "Filaretti", groupId: GROUP_A });
  f.session.groupMetadata = async () => { throw Object.assign(new Error("GROUP_UNAVAILABLE"), { code: "GROUP_UNAVAILABLE" }); };
  await assert.rejects(f.service.sendTest("filaretti"), { code: "GROUP_UNAVAILABLE" });
  assert.equal(f.service.snapshot().attempts.length, 0);
  assert.equal(f.calls.filter(([action]) => action === "send").length, 0);
});

test("console local protege QR e mutações com origem, host e CSRF", async (t) => {
  const f = routingFixture();
  const app = createGroupNotifierPilotApp({ service: f.service, session: f.session, renderQr: async () => "data:image/png;base64,synthetic" });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(url); assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
  const html = await page.text(), token = html.match(/name="pilot-csrf" content="([a-f0-9]+)"/u)[1];
  assert.equal((await fetch(`${url}/app.js`)).status, 200);
  assert.equal((await fetch(`${url}/api/qr`)).status, 403);
  const headers = { "X-Pilot-CSRF": token, "Content-Type": "application/json" };
  assert.equal((await fetch(`${url}/api/qr`, { headers: { ...headers, Origin: "https://untrusted.example" } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${url}/api/qr`, { headers: { ...headers, Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${url}/api/qr`, { headers: { ...headers, "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await fetch(`${url}/api/qr`, { headers })).status, 200);
  const reject = await fetch(`${url}/api/connect`, { method: "POST", headers, body: JSON.stringify({ phone: PHONE }) });
  assert.equal((await reject.json()).error, "DEDICATED_NUMBER_REQUIRED");
  const status = JSON.stringify(await (await fetch(`${url}/api/status`, { headers })).json());
  assert.doesNotMatch(status, /synthetic-qr|5511999990001/u);
});

test("processo do piloto suprime logs diretos de bibliotecas e erros privados não tratados", async () => {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const script = new URL("../scripts/group-notifier-pilot.mjs", import.meta.url).href;
  const code = `await import(${JSON.stringify(script)}); setTimeout(() => { console.info({ auth: 'synthetic-private-session' }); console.warn('synthetic-private-qr'); process.emit('unhandledRejection', new Error('synthetic-private-error')); }, 100);`;
  const result = await new Promise((resolve) => {
    execFile(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, WAIA_NOTIFIER_PILOT_PORT: String(port) }, timeout: 20_000,
    }, (error, stdout, stderr) => resolve({ exit: error ? error.code || error.signal || "FAILED" : 0, stdout, stderr }));
  });
  assert.equal(result.exit, 1);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /synthetic-private/u);
  assert.match(result.stderr, /Falha interna no piloto/u);
});
