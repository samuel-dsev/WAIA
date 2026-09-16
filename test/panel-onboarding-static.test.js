import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEmptyOnboardingDraft, createOnboardingFlowStep, ONBOARDING_STEPS } from "../panel/onboarding.js";
import { parseFlowDefinition } from "../src/modules/flows/index.js";

test("wizard declara as dez etapas planejadas e um rascunho V2 seguro", () => {
  assert.deepEqual(ONBOARDING_STEPS.map(([step, label]) => [step, label]), [
    [1, "Empresa"], [2, "Módulos"], [3, "Atendimento"], [4, "Menus e roteamento"],
    [5, "Operação"], [6, "Fluxos"], [7, "IA"], [8, "WhatsApp e Meta"],
    [9, "Equipe"], [10, "Revisão"],
  ]);
  const draft = createEmptyOnboardingDraft({ name: "Empresa Sintética", slug: "empresa-sintetica" });
  assert.equal(draft.schemaVersion, 2);
  assert.equal(draft.identity.name, "Empresa Sintética");
  assert.deepEqual(draft.flows, { definitions: [] });
  assert.deepEqual(draft.integrations, []);
  assert.equal(JSON.stringify(draft).match(/secret|password|accessToken|verifyToken/giu), null);
});

test("escolha única gera campo e transições somente nas opções", () => {
  const step = createOnboardingFlowStep({
    type: "single_choice",
    message: "Qual opção?",
    field: "Opção escolhida",
    required: true,
    nextStepId: "destino_incompativel",
    choiceLabels: "Primeira\nSegunda",
    choiceTargetStepId: "conclusao",
  });
  assert.equal(step.field, "opcao_escolhida");
  assert.equal(Object.hasOwn(step, "nextStepId"), false);
  assert.deepEqual(step.options.map(({ label, nextStepId }) => ({ label, nextStepId })), [
    { label: "Primeira", nextStepId: "conclusao" },
    { label: "Segunda", nextStepId: "conclusao" },
  ]);
  assert.doesNotThrow(() => parseFlowDefinition({
    key: "triagem_painel",
    name: "Triagem criada pelo painel",
    version: 1,
    startStepId: step.id,
    steps: [step, { id: "conclusao", type: "completion", message: "Concluído." }],
  }));
});

test("troca de tipo remove propriedades incompatíveis da etapa de fluxo", () => {
  const step = createOnboardingFlowStep({ type: "completion", message: "Finalizado." }, {
    id: "resposta",
    type: "text",
    message: "Informe algo.",
    field: "resposta",
    required: true,
    options: [],
    nextStepId: "conclusao",
  });
  assert.deepEqual(step, { id: "resposta", type: "completion", message: "Finalizado." });
});

