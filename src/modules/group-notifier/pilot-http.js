import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import express from "express";
import helmet from "helmet";

const ui = new URL("../../../panel/group-notifier-pilot/", import.meta.url);
const messages = {
  INVALID_PHONE: "Informe o número dedicado em formato internacional, por exemplo +5511999999999.",
  DEDICATED_NUMBER_REQUIRED: "Confirme que está usando o número dedicado da WAIA.",
  ALREADY_CONNECTING: "A conexão já está em andamento. Aguarde ou desconecte antes de reiniciar.",
  DISCONNECT_FIRST: "Desconecte o piloto antes de trocar de número.",
  PROVIDER_UNAVAILABLE: "Não foi possível iniciar o conector local.",
  CONNECTION_FAILED: "Não foi possível conectar. Tente novamente pelo painel.",
  NUMBER_MISMATCH: "O QR foi lido por outro número. O vínculo foi recusado; use o número dedicado informado.",
  RELINK_REQUIRED: "A conexão foi encerrada. Inicie um novo vínculo por QR.",
  NOT_CONNECTED: "Conecte o número dedicado antes de selecionar um grupo.",
  INVALID_GROUP: "Selecione um grupo válido.", GROUP_UNAVAILABLE: "O número não tem acesso confirmado a esse grupo.",
  GROUP_SEND_FORBIDDEN: "Esse grupo só permite mensagens de administradores. O bot precisa ter permissão de envio.",
  GROUPS_UNAVAILABLE: "Não foi possível consultar os grupos. Tente novamente após a conexão estabilizar.",
  GROUP_ALREADY_ASSIGNED: "Esse grupo já foi associado a outra empresa no piloto.",
  INVALID_COMPANY: "Informe uma referência simples e um nome válido para a empresa de teste.",
  ROUTE_NOT_FOUND: "Configure o grupo dessa empresa primeiro.", BUSY: "Há uma operação em andamento. Aguarde.",
};

export function createGroupNotifierPilotApp({ service, session, renderQr } = {}) {
  const app = express(), csrf = randomBytes(32).toString("hex");
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null,
  } }, strictTransportSecurity: false }));
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    if (req.get("host") !== `127.0.0.1:${req.socket.localPort}`
      || (req.get("origin") && req.get("origin") !== origin)
      || ["cross-site", "same-site"].includes(req.get("sec-fetch-site"))) return res.status(403).json({ error: "LOCAL_ACCESS_ONLY" });
    if (req.path.startsWith("/api/")) {
      const value = Buffer.from(req.get("x-pilot-csrf") || "");
      const expected = Buffer.from(csrf);
      if (value.length !== expected.length || !timingSafeEqual(value, expected)) return res.status(403).json({ error: "INVALID_CSRF" });
    }
    next();
  });
  app.use(express.json({ limit: "4kb", strict: true }));
  app.get("/", async (_req, res) => {
    const html = await readFile(new URL("index.html", ui), "utf8");
    res.type("html").send(html.replace("__PILOT_CSRF__", csrf));
  });
  for (const file of ["app.js", "styles.css"]) {
    app.get(`/${file}`, async (_req, res) => {
      res.type(file.endsWith("js") ? "js" : "css").send(await readFile(new URL(file, ui), "utf8"));
    });
  }
  app.get("/api/status", (_req, res) => {
    const data = service.snapshot();
    res.json({ ...data, connection: { ...data.connection, message: messages[data.connection.error] || null } });
  });
  app.get("/api/qr", async (_req, res) => {
    const { qr } = session.snapshot();
    res.json({ image: qr ? await renderQr(qr) : null });
  });
  app.post("/api/connect", async (req, res) => {
    if (req.body?.dedicated !== true) throw Object.assign(new Error("DEDICATED_NUMBER_REQUIRED"), { code: "DEDICATED_NUMBER_REQUIRED" });
    await service.connect(req.body.phone);
    res.json({ started: true });
  });
  app.post("/api/disconnect", async (_req, res) => res.json(await service.disconnect()));
  app.get("/api/groups", async (_req, res) => res.json({ groups: await service.listGroups() }));
  app.post("/api/routes", async (req, res) => res.json(await service.configureRoute(req.body)));
  app.post("/api/test", async (req, res) => res.json(await service.sendTest(req.body?.companyRef)));
  app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  app.use((error, _req, res, _next) => {
    const known = messages[error.code];
    res.status(known ? 409 : 400).json({ error: known ? error.code : "INVALID_REQUEST", message: known || "Não foi possível concluir a operação." });
  });
  return app;
}
