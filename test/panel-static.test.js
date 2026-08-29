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
  for (const label of ["Empresas", "Contatos", "Conversas", "Pedidos", "Agendamentos", "Consumo", "Logs", "Usuários", "Diagnósticos"]) assert.match(html, new RegExp(label, "u"));
  assert.match(css, /@media \(max-width:/u);
  assert.match(js, /credentials:\s*"include"/u);
  assert.match(js, /x-csrf-token/iu);
  assert.match(js, /\/tenants\/\$\{encodeURIComponent\(id\)\}\/\$\{action\}/u);
  assert.match(js, /method: "PUT",\s*body: \{ enabledModules \}/u);
  assert.doesNotMatch(js, /\/numbers\/\$\{encodeURIComponent\(numberId\)\}\/credentials\/rotate/u);
  assert.doesNotMatch(`${html}${js}`, /sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}/u);
});

test("JavaScript do painel possui sintaxe válida", async () => {
  const panelScript = fileURLToPath(new URL("../panel/app.js", import.meta.url));
  await assert.doesNotReject(execFileAsync(process.execPath, ["--check", panelScript]));
});
