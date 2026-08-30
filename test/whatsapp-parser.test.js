import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWhatsAppWebhook,
  WhatsAppPayloadValidationError,
} from "../src/modules/whatsapp/parser.js";

function change(phoneNumberId, content) {
  return {
    field: "messages",
    value: {
      metadata: {
        phone_number_id: phoneNumberId,
        display_phone_number: `display-${phoneNumberId}`,
      },
      ...content,
    },
  };
}

test("normaliza mensagens de duas empresas preservando phone_number_id", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-a",
        changes: [change("phone-a", { messages: [{
          id: "wamid.a",
          from: "551100000001",
          timestamp: "1787800000",
          type: "text",
          text: { body: "Olá A" },
        }] })],
      },
      {
        id: "waba-b",
        changes: [change("phone-b", { messages: [{
          id: "wamid.b",
          from: "551100000002",
          timestamp: "1787800001",
          type: "interactive",
          interactive: {
            type: "button_reply",
            button_reply: { id: "agenda", title: "Agenda" },
          },
        }] })],
      },
    ],
  };

  const events = parseWhatsAppWebhook(payload);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(({ phoneNumberId }) => phoneNumberId), ["phone-a", "phone-b"]);
  assert.deepEqual(events.map(({ externalMessageId }) => externalMessageId), ["wamid.a", "wamid.b"]);
  assert.equal(events[0].text, "Olá A");
  assert.equal(events[1].text, "agenda");
  assert.equal(events[1].interactiveSelection.type, "button_reply");
});

test("normaliza seleção de mensagem de lista para o mesmo contrato interativo", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-a",
      changes: [change("phone-a", { messages: [{
        id: "wamid.list",
        from: "551100000001",
        timestamp: "1787800000",
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: { id: "_waia_page:menu:2", title: "Próxima página" },
        },
      }] })],
    }],
  };

  const [message] = parseWhatsAppWebhook(payload);
  assert.equal(message.text, "_waia_page:menu:2");
  assert.deepEqual(message.interactiveSelection, {
    type: "list_reply",
    id: "_waia_page:menu:2",
    title: "Próxima página",
  });
});

test("normaliza imagem e status Meta sem reter detalhes excessivos do erro", () => {
  const payload = {
    entry: [{
      id: "waba-a",
      changes: [change("phone-a", {
        messages: [{
          id: "wamid.receipt",
          from: "551100000001",
          timestamp: "1787800000",
          type: "image",
          image: { id: "media-1", mime_type: "image/jpeg", caption: "comprovante" },
        }],
        statuses: [{
          id: "wamid.outbound",
          recipient_id: "551100000001",
          timestamp: "1787800002",
          status: "failed",
          conversation: { id: "conversation-meta" },
          pricing: { category: "service" },
          errors: [{ code: 131000, title: "Falha temporária", error_data: { details: "não persistir" } }],
        }],
      })],
    }],
  };

  const [message, status] = parseWhatsAppWebhook(payload);
  assert.equal(message.media.externalId, "media-1");
  assert.equal(message.text, "comprovante");
  assert.equal(status.kind, "status");
  assert.equal(status.phoneNumberId, "phone-a");
  assert.equal(status.status, "failed");
  assert.equal(status.conversationExternalId, "conversation-meta");
  assert.deepEqual(status.errors, [{ code: "131000", title: "Falha temporária" }]);
  assert.equal("error_data" in status.errors[0], false);
});

test("ignora changes de outro campo e aceita webhook sem eventos", () => {
  assert.deepEqual(parseWhatsAppWebhook({ entry: [] }), []);
  assert.deepEqual(parseWhatsAppWebhook({ entry: [{ changes: [{ field: "account_update", value: {} }] }] }), []);
});

test("rejeita evento sem phone_number_id", () => {
  assert.throws(
    () => parseWhatsAppWebhook({ entry: [{ changes: [{ field: "messages", value: {
      metadata: {},
      messages: [{ id: "wamid.1", from: "5511", type: "text", text: { body: "oi" } }],
    } }] }] }),
    (error) => error instanceof WhatsAppPayloadValidationError
      && error.path.endsWith("metadata.phone_number_id"),
  );
});

test("rejeita texto acima do limite e arrays estruturalmente inválidos", () => {
  assert.throws(
    () => parseWhatsAppWebhook({ entry: [{ changes: [change("phone-a", { messages: [{
      id: "wamid.1",
      from: "5511",
      type: "text",
      text: { body: "x".repeat(4_097) },
    }] })] }] }),
    (error) => error.code === "string_limit_exceeded",
  );
  assert.throws(
    () => parseWhatsAppWebhook({ entry: {} }),
    (error) => error.code === "invalid_array",
  );
});
