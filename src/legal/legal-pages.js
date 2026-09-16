import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const publicDirectory = fileURLToPath(new URL("../../public", import.meta.url));

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function legalValues(config = {}) {
  const platformName = String(config.platformName || "").trim();
  const privacyEmail = String(config.privacyEmail || "").trim().toLowerCase();
  const controllerNotice = String(config.controllerNotice || "").trim();
  if (!platformName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(privacyEmail) || !controllerNotice) return null;
  return {
    PLATFORM_NAME: escapeHtml(platformName),
    PRIVACY_EMAIL: escapeHtml(privacyEmail),
    PRIVACY_EMAIL_URI: encodeURIComponent(privacyEmail),
    CONTROLLER_NOTICE: escapeHtml(controllerNotice),
  };
}

export function renderLegalTemplate(template, config) {
  const values = legalValues(config);
  if (!values) return null;
  return String(template).replace(/\{\{([A-Z_]+)\}\}/gu, (_match, key) => values[key] ?? "");
}

export function createLegalPageHandler({ file, config, load = readFile } = {}) {
  if (!file) throw new TypeError("file e obrigatorio.");
  return async function legalPage(_request, response, next) {
    try {
      const rendered = renderLegalTemplate(await load(`${publicDirectory}/${file}`, "utf8"), config);
      if (!rendered) return response.status(503).type("text/plain").send("Pagina legal aguardando configuracao e revisao do responsavel juridico.");
      response.set("Cache-Control", "public, max-age=300");
      return response.status(200).type("html").send(rendered);
    } catch (error) {
      return next(error);
    }
  };
}
