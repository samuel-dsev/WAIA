import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export class GoogleSheetsClient {
  constructor({ spreadsheetId, clientEmail, privateKey, credentialsFile, fetchImpl = fetch }) {
    if ((!clientEmail || !privateKey) && credentialsFile && existsSync(credentialsFile)) {
      const credentials = JSON.parse(readFileSync(credentialsFile, "utf8"));
      clientEmail = credentials.client_email;
      privateKey = credentials.private_key;
    }
    this.spreadsheetId = spreadsheetId;
    this.clientEmail = clientEmail;
    this.privateKey = privateKey?.replace(/\\n/g, "\n");
    this.fetch = fetchImpl;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  get configured() {
    return Boolean(this.spreadsheetId && this.clientEmail && this.privateKey);
  }

  async authorize() {
    if (!this.configured) throw new Error("Credenciais do Google Sheets não configuradas.");
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken;

    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(JSON.stringify({
      iss: this.clientEmail,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }));
    const unsigned = `${header}.${claims}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.privateKey, "base64url");
    const response = await this.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!response.ok) throw new Error(`Falha ao autenticar no Google (${response.status}).`);
    const payload = await response.json();
    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  async request(path, options = {}) {
    const token = await this.authorize();
    const response = await this.fetch(`https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...options.headers,
      },
    });
    if (!response.ok) throw new Error(`Falha no Google Sheets (${response.status}).`);
    return response.json();
  }

  async getValues(range) {
    const payload = await this.request(`/values/${encodeURIComponent(range)}?majorDimension=ROWS`);
    return payload.values || [];
  }

  async appendValues(range, row) {
    return this.request(`/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: JSON.stringify({ majorDimension: "ROWS", values: [row] }),
    });
  }
}
