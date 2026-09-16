import assert from "node:assert/strict";
import test from "node:test";
import { MetaGraphHealthClient } from "../src/integrations/meta/meta-health-client.js";

function response(id, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return { id, access_token: "não-deve-ser-retornado" }; } };
}

test("health Meta consulta app, WABA e número usando token somente no cabeçalho", async () => {
  const calls = [];
  const client = new MetaGraphHealthClient({
    apiVersion: "v99.0",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const id = new URL(url).pathname.split("/").at(-1);
      return response(id);
    },
  });

  const result = await client.checkConnection({
    appId: "app-a",
    wabaId: "waba-a",
    phoneNumberId: "phone-a",
    accessToken: "synthetic-access-token",
  });

  assert.deepEqual(result, {
    appId: "app-a",
    wabaId: "waba-a",
    phoneNumberId: "phone-a",
    tokenValid: true,
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ url }) => !url.includes("synthetic-access-token")));
  assert.ok(calls.every(({ options }) => options.headers.Authorization === "Bearer synthetic-access-token"));
  assert.doesNotMatch(JSON.stringify(result), /access-token|não-deve-ser-retornado/u);
});

test("health Meta rejeita identificadores capazes de alterar o caminho Graph", async () => {
  const client = new MetaGraphHealthClient({ fetchImpl: async () => assert.fail("não deve chamar a rede") });
  await assert.rejects(
    client.checkConnection({ appId: "../debug_token", wabaId: "waba-a", phoneNumberId: "phone-a", accessToken: "token" }),
    /appId inválido/u,
  );
});

test("health Meta expõe somente código e status sanitizados quando Graph recusa", async () => {
  const secret = "synthetic-private-token";
  const client = new MetaGraphHealthClient({
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      async json() { return { error: { message: `token ${secret}` } }; },
    }),
  });
  let captured;
  try {
    await client.checkConnection({ appId: "app-a", wabaId: "waba-a", phoneNumberId: "phone-a", accessToken: secret });
  } catch (error) {
    captured = error;
  }
  assert.equal(captured.code, "META_HEALTH_REQUEST_FAILED");
  assert.equal(captured.status, 403);
  assert.doesNotMatch(JSON.stringify(captured), new RegExp(secret, "u"));
});

test("health Meta normaliza indisponibilidade sem vazar erro interno", async () => {
  const client = new MetaGraphHealthClient({
    fetchImpl: async () => { throw new Error("detalhe privado do transporte"); },
  });
  await assert.rejects(
    client.checkConnection({ appId: "app-a", wabaId: "waba-a", phoneNumberId: "phone-a", accessToken: "token" }),
    (error) => error.code === "META_HEALTH_UNAVAILABLE" && !error.message.includes("detalhe privado"),
  );
});

test("health Meta propaga cancelamento externo para todas as chamadas Graph", async () => {
  const caller = new AbortController();
  caller.abort();
  const receivedSignals = [];
  const client = new MetaGraphHealthClient({
    fetchImpl: async (_url, { signal }) => {
      receivedSignals.push(signal);
      if (signal.aborted) throw new Error("cancelado");
      return response("não-deve-chegar");
    },
  });

  await assert.rejects(
    client.checkConnection({
      appId: "app-a",
      wabaId: "waba-a",
      phoneNumberId: "phone-a",
      accessToken: "token",
      signal: caller.signal,
    }),
    (error) => error.code === "META_HEALTH_UNAVAILABLE",
  );
  assert.equal(receivedSignals.length, 3);
  assert.ok(receivedSignals.every((signal) => signal.aborted));
});
