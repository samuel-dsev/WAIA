# Pausa por mensagem no WhatsApp Business — v1.23.0

Atualização em 23/10/2026. A capacidade v1.23.0 foi autorizada, commitada em `b6af531` e enviada a dev. Deploy, alteração na YCloud e publicação da opção da ALFATECH ainda não realizados.

## Complemento de segurança v1.23.1

A auditoria da imagem construída do commit aprovado passou a apontar dois avisos no lockfile anterior, bloqueando o gate de CI. Preparada correção pontual: `zod` 4.4.3 → 4.6.7 e dependência transitiva `ip-address` 10.7.3 → 10.7.4. Metadados e versões das demais dependências foram preservados. A referência mínima do Zod passou para `^4.6.7`.

Referências dos avisos: [Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) e [ip-address](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5).

Imagem de revisão construída com as dependências corrigidas: instalação pelo lockfile e auditoria de produção com zero vulnerabilidades reportadas, 580 testes aprovados/21 skips e sete verificações PostgreSQL reais aprovadas. Código e migração da capacidade anterior não foram alterados. Banco temporário exclusivo removido; waia-test preservado e devolvido parado.

Complemento proposto: `fix: v1.23.1 atualiza dependências sinalizadas na auditoria`, limitado a `package.json`, `package-lock.json`, este documento e às seções desta atualização de `PLAN.md`/`RELATORIO.md`. Commit/push e substituição do deploy aprovado pela v1.23.1 ainda dependem de confirmação específica. A v1.23.0 não foi publicada.

O usuário confirmou ter desativado as mensagens de saudação/ausência do aplicativo. ALFATECH observada suspensa/configuração 33; esse estado deve ser preservado. Rascunho 72 difere da revisão ativa em `/integrations`: antes de publicar a nova opção, alinhar esse ponto pelo painel à revisão ativa para preservar seu comportamento. A sessão YCloud expirou e exige novo login pelo titular. Nenhuma dessas configurações foi alterada nesta etapa.

## Comportamento

Ao receber um evento autenticado `whatsapp.smb.message.echoes`, o WAIA identifica a empresa, o número comercial e o destinatário. Se a opção publicada `humanHandoff.pauseOnBusinessAppMessage` estiver habilitada, pausa somente a conversa aberta com esse cliente. A retomada é manual pelo painel, independentemente do tempo de retorno configurado para o fluxo de atendimento humano.

O evento é processado fora da fila de IA. Não gera resposta automática, ficha de lead ou notificação ao grupo. Contatos e conversas inexistentes não são criados por esse evento. Histórico, responsável humano e demais conversas são preservados. Respostas/status da API e histórico de importação não acionam essa regra.

A nota interna usa texto fixo, sem copiar o corpo da mensagem, fotos, links ou credenciais. Identificador de mensagem, instante do provedor e vínculo da conversa garantem deduplicação transacional. Mensagens repetidas após retomada manual não pausam novamente; mensagens desconhecidas anteriores à retomada são descartadas pela barreira temporal. A comparação respeita a precisão de segundos do provedor: eventos distintos enviados no mesmo segundo da retomada continuam elegíveis.

O estado pausado bloqueia a permissão das respostas pendentes pelo mecanismo existente. Um envio cuja chamada ao provedor já começou antes da chegada do evento não pode ser desfeito. A pausa depende da entrega do webhook pelo provedor; não é instantânea no momento da digitação.

## Ativação após deploy autorizado

1. Aplicar a migração aditiva `026_business_app_pause.sql`, que acrescenta `conversas.business_app_resumed_at`. Não incluir a migração 023/equipe/MFA, ainda fora desta entrega.
2. Na YCloud da ALFATECH, acrescentar **somente** `whatsapp.smb.message.echoes` ao endpoint atual. Preservar callback, segredo e os eventos `whatsapp.inbound_message.received` e `whatsapp.message.updated`.
3. Pelo onboarding da ALFATECH, marcar **Pausar somente esta conversa ao enviar uma mensagem pelo WhatsApp Business** e publicar a revisão. Preservar status da empresa, grupo, roteiro e demais configurações.
4. Fazer um teste externo: cliente envia uma mensagem, o atendente responde pelo aplicativo Business e a conversa deve ficar pausada. Nova mensagem desse cliente não deve receber resposta automática; outra conversa deve continuar em bot. Retomar pelo painel e verificar que a automação volta.
5. Testar cada dispositivo utilizado pela equipe. A documentação garante eventos do aplicativo e de dispositivos vinculados compatíveis; não presumir suporte a todo aplicativo de computador.

O payload documentado não distingue uma resposta digitada de uma possível automação do próprio aplicativo. Antes de habilitar em produção, conferir as mensagens de saudação/ausência do Business para evitar que uma mensagem automática do aplicativo seja tratada como intervenção humana. Esse comportamento ainda depende de teste real; não foi afirmado como observado nesta preparação.

Referência primária: [YCloud — mensagens enviadas pelo aplicativo Business](https://nndocs.ycloud.com/reference/whatsapp-business-app-sent-message-sync-webhook-examples).

## Validação local

- Candidata isolada construída a partir de HEAD e apenas dos arquivos abaixo, sem alterações de equipe/MFA.
- Node 22 em Docker sem rede externa: **580 aprovados, 21 skips, zero falhas**. As falhas iniciais eram do executor: ambiente de produção herdado da imagem e `/tmp` sem escrita; corrigidos `NODE_ENV=test` e tmpfs, sem relaxar o código do produto.
- PostgreSQL real: **7 verificações aprovadas**, incluindo cinco cenários da nova pausa e regressão de permissão/prazo. Banco e papéis temporários exclusivos no PostgreSQL de `waia-test`; 25 migrações aplicadas, sem 023. RLS testado com usuário sem superusuário/bypass. Apenas os alvos temporários foram removidos e o serviço voltou ao estado parado anterior.
- Testes de assinatura, WABA/número/destinatário, ausência de corpo no controle, histórico/grupos/status, falha de persistência, opção booleana/compatibilidade, duplicidade concorrente, retomada, isolamento e não geração de lead.
- Nenhum atendimento real, envio WhatsApp/OpenAI ou alteração de credenciais/tenant foi feito nesta preparação.

## Arquivos da candidata

1. `db/migrations/026_business_app_pause.sql`
2. `panel/onboarding.js`
3. `src/bootstrap/app-runtime.js` — somente importação e injeção de `PostgresBusinessAppPause`; demais alterações locais preservadas e excluídas da candidata.
4. `src/modules/configuration/legacy-adapter.js`
5. `src/modules/configuration/tenant-runtime-config-v2.js`
6. `src/modules/conversations/postgres-conversation-repository.js`
7. `src/modules/meta/business-app-pause.js`
8. `src/modules/meta/ycloud-webhook-service.js`
9. `src/modules/runtime/tenant-runtime-config.js`
10. `test/business-app-pause-postgres.test.js`
11. `test/configuration-v2.test.js`
12. `test/ycloud.test.js`
13. `package.json`
14. `package-lock.json`
15. `docs/PAUSA_WHATSAPP_BUSINESS.md`
16. `PLAN.md` — somente a seção desta entrega.
17. `RELATORIO.md` — somente a seção desta entrega.

Mensagem autorizada e enviada a dev: `feat: v1.23.0 pausa conversa ao responder pelo WhatsApp Business`.
Deploy e publicação/configuração externa foram autorizados, mas aguardam o complemento de segurança e acesso à sessão YCloud. Depois de publicados, ainda será necessário o teste externo acima para comprovar o dispositivo real.
