import { createWhatsAppWebGroupSession } from "../src/integrations/whatsapp-web/group-session.js";
import { createGroupNotifierPilot } from "../src/modules/group-notifier/pilot-service.js";
import { createGroupNotifierPilotApp } from "../src/modules/group-notifier/pilot-http.js";
import QRCode from "qrcode";

// libsignal can log entire cryptographic sessions via console independently of
// Baileys' logger. Suppress provider output in this isolated pilot process only.
const announce = console.log.bind(console), report = console.error.bind(console);
for (const method of ["log", "info", "warn", "error", "debug", "trace", "dir"]) console[method] = () => {};

const port = Number(process.env.WAIA_NOTIFIER_PILOT_PORT || "3210");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Porta local inválida.");
const session = createWhatsAppWebGroupSession();
const service = createGroupNotifierPilot({ session });
const app = createGroupNotifierPilotApp({ service, session, renderQr: (qr) => QRCode.toDataURL(qr, { width: 320, margin: 2 }) });
const server = app.listen(port, "127.0.0.1", () => {
  // Never log QR, auth material, full phone number, group IDs or provider errors.
  announce(`Piloto local de notificações WAIA: http://127.0.0.1:${port}`);
});
server.on("error", () => { report("Não foi possível abrir a porta local do piloto."); process.exitCode = 1; session.close(); });
const fatal = () => {
  report("Falha interna no piloto. Reinicie o serviço local antes de tentar novamente.");
  session.close(); server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 1000).unref();
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { session.close(); server.close(() => process.exit(0)); });
}
