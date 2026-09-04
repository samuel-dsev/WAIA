import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

test("painel oferece superfícies administrativas reais e responsivas", async () => {
  const [html, css, js] = await Promise.all([
    readFile(new URL("../panel/index.html", import.meta.url), "utf8"),
    readFile(new URL("../panel/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../panel/app.js", import.meta.url), "utf8"),
  ]);
  for (const label of ["Empresas", "Contatos", "Conversas", "Pedidos", "Agendamentos", "Consumo", "Logs", "Jobs falhos", "Usuários", "Diagnósticos"]) assert.match(html, new RegExp(label, "u"));
  assert.match(css, /@media \(max-width:/u);
  assert.match(js, /credentials:\s*"include"/u);
  assert.match(js, /x-csrf-token/iu);
  assert.match(js, /\/tenants\/\$\{encodeURIComponent\(id\)\}\/\$\{action\}/u);
  assert.match(js, /method: "PUT",\s*body: \{ enabledModules \}/u);
  assert.match(js, /Visualizar comprovante/u);
  assert.match(js, /messages\/\$\{encodeURIComponent\(messageId\)\}\/media/u);
  assert.match(js, /humanMessageComposer/u);
  assert.match(js, /idempotencyKey = crypto\.randomUUID/u);
  assert.match(js, /conversations\/\$\{encodeURIComponent\(conversationId\)\}\/messages/u);
  assert.match(js, /failed-jobs\/\$\{encodeURIComponent\(id\)\}\/\$\{action\}/u);
  assert.match(js, /Reenfileirar com segurança/u);
  assert.match(html, /id="passwordButton"/u);
  assert.match(js, /\/auth\/password/u);
  assert.match(html, /img-src 'self' data: blob:/u);
  assert.doesNotMatch(js, /\/numbers\/\$\{encodeURIComponent\(numberId\)\}\/credentials\/rotate/u);
  assert.doesNotMatch(`${html}${js}`, /sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}/u);
});

test("JavaScript do painel possui sintaxe válida", async () => {
  const panelScript = fileURLToPath(new URL("../panel/app.js", import.meta.url));
  await assert.doesNotReject(execFileAsync(process.execPath, ["--check", panelScript]));
});

test("empresa em rascunho oferece ativação em vez de suspensão", async () => {
  const js = await readFile(new URL("../panel/app.js", import.meta.url), "utf8");
  assert.match(js, /draft:\s*Object\.freeze\(\{ label: "Ativar", status: "active", className: "button-primary" \}\)/u);
  assert.match(js, /active:\s*Object\.freeze\(\{ label: "Suspender", status: "suspended", className: "button-danger" \}\)/u);
});

test("painel permite completar e ativar o vínculo do número WhatsApp", async () => {
  const js = await readFile(new URL("../panel/app.js", import.meta.url), "utf8");
  assert.match(js, /button\("Configurar", \(\) => openNumberSettings\(item\)/u);
  assert.match(js, /method: "PATCH", body, success: "Número WhatsApp atualizado\."/u);
  assert.match(js, /\["principal", "Número principal"/u);
});

test("painel captura módulos antes de aguardar a confirmação", async () => {
  const js = await readFile(new URL("../panel/app.js", import.meta.url), "utf8");
  const handler = js.slice(js.indexOf("async function saveModules"), js.indexOf("async function openConversation"));
  assert.ok(handler.indexOf("const enabledModules") < handler.indexOf("await confirmAction"));
});

test("configurações permitem criar a integração Google Sheets ausente", async () => {
  const js = await readFile(new URL("../panel/app.js", import.meta.url), "utf8");
  assert.match(js, /button\("Adicionar Google Sheets", \(\) => createGoogleSheetsIntegration/u);
  assert.match(js, /type: "google_sheets",\s*name: "Google Sheets",\s*enabled: false/u);
  assert.match(js, /openGoogleSheetsConfig\(integration, credentials\)/u);
});

test("identidade e atendimento permitem editar regras do estabelecimento", async () => {
  const js = await readFile(new URL("../panel/app.js", import.meta.url), "utf8");
  assert.match(js, /nodeWithText\("dt", "Regras do estabelecimento"\), valueNode\(runtimeConfig\.establishmentRules\)/u);
  assert.match(js, /\["establishmentRules", "Regras do estabelecimento", "textarea", false\]/u);
});
