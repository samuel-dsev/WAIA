# Catálogo: um produto por mensagem

## Candidata v1.17.0 — seleção completa e testes sem espera

v1.16.0 publicada como `ffcc557`. ALFATECH reativada com autorização e configuração 11 ativa. Teste real enviou uma imagem e um texto, ambos entregues/lidos: a IA selecionou só um ID apesar do pedido dos três modelos. O transporte confirmou todos os blocos preparados; não havia dois produtos pendentes na fila.

A correção completa uma seleção válida parcial em pedidos explícitos de dois/três/todos os modelos sem filtros (incluindo a frase exata do teste). Acrescenta somente produtos elegíveis da própria empresa e unidade pertinente, até três. Modelos específicos, exclusões, especificações e mensagens compostas fora dessa forma permanecem sob seleção contextual da IA. Se ela ainda pergunta cidade/nome sem selecionar nenhum produto, essa pergunta é preservada. A seleção inválida continua recusada antes de qualquer complementação; fotos/preços continuam vindos das fichas validadas.

`ai.responseDelayEnabled` permite desmarcar “Aguardar 30–45 segundos antes de enviar a resposta da IA” em Onboarding → IA. Não altera o retorno após handoff ou limites de uso. Configurações antigas mantêm a espera por padrão e seu checksum: o campo só é materializado quando fornecido. Sem espera, prazo imediato é persistido e a autorização de envio continua revalidada; prazos de respostas já preparadas são preservados nas retentativas.

Validação: candidata isolada em Node 22, 503 casos/485 aprovados/18 skips/zero falhas. Testes específicos cobrem pedido real com seleção de um ID, disponibilidade, unidade, filtros/exclusões, IDs estrangeiros, ausência de seleção, envio imediato, isolamento da opção por empresa, bloqueio durante geração e retomada sem repetir blocos confirmados. UI local sintética confirmou falso salvo após recarregar. Sem nova chamada OpenAI/WhatsApp ou testes PostgreSQL/Redis nesta correção; checkpoint/banco não mudaram. Produção ainda usa v1.16.0 com espera ativa; aplicação depende de publicação da candidata e configuração da ALFATECH pelo painel.

Mensagem proposta: `feat: v1.17.0 completa catálogo solicitado e permite resposta sem espera`.

16 arquivos para esta candidata:

1. `src/modules/business/catalog-messages.js`
2. `src/modules/ai/ai-service.js`
3. `src/modules/configuration/tenant-runtime-config-v2.js`
4. `src/modules/configuration/legacy-adapter.js`
5. `src/modules/jobs/handlers.js`
6. `panel/onboarding.js`
7. `test/catalog-product-messages.test.js`
8. `test/catalog-message-delivery.test.js`
9. `test/ai-reply-delay.test.js`
10. `test/configuration-v2.test.js`
11. `test/ai-multitenant.test.js`
12. `package.json`
13. `package-lock.json`
14. `PLAN.md`
15. `RELATORIO.md`
16. `docs/CATALOGO_MENSAGENS.md`

Após aprovação de commit/push/deploy: publicar a mesma candidata, desativar a espera somente na ALFATECH pelo onboarding e publicar a configuração. Nenhuma alteração no roteiro é necessária para a instrução de quantidade incluída pelo runtime. Lotes persistidos permanecem compatíveis com v1.16.0; antes de voltar a ela, republicar a configuração sem o campo novo, que a versão anterior não reconhece. Rollback para versões anteriores a v1.16.0 mantém o cuidado com lotes descrito abaixo.

## Registro da entrega v1.16.0

Pedido de 13/10/2026: substituir o bloco único de produtos por mensagens individuais, cada uma com a foto do produto e as informações na legenda. Base publicada v1.15.1 (`7d82895`). Implementação local concluída; commit, push de dev, deploy e publicação do roteiro explicitamente autorizados pelo usuário; execução em andamento. Evidência final será registrada em `.tmp/DEPLOY_V1.16.0_20261013.md`.

## Comportamento

- A IA recebe o catálogo Google Sheets saudável e escolhe até três IDs de produtos pertinentes ao interesse, unidade e histórico. O backend resolve apenas IDs do catálogo validado da própria empresa, monta as legendas e seleciona a foto exata de cada ficha. IDs inexistentes/inativos/indisponíveis, duplicação, JSON inválido ou saída truncada geram contingência; JSON nunca vai ao cliente.
- Cada produto com foto vira uma mensagem `image` com `link` e `caption`. Nome, preço, marca/categoria, potência, autonomia informada, unidades, ressalva de disponibilidade e descrição vêm dos dados aprovados. Texto livre posterior é opcional, para uma resposta ou pergunta útil. Sem foto, o mesmo produto aparece em seu próprio bloco textual.
- A legenda é limitada a 1024 caracteres e abre com nome/preço; descrições extensas são abreviadas. Preço ausente exige consulta, `on_request` é explícito, e a ficha não representa garantia de estoque. Unidades longas são abreviadas a 200 caracteres.
- O comando determinístico `catalog.list` usa o mesmo formato para fichas Google Sheets/com foto. Catálogo legado sem mídia mantém seu formato de texto. Não altera agenda, condições comerciais ou envio de grupos.
- Histórico de imagens enviadas considera a legenda para evitar repetir fichas; imagens recebidas não são tratadas como analisadas.

