import { checkWhatsAppConnection, whatsappReadiness } from "../src/whatsapp.js";

const readiness = whatsappReadiness();
if (!readiness.credentialsConfigured) {
  console.error("Falha: preencha CAPITAO_MOR_WHATSAPP_ACCESS_TOKEN e CAPITAO_MOR_WHATSAPP_PHONE_NUMBER_ID no .env legado.");
  process.exitCode = 1;
} else {
  try {
    const phone = await checkWhatsAppConnection();
    console.log("Conexão com o WhatsApp confirmada:");
    console.log(`Número: ${phone.display_phone_number || "não informado"}`);
    console.log(`Nome: ${phone.verified_name || "não informado"}`);
    console.log(`Qualidade: ${phone.quality_rating || "não informada"}`);
  } catch (error) {
    console.error(`Falha na Meta: ${error.message}`);
    process.exitCode = 1;
  }
}
