# Configuração das integrações por empresa

O runtime oficial usa `src/api.js` e `src/worker.js`. Credenciais de cada empresa ficam no cofre criptografado do painel; somente segredos de infraestrutura ou compartilhados ficam no `.env` do servidor.

## 1. Segredos do servidor

Preencha o `.env` de produção a partir de `.env.example` sem versionar o arquivo:

- `MASTER_KEYRING`: chave que cifra o cofre por empresa.
- `SESSION_PEPPER`: segredo das sessões administrativas.
- `WHATSAPP_VERIFY_TOKEN`: valor criado por você e informado também no webhook da Meta.
- `META_APP_SECRET`: segredo do aplicativo Meta, usado para validar `X-Hub-Signature-256`.
- `OPENAI_API_KEY`: opcional; chave compartilhada entre empresas. Para chave própria de um tenant, use o painel.
- credenciais PostgreSQL, Redis e `METRICS_BEARER_TOKEN` conforme `.env.example`.

O access token do número WhatsApp e o JSON da conta de serviço Google não pertencem ao `.env` do runtime SaaS.

## 2. Meta / WhatsApp por empresa

1. No Meta Business, confirme o WABA, registre o número e obtenha o `phone_number_id`.
2. Gere um token de usuário de sistema com `whatsapp_business_messaging` e `whatsapp_business_management`; não use o token temporário do início rápido em produção.
3. No painel WAIA, selecione a empresa e, em **Números WhatsApp → Vincular número**, informe o `phone_number_id`.
4. No número criado, escolha **Cadastrar credencial Meta** e cole o access token. Depois deixe o número como ativo/principal.
5. Na Meta, use o callback dinâmico exibido pelo painel (`https://SEU_DOMINIO/webhook/meta/<webhookPublicId>`), o verify token do aplicativo e assine o campo `messages` para o WABA. O endpoint `/webhook` permanece apenas para compatibilidade temporária do Capitão Mor.

`META_APP_SECRET` e `WHATSAPP_VERIFY_TOKEN` são do aplicativo/webhook. O access token é do número/tenant e fica no cofre.

## 3. OpenAI

Há duas opções:

- **Compartilhada:** defina `OPENAI_API_KEY` no servidor e mantenha `keyType=compartilhada` no painel.
- **Própria da empresa:** em **Módulos e configurações → Cadastrar chave OpenAI**, salve a chave; selecione a referência mascarada na configuração da IA e escolha `keyType=propria`.

No mesmo formulário, habilite a IA, escolha o modelo, prompt, personalidade e limites. O WAIA usa a Responses API para perguntas livres; menu, compra, PIX, comprovante e confirmação continuam determinísticos. O runtime não envia PIX nem bytes do comprovante ao modelo. Para o piloto, avalie e fixe um snapshot; o padrão atual é `gpt-4.1-mini-2025-04-14`. Cada chamada envia o `X-Client-Request-Id` correlacionado e registra apenas o `x-request-id` técnico devolvido. Revise `OPENAI_PRICING_CATALOG` com fonte e versão antes de tráfego real.

Regras públicas do local, como vestimenta e benefícios de aniversariante, devem ser cadastradas em **Módulos e configurações → Identidade e atendimento → Regras do estabelecimento**. Elas entram no contexto validado da empresa enviado à IA, subordinadas às regras imutáveis da plataforma; não use esse campo para credenciais, PIX ou dados pessoais.

## 4. Google Sheets

### Preparar o Google

1. Crie ou selecione um projeto Google Cloud e habilite a Google Sheets API.
2. Crie uma conta de serviço e uma chave JSON.
3. Compartilhe somente a planilha da empresa com o `client_email` do JSON e conceda o menor acesso necessário.
4. Preserve estas abas e colunas:

   - `Agenda!A2:I`: `id`, `data YYYY-MM-DD`, `dia`, `hora HH:MM`, `atrações`, `preço`, `regra VIP/aniversariante`, `observações`, `status`.
   - `Configurações!A2:C`: chave na coluna A e valor na B. São importadas somente `endereco`, `link_cardapio` e `regra_aniversariante` (com aliases compatíveis).
   - `Pedidos!A:G`: recebe data, telefone, evento, nome, ID do comprovante, `Aguardando conferência` e observação vazia.

Mantenha PIX e favorecida no cofre/formas de pagamento do painel, não na planilha.

### Ligar no WAIA

1. Selecione a empresa e abra **Módulos e configurações → Integrações → Configurar Google Sheets**.
2. Cole somente o ID da planilha, confirme os três ranges e cole o JSON completo da conta de serviço.
3. Ao salvar, o painel guarda o JSON cifrado, habilita a integração e executa uma sincronização imediata.
4. Uma sincronização saudável importa os eventos ativos e futuros. O worker repete a leitura a cada `GOOGLE_SHEETS_SYNC_INTERVAL_MS` (padrão: 120 segundos).

PostgreSQL continua sendo a fonte de verdade operacional. Se o Google falhar, o último snapshot válido é preservado; pedidos já ficam persistidos no banco e a exportação é retomada por job idempotente.

## 5. Checklist antes do primeiro teste real

- Empresa piloto com estado `ativa` somente após readiness e autorização.
- Módulos `orders`, `events`, `payments`, `ai_freeform` e `external_integrations` habilitados.
- Número Meta ativo/principal, token salvo e webhook assinado em `messages`.
- Forma de pagamento real cadastrada no cofre e vinculada ao PIX.
- IA habilitada com chave compartilhada ou própria.
- Google Sheets com estado `saudavel` e eventos futuros importados.
- Teste inicial usando um número e dados exclusivos de homologação, antes de tráfego de clientes.
