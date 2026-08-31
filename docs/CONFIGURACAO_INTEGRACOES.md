# Configuração das integrações — Capitão Mor

O runtime oficial usa `src/api.js` e `src/worker.js`. Credenciais de cada empresa ficam no cofre criptografado do painel; somente segredos de infraestrutura ou compartilhados ficam no `.env` do servidor.

## 1. Segredos do servidor

Preencha o `.env` de produção a partir de `.env.example` sem versionar o arquivo:

- `MASTER_KEYRING`: chave que cifra o cofre por empresa.
- `SESSION_PEPPER`: segredo das sessões administrativas.
- `WHATSAPP_VERIFY_TOKEN`: valor criado por você e informado também no webhook da Meta.
- `META_APP_SECRET`: segredo do aplicativo Meta, usado para validar `X-Hub-Signature-256`.
- `OPENAI_API_KEY`: opcional; chave compartilhada entre empresas. Para chave própria do Capitão Mor, use o painel.
- credenciais PostgreSQL, Redis e `METRICS_BEARER_TOKEN` conforme `.env.example`.

O access token do número WhatsApp e o JSON da conta de serviço Google não pertencem ao `.env` do runtime SaaS.

## 2. Meta / WhatsApp do Capitão Mor

1. No Meta Business, confirme o WABA, registre o número e obtenha o `phone_number_id`.
2. Gere um token de usuário de sistema com `whatsapp_business_messaging` e `whatsapp_business_management`; não use o token temporário do início rápido em produção.
3. No painel WAIA, selecione **Capitão Mor → Números WhatsApp → Vincular número** e informe o `phone_number_id`.
4. No número criado, escolha **Cadastrar credencial Meta** e cole o access token. Depois deixe o número como ativo/principal.
5. Na Meta, configure a callback HTTPS como `https://SEU_DOMINIO/webhook`, informe o mesmo `WHATSAPP_VERIFY_TOKEN` do servidor e assine o campo `messages` para o WABA.

`META_APP_SECRET` e `WHATSAPP_VERIFY_TOKEN` são do aplicativo/webhook. O access token é do número/tenant e fica no cofre.

## 3. OpenAI

Há duas opções:

- **Compartilhada:** defina `OPENAI_API_KEY` no servidor e mantenha `keyType=compartilhada` no painel.
- **Própria do Capitão Mor:** em **Módulos e configurações → Cadastrar chave OpenAI**, salve a chave; copie o ID mascarado da credencial para a configuração da IA e escolha `keyType=propria`.

No mesmo formulário, habilite a IA, escolha o modelo, prompt, personalidade e limites. O WAIA usa a Responses API para perguntas livres; menu, compra, PIX, comprovante e confirmação continuam determinísticos. O runtime não envia PIX nem bytes do comprovante ao modelo.

## 4. Google Sheets

### Preparar o Google

1. Crie ou selecione um projeto Google Cloud e habilite a Google Sheets API.
2. Crie uma conta de serviço e uma chave JSON.
3. Compartilhe a planilha existente do Capitão Mor com o `client_email` do JSON como **Editor**.
4. Preserve estas abas e colunas:

   - `Agenda!A2:I`: `id`, `data YYYY-MM-DD`, `dia`, `hora HH:MM`, `atrações`, `preço`, `regra VIP/aniversariante`, `observações`, `status`.
   - `Configurações!A2:C`: chave na coluna A e valor na B. São importadas somente `endereco`, `link_cardapio` e `regra_aniversariante` (com aliases compatíveis).
   - `Pedidos!A:G`: recebe data, telefone, evento, nome, ID do comprovante, `Aguardando conferência` e observação vazia.

Mantenha PIX e favorecida no cofre/formas de pagamento do painel, não na planilha.

### Ligar no WAIA

1. Selecione **Capitão Mor → Módulos e configurações → Integrações → Configurar Google Sheets**.
2. Cole somente o ID da planilha, confirme os três ranges e cole o JSON completo da conta de serviço.
3. Ao salvar, o painel guarda o JSON cifrado, habilita a integração e executa uma sincronização imediata.
4. Uma sincronização saudável importa os eventos ativos e futuros. O worker repete a leitura a cada `GOOGLE_SHEETS_SYNC_INTERVAL_MS` (padrão: 120 segundos).

PostgreSQL continua sendo a fonte de verdade operacional. Se o Google falhar, o último snapshot válido é preservado; pedidos já ficam persistidos no banco e a exportação é retomada por job idempotente.

## 5. Checklist antes do primeiro teste real

- Empresa Capitão Mor com estado `ativa`.
- Módulos `orders`, `events`, `payments`, `ai_freeform` e `external_integrations` habilitados.
- Número Meta ativo/principal, token salvo e webhook assinado em `messages`.
- Forma de pagamento real cadastrada no cofre e vinculada ao PIX.
- IA habilitada com chave compartilhada ou própria.
- Google Sheets com estado `saudavel` e eventos futuros importados.
- Teste inicial usando um número e dados exclusivos de homologação, antes de tráfego de clientes.
