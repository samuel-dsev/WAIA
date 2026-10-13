# Catálogo: um produto por mensagem — candidata v1.16.0

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