test("wizard usa revisão otimista, autosave e contratos HTTP de aplicação", async () => {
  const source = await readFile(new URL("../panel/onboarding.js", import.meta.url), "utf8");
  for (const endpoint of [
    "/onboarding", "/action-catalog", "/configuration/draft", "/configuration/validate",
    "/configuration/publish", "/readiness", "/activate", "/meta-applications",
    "/preflight", "/simulator/messages",
  ]) assert.match(source, new RegExp(endpoint.replaceAll("/", "\\/"), "u"));
  assert.match(source, /draftVersion: state\.draftVersion/u);
  assert.match(source, /revision: state\.progress\.revision/u);
  assert.match(source, /setTimeout\(\(\) => flushDraft\(\)\.catch/u);
  assert.match(source, /error\.status === 409/u);
  assert.match(source, /Recarregar versão atual/u);
});

test("revisão integra preflight e simulador sem persistir conversa no navegador", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../panel/onboarding.js", import.meta.url), "utf8"),
    readFile(new URL("../panel/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /Executar preflight externo/u);
  assert.match(source, /openSimulatorDialog/u);
  assert.match(source, /sessionRevision/u);
  assert.match(source, /type: "document"/u);
  assert.match(source, /type: "image"/u);
  assert.match(source, /type: "reset"/u);
  assert.match(source, /type: "list"/u);
  assert.match(source, /Nenhuma chamada à Meta, OpenAI ou Google/u);
  assert.doesNotMatch(source, /localStorage|sessionStorage/u);
  assert.doesNotMatch(source, /será habilitado na Fase 7/u);
  assert.match(css, /\.simulator-history/u);
  assert.match(css, /\.simulator-message/u);
});

test("seletores escondem referências internas e segredos seguem direto ao cofre", async () => {
  const [source, app, html] = await Promise.all([
    readFile(new URL("../panel/onboarding.js", import.meta.url), "utf8"),
    readFile(new URL("../panel/app.js", import.meta.url), "utf8"),
    readFile(new URL("../panel/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(source, /actionDefinitions/u);
  assert.match(source, /Vincular usuário existente/u);
  assert.match(source, /\/users\/lookup\?email=/u);
  assert.match(source, /maskedSecret/u);
  assert.match(source, /createCredential/u);
  assert.match(source, /Informe somente a chave/u);
  assert.match(app, /Chave PIX \(somente a chave\)/u);
  assert.match(source, /Atender contatos e conversas/u);
  assert.match(source, /permissionsFrom/u);
  assert.match(source, /Campo que será avaliado/u);
  assert.match(source, /initialPassword[^\n]+min: 12/u);
  assert.match(source, /input\.minLength = Number\(min\)/u);
  assert.doesNotMatch(source, /ID do menu|ID da credencial|ID do serviço/u);
  assert.doesNotMatch(app, /ID do menu|ID da credencial própria|ID da credencial no cofre|ID do serviço/u);
  assert.doesNotMatch(html, /data-view="(?:menuItems|payments|availability)"/u);
  assert.doesNotMatch(source, /Filaretti/iu);
});

test("autosave confirma a revisão do draft antes de sincronizar a empresa", async () => {
  const source = await readFile(new URL("../panel/onboarding.js", import.meta.url), "utf8");
  const flushStart = source.indexOf("async function flushDraft()");
  const flushEnd = source.indexOf("function renderConflict()", flushStart);
  const flushSource = source.slice(flushStart, flushEnd);
  assert.ok(flushSource.indexOf('endpoint("/configuration/draft")') >= 0);
  assert.ok(flushSource.indexOf('endpoint("/configuration/draft")') < flushSource.indexOf("saveTenantIfNeeded({"));
  assert.match(flushSource, /draftConfirmed = true/u);
  assert.match(flushSource, /!draftConfirmed && \(error\.status === 409/u);
});

test("carregamentos opcionais absorvem somente o 404 esperado do draft", async () => {
  const source = await readFile(new URL("../panel/onboarding.js", import.meta.url), "utf8");
  assert.match(source, /allowNotFound && error\.status === 404/u);
  assert.match(source, /configuration\/draft"\), signal, \{ allowNotFound: true \}/u);
  assert.doesNotMatch(source, /optional\(endpoint\("\/(?:credentials|numbers|meta-applications|users)/u);
});

test("refresh automático preserva o onboarding e seus diálogos", async () => {
  const app = await readFile(new URL("../panel/app.js", import.meta.url), "utf8");
  assert.match(app, /state\.currentView !== "onboarding"/u);
  assert.match(app, /dialog\.wizard-dialog\[open\]/u);
  assert.match(app, /visibilitychange[\s\S]+canAutoRefreshCurrentView\(\)/u);
});

test("diálogos associam erros aos campos e mudança de etapa gerencia o foco", async () => {
  const source = await readFile(new URL("../panel/onboarding.js", import.meta.url), "utf8");
  assert.match(source, /showFieldErrors/u);
  assert.match(source, /setAttribute\("aria-invalid", "true"\)/u);
  assert.match(source, /firstInvalid\?\.focus\(\)/u);
  assert.match(source, /heading\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(source, /submit\.disabled = true/u);
  assert.match(source, /form\.setAttribute\("aria-busy", "true"\)/u);
  assert.match(source, /firstInvalid\?\.focus\(\)/u);
});

test("Meta usa estados e vínculos coerentes com o contrato público", async () => {
  const source = await readFile(new URL("../panel/onboarding.js", import.meta.url), "utf8");
  assert.match(source, /metaAppId: current\?\.metaAppId \|\| ""/u);
  assert.match(source, /disabled: Boolean\(current\)/u);
  assert.match(source, /state: "inactive"/u);
  assert.doesNotMatch(source, /state: "suspended"/u);
  assert.match(source, /filter\(\(item\) => item\.metaAppId === app\.id\)/u);
  assert.doesNotMatch(source, /state\.numbers\.find\(\(item\) => item\.principal\) \|\| state\.numbers\[0\]/u);
  assert.match(source, /rotateMetaSecretDialog/u);
  assert.match(source, /rotateVerifyTokenDialog/u);
  assert.doesNotMatch(source, /Credenciais rotacionadas sem interromper/u);
  assert.match(source, /credencial anterior permanece no cofre para revogação auditada/iu);
});

test("transições aguardam flush e edição de integrante é tenant-scoped", async () => {
  const [source, app] = await Promise.all([
    readFile(new URL("../panel/onboarding.js", import.meta.url), "utf8"),
    readFile(new URL("../panel/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(source, /async function flushForTransition/u);
  assert.match(source, /await flushDraft\(\)/u);
  assert.match(source, /async function dispose\(\)[\s\S]+await flushForTransition\(\)/u);
  assert.match(source, /return Object\.freeze\(\{ render, flush: flushForTransition, dispose, abort \}\)/u);
  assert.match(app, /await state\.onboardingWizard\.dispose\(\)/u);
  assert.match(app, /state\.onboardingWizard\?\.abort\?\.\(\)/u);
  assert.match(app, /elements\.tenantSelect\.value = previousTenantId/u);
  assert.match(source, /endpoint\(`\/memberships\/\$\{encoded\(current\.id\)\}`\)/u);
  assert.match(source, /else await apiFetch\(endpoint\("\/users"\)/u);
  assert.doesNotMatch(source, /endpoint\(`\/users\$\{current \? `\/\$\{encoded\(current\.id\)\}`/u);
  assert.match(app, /logoutButton[\s\S]+if \(!await disposeOnboardingWizard\(\)\) return;/u);
});

test("coleções revertem a mutação local quando o draft é rejeitado", async () => {
  const source = await readFile(new URL("../panel/onboarding.js", import.meta.url), "utf8");
  assert.match(source, /async function persistCollectionMutation\(mutate, rollback\)/u);
  assert.match(source, /if \(!error\.draftConfirmed\)/u);
  assert.match(source, /if \(rollback\) rollback\(\); else state\.configuration = previousConfiguration/u);
  assert.match(source, /async function persistCollectionItem/u);
});

test("publicação trata falha de flush sem prosseguir", async () => {
  const source = await readFile(new URL("../panel/onboarding.js", import.meta.url), "utf8");
  const start = source.indexOf("async function release(action)");
  const end = source.indexOf("async function saveTenantIfNeeded", start);
  const release = source.slice(start, end);
  assert.match(release, /try \{[\s\S]+await flushDraft\(\)/u);
  assert.match(release, /catch \(error\)[\s\S]+return;/u);
});

test("navegação e estilos expõem o onboarding com acessibilidade e responsividade", async () => {
  const [html, css, app] = await Promise.all([
    readFile(new URL("../panel/index.html", import.meta.url), "utf8"),
    readFile(new URL("../panel/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../panel/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /data-view="onboarding"/u);
  assert.match(app, /createOnboardingWizard/u);
  assert.match(css, /\.wizard-steps/u);
  assert.match(css, /@media \(max-width: 620px\)/u);
  assert.match(css, /prefers-reduced-motion/u);
  assert.match(app, /error\.issues/u);
  assert.match(app, /error\.details/u);
  assert.match(app, /error\.checks/u);
});
