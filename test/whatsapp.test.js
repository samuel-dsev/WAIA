import test from "node:test";
import assert from "node:assert/strict";
import { extractMessages } from "../src/whatsapp.js";

test("extrai mensagens de texto e imagens do webhook", () => {
  const payload = {
    entry: [{ changes: [{ value: { messages: [
      { from: "5511999999999", type: "text", text: { body: "Olá" } },
      { from: "5511888888888", type: "image" },
    ] } }] }],
  };
  assert.deepEqual(extractMessages(payload), [{
    id: undefined,
    phone: "5511999999999",
    type: "text",
    text: "Olá",
    mediaId: undefined,
  }, {
    id: undefined,
    phone: "5511888888888",
    type: "image",
    text: "",
    mediaId: undefined,
  }]);
});

test("aceita webhook sem mensagens", () => {
  assert.deepEqual(extractMessages({ entry: [] }), []);
});

test("extrai a opção selecionada em botão interativo", () => {
  const payload = {
    entry: [{ changes: [{ value: { messages: [{
      id: "wamid.1",
      from: "5511999999999",
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "agenda", title: "Agenda" } },
    }] } }] }],
  };

  assert.deepEqual(extractMessages(payload), [{
    id: "wamid.1",
    phone: "5511999999999",
    type: "interactive",
    text: "agenda",
    mediaId: undefined,
  }]);
});

test("extrai imagem de comprovante", () => {
  const payload = { entry: [{ changes: [{ value: { messages: [{
    id: "wamid.2",
    from: "5511999999999",
    type: "image",
    image: { id: "media.1", caption: "comprovante" },
  }] } }] }] };

  assert.deepEqual(extractMessages(payload), [{
    id: "wamid.2",
    phone: "5511999999999",
    type: "image",
    text: "comprovante",
    mediaId: "media.1",
  }]);
});

test("aceita o formato alternativo de resposta de botão", () => {
  const payload = { entry: [{ changes: [{ value: { messages: [{
    id: "wamid.3",
    from: "5511999999999",
    type: "button",
    button: { payload: "convites", text: "Comprar convites" },
  }] } }] }] };

  assert.equal(extractMessages(payload)[0].text, "convites");
});
