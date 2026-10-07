# YCloud — conexão WhatsApp da Filaretti

Atualizado em 07/10/2026. Escopo incremental: conector YCloud para atendimento por texto e botões, com a coexistência provisionada pelo provedor. Não é conclusão da F5 nem release WAIA 2.0.0.

## Estado

- YCloud: número da Filaretti conectado pelo fluxo WhatsApp Business APP Coexistence; conta empresarial ainda indica `In process`.
- WAIA em produção: empresa Filaretti Advocacia criada pelo painel como rascunho, sem ativação ou credenciais YCloud.
- Conector v1.12.0 versionado no commit `9adaef0` e enviado à `origin/dev` após autorização. Nenhum webhook externo, mensagem real ou deploy realizado por esta implementação.
- Alterações anteriores de equipe/MFA (F2) permanecem no checkout. Não incluir automaticamente essas alterações na release do conector.

## Configuração após publicar o conector

1. Aplicar a migração aditiva 024 e atualizar API, worker e painel como uma única release aprovada. Preservar clientes e volumes existentes.
2. No contexto Filaretti, abrir Onboarding → WhatsApp e Meta → Adicionar conexão YCloud. Informar nome e Company ID da conta YCloud; deixar o segredo vazio nesta primeira gravação.
3. Copiar o callback `/webhook/ycloud/<webhookPublicId>` exibido. Na YCloud, Developers → Webhooks, cadastrar a URL pública HTTPS e assinar somente `whatsapp.inbound_message.received` e `whatsapp.message.updated`. Habilitar assinatura de eventos.
4. Copiar o segredo de assinatura diretamente para Editar conexão YCloud no cofre do painel WAIA. Não usar o App Secret da Meta, não enviar segredos ao chat e não armazenar em `.env` por cliente.
5. Adicionar o número usando os IDs fornecidos pelo provedor, WABA e número internacional. Vincular à conexão YCloud usando a API key da YCloud como credencial; o painel cifra e associa a finalidade `ycloud-api-key` à empresa.
6. Testar saúde. O preflight consulta o número por WABA/E.164 e confirma ID, WABA e estado conectado; não envia mensagens. Ativar e definir o número como principal somente no contexto correto.
7. Completar atendimento, FAQ/IA, equipe e revisão. Sem pagamentos, pedidos ou Google Sheets. Publicar/ativar somente após readiness e teste controlado aprovado.
8. Exercitar mensagem de teste recebida e resposta da WAIA; conferir persistência, outbox, estados de entrega e uso do mesmo número no celular. `Connected` na YCloud e testes locais não comprovam esse gate externo.

## Comportamento e limites

- Credenciais são resolvidas por empresa/número em cada operação. Conexões Meta existentes continuam no Graph API.
- Webhook YCloud exige HMAC-SHA256 sobre `timestamp.corpo_bruto`, comparação constante e tolerância de cinco minutos. Assinaturas inválidas, conexões inativas e WABA/número divergentes são recusados.
- Mensagens e estados válidos reutilizam o parser, persistência transacional, deduplicação e outbox existentes. O ACK ocorre depois da persistência. Histórico, ecos do celular e grupos não disparam IA.
- Esta entrega cobre texto, botões/listas, leitura e estados. Download de anexos pela YCloud não está implementado; o gateway recusa mídia com erro permanente, sem enviar credenciais YCloud para hosts da Meta. Não anunciar suporte a anexos ou sincronização de histórico/inbox do celular.
- O preflight não confirma a revisão empresarial nem que o aplicativo do celular segue operacional. Esses são gates externos.
- Tarifas e condições da YCloud/Meta devem ser conferidas no painel antes de tráfego real. Não contratar upgrade ou recarregar saldo automaticamente.

## Revisão da atualização 1.12.0

Arquivos exclusivos deste escopo:

