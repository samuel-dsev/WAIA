# Atendimento comercial do catálogo — candidata v1.18.0

Base publicada: v1.17.0 / `e50747c`. Pedido de 13/10/2026 preparado localmente, com rascunho da ALFATECH salvo pelo painel. Nenhum commit/push/deploy desta candidata realizado.

## Comportamento preparado

- Saudação e menu: “Olá! Bem-vindo à ALFATECH. Você já tem algum modelo em mente?”. Se já houver modelo, faixa de preço, pedido de opções ou problema, atender esse pedido diretamente. Nome/cidade ficam para a etapa comercial de encaminhamento, aproveitando o histórico. Pedidos explícitos de atendimento humano continuam respeitando as rotas/botão existentes; o roteiro não adiciona uma transferência ou envio a grupo inexistente.
- Pedido geral: abertura em mensagem própria, três primeiras fichas elegíveis na ordem da planilha, pergunta de interesse/mais opções em mensagem final separada. Cada ficha usa foto/preço/descrição do mesmo produto; falta de foto vira ficha textual. Pergunta final não entra nas legendas.
- Modelo específico: ficha direta sem pedir confirmação, seguida de pergunta de interesse/mais opções. Modelo ambíguo/ausente requer esclarecimento, sem substituir por um parecido.
- Faixa de preço/categoria: filtros declarados pela IA e validados/aplicados pelo backend sobre os dados atuais; limites de preço inclusivos. Preço ausente não entra em uma faixa numérica. Não usar o preço genérico de R$ 4.990,00 no lugar do preço de uma ficha.
- “Mais opções”: preservar consulta anterior, mandar os próximos até três produtos ainda não confirmados como enviados e encerrar com pergunta. Ao esgotar, informar que não há mais fichas daquela consulta e oferecer comparação ou alteração de filtro, sem reiniciar ou inventar produtos.
- Dúvida técnica pontual: resposta personalizada de texto usando autonomia/potência/descrição da ficha e o histórico, sem foto automática. A IA recebe a fonte atual e os limites do roteiro; resposta factual real depende de teste com o provedor. Informações ausentes exigem equipe; autonomia informada não garante desempenho em todo uso.

## Implementação e isolamento

Opção de onboarding por empresa: `ai.catalogSalesEnabled`, desativada/omitida por padrão. Omissão mantém checksum e comportamento das revisões existentes. Modo comercial só é usado com catálogo Google Sheets saudável no atendimento de texto livre; não altera menu determinístico, agenda ou outras empresas.

Contrato Responses estrito: `catalogAction` (`browse`, `more`, `products`, `details`, `none`), IDs permitidos, texto e filtros de categoria/preço. Em páginas gerais, backend escolhe as fichas na ordem recebida da planilha, independentemente de IDs arbitrariamente escolhidos pelo modelo. Abertura e pergunta são montadas pelo backend; respostas comuns/encerramento não recebem essas mensagens.

Sem migração ou nova dependência. `catalogProductId` é salvo por parte e `catalogBrowse` no primeiro bloco, na mesma transação do checkpoint. Consulta por empresa/conversa recupera filtro e IDs anteriores, somando somente partes confirmadas pelo provedor. Pergunta/abertura aceitas não avançam fichas pendentes. Retentativa reutiliza as partes e não chama a IA novamente. Reset/retenção do histórico remove esse progresso; produtos excluídos/inativos/indisponíveis não são enviados. Atualizações da planilha podem disponibilizar novos IDs na continuação.

Envio humano, pausa, suspensão, exclusão e lease mantêm os bloqueios existentes. Permanece a janela de incerteza entre aceitação externa e gravação do ID: não prometer exatamente uma vez. Rollback para v1.17.0 exige configuração compatível sem o campo `catalogSalesEnabled`; preferir correção adiante após publicar a opção. Não restaurar dados para desfazer apresentação.

## Roteiro e prova

Rascunho real da ALFATECH: revisão 24, 14.116 caracteres. Texto revisável em `.tmp/alfatech-roteiro-v118-rascunho.txt`; original preservado em `.tmp/alfatech-roteiro-v118-original.txt`. Também atualizados saudação, menu e orientação pública que ainda adiantavam a cidade. Publicação pendente; IA em produção continua com a configuração anterior.

Condições preservadas: motos 1.000 W a partir de R$ 4.990,00, cartão até 18x sem inventar juros, horários de Taubaté e limites das demais unidades/estoque/assistência. Grupo único segue pendente. Não foram cadastrados produtos de teste na planilha real.

Validação: Node 22 em candidata isolada de HEAD + escopo, 514 casos/496 aprovados/18 skips/zero falhas, auditoria de produção zero vulnerabilidades. Testes com oito produtos sintéticos verificam páginas 3/3/2, filtros, ordem, esgotamento, modelo específico, detalhe técnico, IDs inválidos e opt-in. Teste PostgreSQL real de `waia-test` verificou lote de cinco partes, idempotência, avanço só após confirmação, isolamento e cancelamento; registros próprios removidos, volumes preservados e serviço devolvido ao estado parado. Interface sintética salvou a opção e manteve-a ao recarregar. Captura local: `waia-v1180-catalogo-comercial-preview.png`.

Não houve nova chamada real à OpenAI ou WhatsApp nesta implementação. Após publicação, testar saudação, pedido geral, faixa de preço, “mais opções” e pergunta de autonomia; usar fichas reais disponíveis sem inventar estoque.

## Arquivos e aprovação

Versão minor pela capacidade compatível nova. Mensagem proposta: `feat: v1.18.0 atendimento comercial com catálogo paginado`.

1. `src/modules/business/catalog-sales.js`
2. `src/modules/ai/ai-service.js`
3. `src/modules/configuration/tenant-runtime-config-v2.js`
4. `src/modules/configuration/legacy-adapter.js`
5. `src/modules/jobs/handlers.js`
6. `src/modules/jobs/reply-batch.js`
7. `src/modules/runtime/router.js`
8. `panel/onboarding.js`
9. `test/catalog-sales.test.js`
10. `test/catalog-message-delivery.test.js`
11. `test/ai-reply-delay-postgres.test.js`
12. `test/configuration-v2.test.js`
13. `test/ai-multitenant.test.js`
14. `package.json`
15. `package-lock.json`
16. `PLAN.md`
17. `RELATORIO.md`
18. `docs/CATALOGO_COMERCIAL.md`

Após aprovação: commit/push somente desse conjunto, build/backup/deploy do mesmo artefato, habilitar a opção e publicar o rascunho da ALFATECH pelo painel. Manter a espera desativada; não promover main nem incluir equipe/MFA.