## Fila e persistência

Sem migração ou dependência nova. A transação existente salva um registro `mensagens` por bloco, com sequência própria e status/external ID próprios. O primeiro mantém `source_message_id`; `outbound_payload.partIds` ordena os registros e `parentReplyId` associa os demais. Restrição existente continua garantindo um checkpoint principal por entrada.

A espera de IA de 30–45 segundos vale para o conjunto após geração. Envio sequencial revalida conversa, contato, número, empresa ativa e lease antes de cada bloco. Retentativa/reinício reutilizam a seleção e ignoram blocos com external ID confirmado; pausa/handoff/bloqueio/suspensão impedem continuar. Existe a janela de incerteza já presente no envio externo entre aceitação do provedor e gravação do external ID: não afirmar entrega exatamente uma vez.

Rollback para v1.15.1 é permitido antes do primeiro lote ou após concluir/cancelar lotes pendentes. A versão antiga não entende `partIds`; com lote pendente, preferir correção adiante ou concluir a operação antes de voltar. Não restaurar dados para reverter apresentação.

## Validação

- Testes direcionados de seleção, vínculo foto/ficha, preço, disponibilidade, legenda, gateways Meta/YCloud, fila/retentativa e pausas aprovados.
- Candidata isolada de HEAD, sem equipe/MFA, Node 22 e sem rede: 495 casos, 477 aprovados, 18 skips opt-in, zero falhas. Saída inválida mantém o consumo informado pelo provedor; aceitação sem external ID bloqueia retry automático e os demais blocos.
- PostgreSQL real em `waia-test`: checkpoint simples e três imagens, gravação atômica/ordem, reentrada sem duplicar registros, status por bloco, isolamento de tenant, cancelamento seletivo e suspensão. Dados/volumes anteriores preservados; registros sintéticos removidos e PostgreSQL devolvido ao estado parado.
- As três fotos atuais em J2:J4 responderam HEAD 200, `image/jpeg`, menos de 100 KB, sem ler conteúdo binário ou registrar URLs em documentação.
- Roteiro da ALFATECH atualizado pelo painel somente no rascunho: até três modelos por resposta, um por mensagem, imagem e legenda. Não publicado nesta etapa. Não houve chamada OpenAI real ou envio WhatsApp real.

## Arquivos e aprovação

Mensagem aprovada: `feat: v1.16.0 catálogo com imagem e legenda por produto`.

Arquivos deste escopo:

1. `src/modules/business/catalog-messages.js`
2. `src/modules/business/handlers.js`
3. `src/modules/runtime/router.js`
4. `src/modules/whatsapp/outbound.js`
5. `src/integrations/meta/meta-gateway.js`
6. `src/modules/ai/ai-service.js`
7. `src/modules/ai/guardrails.js`
8. `src/modules/jobs/reply-batch.js`
9. `src/modules/jobs/handlers.js`
10. `test/catalog-product-messages.test.js`
11. `test/catalog-message-delivery.test.js`
12. `test/ai-multitenant.test.js`
13. `test/ai-reply-delay-postgres.test.js`
14. `package.json`
15. `package-lock.json`
16. `PLAN.md`
17. `RELATORIO.md`
18. `docs/CATALOGO_MENSAGENS.md`

Alterações preexistentes de equipe/MFA, portal, painel e configuração geral ficam fora do commit/artefato. Após aprovação: commit/push de dev, artefato imutável e backup, deploy, publicação do roteiro pelo painel e teste controlado de WhatsApp.

## Referências oficiais

- [OpenAI: Structured Outputs no Responses](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses): `text.format`, esquema estrito e enum de IDs; validação adicional no backend.
- [YCloud: exemplos de mensagens](https://docs.ycloud.com/reference/whatsapp-messaging-examples): imagem com link/legenda via `sendDirectly`; a página de referência estava redirecionando no acesso direto, mas o exemplo oficial foi obtido pelo índice de busca. [SDK oficial](https://github.com/YCloud-Developers/ycloud-sdk-node) confirma a API v2. Testes usam transporte sintético; entrega real continua pendente.
