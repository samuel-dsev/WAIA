import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import {
  extractMessages,
  markWhatsAppMessageRead,
  sendWhatsAppReply,
  whatsappReadiness,
} from "./whatsapp.js";
import { createBarService } from "./bar-service.js";
import { GoogleSheetsClient } from "./google-sheets.js";
import { SheetDataService } from "./sheet-data.js";
import { BarAiAssistant } from "./ai-assistant.js";

const webhookApp = express();
const publicDirectory = fileURLToPath(new URL("../public", import.meta.url));
const sheetsClient = new GoogleSheetsClient(config.googleSheets);
const sheetData = new SheetDataService({
  client: sheetsClient,
  intervalMs: config.googleSheets.syncIntervalMs,
});
const aiAssistant = new BarAiAssistant(config.openai);
const barService = createBarService({ dataSource: sheetData, aiAssistant });
sheetData.start();
const processedWhatsAppMessages = new Set();
const MAX_PROCESSED_MESSAGES = 1_000;
const whatsappStats = {
  received: 0,
  duplicates: 0,
  sent: 0,
  failed: 0,
  lastReceivedAt: null,
  lastSentAt: null,
  lastError: null,
};

function publicError(error) {
  if (error.code === "ECONNRESET") return "Não foi possível concluir a operação. Verifique a internet e tente novamente.";
  return "Não foi possível responder agora. Tente novamente em alguns instantes.";
}

const jsonParser = express.json({
    limit: "1mb",
    verify: (request, _response, buffer) => {
      request.rawBody = buffer;
    },
  });

webhookApp.use(jsonParser);

webhookApp.get("/privacy", (_request, response) => {
  response.sendFile("privacy.html", { root: publicDirectory });
});

webhookApp.get("/data-deletion", (_request, response) => {
  response.sendFile("data-deletion.html", { root: publicDirectory });
});

function validMetaSignature(request) {
  if (!config.whatsapp.appSecret) return true;
  const signature = request.get("x-hub-signature-256");
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", config.whatsapp.appSecret).update(request.rawBody).digest("hex")}`;
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

webhookApp.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    whatsapp: whatsappReadiness(),
    googleSheets: sheetData.diagnostics(),
    openai: { configured: aiAssistant.configured, model: config.openai.model },
  });
});

webhookApp.get("/api/google-sheets/status", (_request, response) => {
  response.json(sheetData.diagnostics());
});

webhookApp.post("/api/google-sheets/sync", async (_request, response) => {
  if (!sheetData.configured) return response.status(503).json({ error: "Google Sheets não configurado." });
  try {
    await sheetData.sync();
    response.json(sheetData.diagnostics());
  } catch (error) {
    response.status(502).json({ error: error.message, ...sheetData.diagnostics() });
  }
});

webhookApp.get("/api/whatsapp/status", (_request, response) => {
  response.json({
    readiness: whatsappReadiness(),
    activity: whatsappStats,
  });
});

webhookApp.get("/webhook", (request, response) => {
  if (
    request.query["hub.mode"] === "subscribe" &&
    request.query["hub.verify_token"] === config.whatsapp.verifyToken
  ) {
    return response.status(200).send(request.query["hub.challenge"]);
  }
  response.sendStatus(403);
});

webhookApp.post("/webhook", (request, response) => {
  if (!validMetaSignature(request)) return response.sendStatus(401);
  const messages = extractMessages(request.body);
  response.sendStatus(200);

  for (const message of messages) {
    console.log("Mensagem recebida do WhatsApp:", { type: message.type, option: message.text });
    whatsappStats.received += 1;
    whatsappStats.lastReceivedAt = new Date().toISOString();
    if (message.id && processedWhatsAppMessages.has(message.id)) {
      whatsappStats.duplicates += 1;
      continue;
    }
    if (message.id) {
      processedWhatsAppMessages.add(message.id);
      if (processedWhatsAppMessages.size > MAX_PROCESSED_MESSAGES) {
        const oldestId = processedWhatsAppMessages.values().next().value;
        processedWhatsAppMessages.delete(oldestId);
      }
    }

    void (async () => {
      try {
        if (message.id) {
          try {
            await markWhatsAppMessageRead(message.id);
          } catch (error) {
            console.warn("Não foi possível marcar a mensagem como lida; continuando com a resposta:", error.message);
          }
        }
        const reply = await barService.reply({
          phone: message.phone,
          message: message.text,
          type: message.type,
          mediaId: message.mediaId,
        });
        await sendWhatsAppReply(message.phone, reply);
        whatsappStats.sent += 1;
        whatsappStats.lastSentAt = new Date().toISOString();
        whatsappStats.lastError = null;
      } catch (error) {
        whatsappStats.failed += 1;
        whatsappStats.lastError = error.message;
        console.error("Falha ao processar mensagem do WhatsApp:", error);
      }
    })();
  }
});

const webhookServer = webhookApp.listen(config.webhookPort, () => {
  console.log(`Webhook do WhatsApp disponível localmente em http://localhost:${config.webhookPort}/webhook`);
  console.log(`WhatsApp: ${whatsappReadiness().credentialsConfigured ? "credenciais carregadas" : "aguardando credenciais"}`);
  console.log(`OpenAI: ${aiAssistant.configured ? `configurada (${config.openai.model})` : "aguardando OPENAI_API_KEY"}`);
});

webhookServer.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`A porta do webhook ${config.webhookPort} já está sendo usada por outro processo.`);
    return;
  }
  console.error("Não foi possível iniciar o webhook do WhatsApp:", error);
});
