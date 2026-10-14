# Anúncios para WhatsApp e encerramento comercial — v1.19.0

## Correção preparada — v1.19.1

Diagnóstico real de 14/10/2026: três escolhas de produto às 17:39/17:41 retornaram `AI_INVALID_CATALOG_SELECTION` (OpenAI respondeu, sem falha YCloud ou indisponibilidade do catálogo). Não há armazenamento do JSON recusado; não afirmar conteúdo exato. Reproduzida a rejeição quando a IA preenche `text` com o encerramento, apesar de ação/ID válidos.

- `interest` continua exigindo IDs existentes, ação válida e fechamento habilitado. Prosa e filtros de navegação do modelo são irrelevantes e não são enviados/aplicados; o sistema usa somente a mensagem configurada, sem depender de `text` vazio. Formato, limites, tipos, duplicatas, IDs desconhecidos e dados inválidos permanecem bloqueados.
- Escolha simples inequívoca por nome (“gostei da Harley”, “gostei harley”) ou pela ficha citada (“gostei dessa”) fecha deterministicamente. Dúvida, negação, escolha ambígua ou outro assunto continuam para IA. Não substituir contexto ausente por adivinhação. Nome explícito prevalece sobre citação antiga.
- Guardar apenas o ID limitado de `context.id` de respostas pelo WhatsApp, conforme [contrato oficial YCloud](https://github.com/YCloud-Developers/ycloud-sdk-go/blob/main/model_whatsapp_inbound_message_context.go). Relacionar à ficha confirmada anterior, mesma empresa/conversa, não anonimizada. Não copiar remetente, payload ou imagem da citação. Histórico recebido antes desta correção não ganha contexto retroativamente.
- Encerramento direto passa pelo mesmo checkpoint/retentativa, proteção de envio e registro/pausa pós-confirmação da v1.19.0. Não consome OpenAI nem repete imagem. Falha/ID ausente não pausa; retomada manual e posse humana preservadas. Campos e roteiro atuais da empresa são usados; não alterar estado ativo/suspenso nesta correção.

Candidata baseada em HEAD/c68f774, versão 1.19.1 nos manifests da candidata. Checkout já possui piloto de grupos 1.20 e equipe/MFA; manifests e índices dessa candidata são derivados de HEAD, preservando os trabalhos paralelos e excluindo-os do futuro commit/artefato. Sem nova migração/dependência/credencial. Node 22: 536 casos, 517 aprovados, 19 skips, zero falhas; dois testes PostgreSQL reais aprovados, fixtures próprias removidas e waia-test devolvido parado. Sem envio WhatsApp/OpenAI real ou reset. Whitespace e escopo isolado conferidos. Commit/push/deploy ainda não autorizados.

Arquivos: `src/modules/business/catalog-sales.js`, `src/modules/business/catalog-interest.js`, `src/modules/whatsapp/parser.js`, `src/infra/postgres/repositories/webhook-repository.js`, `src/modules/jobs/handlers.js`, `test/ad-catalog-sales.test.js`, `test/catalog-interest.test.js`, `test/ad-catalog-postgres.test.js`, `test/ai-multitenant.test.js`, `test/ycloud.test.js`, `package.json`, `package-lock.json`, `PLAN.md`, `RELATORIO.md`, `docs/ANUNCIOS_CATALOGO.md`.

Pedido específico da ALFATECH, 14/10/2026. Facebook e Instagram levam para o WhatsApp; não abrange Direct. O usuário colocará o nome do modelo nos próximos anúncios, igual ao da planilha.

## Comportamento

- Preservar `referral.headline/body/source_id/source_type` autenticados pelo webhook YCloud/Meta. Campos têm limites; ignorar mídia, URLs e tracking. Contrato confirmado no [SDK oficial YCloud](https://github.com/YCloud-Developers/ycloud-sdk-go/blob/main/model_whatsapp_inbound_message_referral.go). Dados do anúncio não são instruções, preço atual ou comprovação de estoque.
- Nome inequívoco relaciona o anúncio à ficha atual. Correspondência ambígua/ausente pede esclarecimento; não inferir por potência/autonomia. Entrada genérica usa a saudação configurada; perguntas específicas recebem resposta direta. Preservar o último anúncio até a mensagem em processamento, sem incorporar anúncios posteriores ou de outra conversa/empresa. Uma escolha explícita posterior prevalece no atendimento.
- Dados de preço, cores, disponibilidade e detalhes vêm das fichas atuais. Cores e outros detalhes podem ser preenchidos em Descrição; ausência exige confirmação da equipe. Esta entrega não altera a planilha.
- Catálogo continua em páginas de até três, com abertura, fichas individuais e pergunta separada. Mais opções: “Vou te enviar mais algumas opções que tenho certeza que você vai gostar!” / “Gostou de alguma dessas opções? Gostaria de ver mais modelos?”. Novo pedido geral reinicia a consulta; uma escolha não reenvia foto.
- Novo campo opcional `humanHandoff.salesInterestMessage`, editável no onboarding/Atendimento. Vazio mantém encerramento desativado, preservando revisões anteriores. Exige modo comercial, catálogo saudável e módulo humano habilitado. Mensagem humana geral permanece independente.
- A ação estruturada `interest` exige IDs válidos e nenhum texto/filtro arbitrário. Só para escolha inequívoca, sem dúvida pendente, em qualquer origem. Dúvida, anúncio genérico, agradecimento isolado e pedido de opções não devem finalizar. Classificação semântica depende do modelo; testes com respostas simuladas não comprovam comportamento OpenAI real.
- Mensagem de encerramento desejada: “Ótimo, anotei seu interesse aqui, um de nossos vendedores entrará em contato em breve, Obrigado!”. Não exigir cadastro ausente para concluir. Cliente/telefone/histórico continuam acessíveis no painel; nota interna registra os produtos sem inventar nome/cidade.
- Confirmação do provedor, nota interna e pausa são persistidas na mesma transação. Retry de confirmação não duplica nota. Se um humano assumir durante o envio, sua posse é preservada. Falha de envio/ID ausente não registra interesse nem pausa. A retomada manual continua possível, sem estado `waiting_operator` adicional.
- O encaminhamento é ao painel; não envia aviso externo ao vendedor ou grupo. Grupo único segue pendente de integração/destino. A promessa de retorno depende de acompanhamento humano.

## Persistência e operação

Sem nova tabela/migração/dependência. O envelope JSON existente `mensagens.outbound_payload` também armazena metadados allowlisted de entrada (`adReferral`) e intenção de saída (`salesInterest`). Não armazena payload bruto. Anonimização limpa esse envelope; reset de contato já o remove. Filas continuam contendo referências, sem cópia da descrição ou dados pessoais.

Preparação isolada: HEAD v1.18.2 / d255ec8 mais somente os 22 arquivos abaixo. Alterações anteriores de equipe/MFA e migração 023 fora. Roteiro/orientações preparados no rascunho 32 (18.175 caracteres). Novo campo de encerramento só poderá ser preenchido pelo painel depois do deploy aprovado, antes da publicação. Não há envio WhatsApp/OpenAI real nesta preparação. Leitura atual encontrou ALFATECH ativa e catálogo saudável (cache/config 9), em divergência com a instrução anterior de suspensão; preferência solicitada sem alterar o status.

## Arquivos da candidata

`panel/onboarding.js`; `src/infra/postgres/repositories/webhook-repository.js`; `src/modules/whatsapp/parser.js`; `src/modules/whatsapp/ad-referral.js`; `src/modules/business/catalog-sales.js`; `src/modules/configuration/tenant-runtime-config-v2.js`; `src/modules/configuration/legacy-adapter.js`; `src/modules/runtime/tenant-runtime-config.js`; `src/modules/runtime/router.js`; `src/modules/conversations/postgres-conversation-repository.js`; `src/modules/jobs/handlers.js`; `src/modules/jobs/sales-interest.js`; `test/ad-catalog-sales.test.js`; `test/ad-catalog-postgres.test.js`; `test/ai-multitenant.test.js`; `test/configuration-v2.test.js`; `test/ycloud.test.js`; `package.json`; `package-lock.json`; `PLAN.md`; `RELATORIO.md`; `docs/ANUNCIOS_CATALOGO.md`.

## Validação

Suíte isolada Node 22: 531 casos, 512 aprovados, 19 skips e zero falhas. Dois testes PostgreSQL reais aprovados em `waia-test`: anúncio/follow-up, isolamento, anúncio posterior não contamina mensagem anterior, confirmação concorrente/idempotente, retomada manual sem nova pausa, posse humana preservada, anonimização e regressão de prazo/lotes. Fixtures sintéticas próprias removidas; banco devolvido parado e volumes preservados. Testes sem credenciais/provedores reais.

Rascunho recarregado e comparado ao texto preparado, saudação e mensagem humana geral preservadas. Evidência visual: `.codex/visualizations/2026/10/11/01a12d4f-db8e-70a2-a57c-2edf9fea2937/alfatech-v1190-rascunho32.png` no perfil do usuário. Escopo isolado/whitespace conferidos. O campo novo ainda não foi exercitado no painel de produção, pois depende do deploy. Após apresentação dos 22 arquivos, versão, mensagem e validações, usuário autorizou explicitamente commit/push/deploy/configuração/publicação e determinou suspender ALFATECH. Execução em andamento; evidência final será registrada em `.tmp/DEPLOY_V1.19.0_20261014.md`. Não promover main nem reativar a empresa.