```text
.gitignore
package.json
package-lock.json
PLAN.md
RELATORIO.md
docs/YCLOUD_FILARETTI.md
db/migrations/024_ycloud_connector.sql
panel/onboarding.js
src/integrations/ycloud/client.js
src/integrations/meta/meta-gateway.js
src/modules/meta/ycloud-webhook-service.js
src/modules/meta/meta-health-service.js
src/modules/meta/multiapp-webhook-service.js
src/modules/meta/postgres-meta-app-repository.js
src/modules/onboarding/postgres-onboarding-repository.js
test/ycloud.test.js
test/ycloud-postgres.test.js
test/meta-bootstrap-routes.test.js
test/postgres-meta-app-repository.test.js
```

Em `src/bootstrap/app-runtime.js`, incluir somente imports, serviço, rota e resolução de credenciais YCloud. Preservar fora do commit os hunks anteriores de IdentitySecurity/AccountRateLimiter e o parâmetro security do runtime de contas. Os demais arquivos anteriores de equipe/MFA, inclusive a migração 023, ficam fora deste escopo.

Validações concluídas:

- Checkout completo: 447 testes, 431 aprovados, 16 ignorados, nenhuma falha.
- Snapshot isolado do conector sobre HEAD, sem alterações F2: 443 testes, 428 aprovados, 15 ignorados, nenhuma falha. Esse snapshot confirma que o conector não depende das alterações anteriores.
- PostgreSQL 16 real no ambiente waia-test: 2 testes aprovados (Meta existente e YCloud), nenhuma falha ou skip, em banco temporário com dados sintéticos. Banco e papéis temporários removidos; PostgreSQL voltou ao estado parado anterior. Dados e volumes existentes preservados.
- Sintaxe do painel e `git diff --check` aprovados.

Mensagem aprovada: `v1.12.0 - integra YCloud ao WhatsApp multiempresa`. Commit/push somente do conector concluídos em `9adaef0`; deploy ainda depende de autorização específica.

## Preparação de deploy e correção 1.12.1

- Auditoria da imagem 1.12.0 detectou `proxy-addr` 2.0.7 (crítica) e `ip-address` 10.5.0 (moderada). Atualização compatível no lockfile para 2.0.8 e 10.7.3, sem modificar os intervalos das dependências diretas. Versão candidata 1.12.1.
- `npm ci`, build Docker e auditoria aprovados; zero vulnerabilidades reportadas. Snapshot com dependências corrigidas, sem F2: 428 testes aprovados, 15 skips opt-in, nenhuma falha.
- Commit aprovado: `v1.12.1 - corrige dependências antes do deploy YCloud`. Arquivos: `package.json`, `package-lock.json`, `PLAN.md`, `RELATORIO.md` e este documento. Commit/push da correção autorizados em 07/10/2026; deploy depende de autorização específica.
- SSH restaurado usando a chave existente, após aprovação e sincronização de regra TCP 22 restrita ao IP atual. Sem rotação de chave ou remoção de regras anteriores.
- Produção atual 1.10.6; readiness 200; backup local de 07/10/2026 com dump, mídia e manifesto verificados. Imagem antiga disponível para rollback; retorno após migrações precisa preservar o schema aditivo. Entrega offsite não verificada nesta rodada.
- Migrações aplicadas no banco atual: 001–020. A release baseada em dev inclui 021/022 de contas e 024 YCloud; exclui a 023 de equipe/MFA. Revisar esse salto e as configurações obrigatórias antes da promoção.
- Nenhuma imagem transferida, migração aplicada, serviço reiniciado ou versão publicada nesta preparação.

## Fontes

- [Autenticação YCloud](https://docs.ycloud.com/reference/authentication)
- [Configuração e assinatura de webhooks](https://docs.ycloud.com/reference/configure-webhooks)
- [Eventos e payloads](https://docs.ycloud.com/reference/webhook-events-payloads)
- [Envio direto](https://docs.ycloud.com/reference/whatsapp_message-send-directly)
- [Consulta do número](https://docs.ycloud.com/reference/whatsapp_phone_number-retrieve)
- [Coexistência](https://helpdocs.ycloud.com/help-center/whatsapp-accounts-management/create-a-whatsapp-api-account/whatsapp-business-app-coexistence)
