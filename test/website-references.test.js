import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWebsiteInteraction, pendingWebsiteFinancingSession, hasWebsiteFinancingConsent, websiteReferenceClarification } from "../src/modules/business/website-catalog-interaction.js";
import { parseCatalogSalesReply } from "../src/modules/business/catalog-sales.js";

const ids = ["turim:1", "turim:2"];
const items = [{ id: ids[0], name: "ECOSPORT FREESTYLE" }, { id: ids[1], name: "KA SE PLUS 1.5" }];
const catalog = { source: { type: "website_catalog", status: "healthy" }, salesMode: true, items };
const output = (catalogAction, productIds, text = "Vamos continuar com esses modelos.") => JSON.stringify({
  text, catalogAction, productIds, filters: { category: null, minPrice: null, maxPrice: null },
});

test("singular ambíguo com dois modelos pede nomes concretos, sem converter em plural nem adivinhar", () => {
  const focused = { ...catalog, interaction: { step: "discussion", productIds: ids, direct: true } };
  for (const message of ["Quero fazer a simulação dele", "Quero financiar ele", "Tem fotos desse?", "Quanto custa esse?"]) {
    for (const selection of [ids, [ids[0]], [ids[1]], []]) {
      const reply = websiteReferenceClarification(focused, message, selection);
      assert.ok(items.every((item) => reply.text.includes(item.name)));
      assert.deepEqual(reply.websiteInteraction.productIds, ids);
    }
    assert.deepEqual(parseCatalogSalesReply(output("finance", ids), focused, { message }), websiteReferenceClarification(focused, message, ids));
  }
  for (const message of ["Quero simular os dois", "Fotos deles", "Quero simular esse ECOSPORT", "Quero simular o segundo", "Quero simular o outro"]) {
    assert.equal(websiteReferenceClarification(focused, message, ids), null, message);
  }
  assert.equal(websiteReferenceClarification({ ...focused, quotedProductId: ids[1] }, "Quero simular esse", [ids[1]]), null);
  assert.equal(websiteReferenceClarification({ ...catalog, interaction: { step: "discussion", productIds: [ids[1]], direct: true } }, "Quero simular ele", [ids[1]]), null);
});

test("referências textuais mantêm os IDs discutidos sem reenviar galerias", () => {
  for (const action of ["none", "details"]) {
    const reply = parseCatalogSalesReply(output(action, ids), catalog);
    assert.deepEqual(reply.websiteInteraction, { step: "discussion", productIds: ids });
    assert.equal(reply.messages, undefined);
  }
  assert.ok(parseCatalogSalesReply(output("finance", ids), catalog).text);
  assert.deepEqual(parseCatalogSalesReply(output("finance_decline", ids), catalog).websiteInteraction, { step: "declined", productIds: ids });
  assert.throws(() => parseCatalogSalesReply(output("finance", []), catalog));
  assert.throws(() => parseCatalogSalesReply(output("finance", [ids[0], ids[0]]), catalog));
  assert.throws(() => parseCatalogSalesReply(output("finance", ["turim:999"]), catalog));
});

test("financeiro aceita referência plural após oferta atual, sem confundir lista e reconhecimento com aceite", () => {
  const offer = [{ role: "assistant", content: "Você gostaria de fazer uma simulação de financiamento para esses modelos?" }];
  for (const message of ["quero sim, dos dois", "os dois", "deles", "pode fazer para eles", "Sim, do KA SE PLUS 1.5"]) {
    for (const id of ids) assert.equal(hasWebsiteFinancingConsent(catalog, message, id, offer), true, message);
  }
  for (const message of ["Entendi", "Entendi\nCerto", "", "não", "não obrigado", "não quero", "talvez", "ainda não", "depois"]) {
    assert.equal(hasWebsiteFinancingConsent(catalog, message, ids[0], offer), false, message);
  }
  const alternatives = [...offer, { role: "assistant", content: "Posso mostrar opções semelhantes?" }];
  assert.equal(hasWebsiteFinancingConsent(catalog, "Entendi\nPode sim", ids[0], alternatives), false);
  for (const id of ids) assert.equal(hasWebsiteFinancingConsent(catalog, "Quero fazer a simulação de financiamento dos dois", id, alternatives), true);
});

test("pendência plural sobrevive a fotos e cancelamento parcial; legado singular continua compatível", () => {
  const states = [{ step: "finance_accepted", productIds: ids }, { step: "gallery", productIds: ids }];
  assert.deepEqual(pendingWebsiteFinancingSession(states), { productIds: ids, status: "pending" });
  assert.equal(hasWebsiteFinancingConsent({ ...catalog, financingSession: pendingWebsiteFinancingSession(states) }, "Meu nome é Ana", ids[1], []), true);
  states.push({ step: "declined", productIds: [ids[0]] });
  assert.deepEqual(pendingWebsiteFinancingSession(states), { productId: ids[1], productIds: [ids[1]], status: "pending" });
  states.push({ step: "closed", productIds: [ids[1]] });
  assert.equal(pendingWebsiteFinancingSession(states), null);
  assert.equal(hasWebsiteFinancingConsent({ ...catalog, financingSession: { productId: ids[0], status: "pending" } }, "Meu nome é Ana", ids[0], []), true);
  for (const step of ["discussion", "gallery", "finance_accepted", "closed", "declined"]) {
    assert.deepEqual(normalizeWebsiteInteraction({ step, productIds: ids }), { step, productIds: ids });
    assert.equal(normalizeWebsiteInteraction({ step, productIds: [...ids, "turim:3", "turim:4"] }), null);
  }
});
