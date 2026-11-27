# Turim — correções de processamento 1.31.1

Pedido de 27/11/2026: investigar três atendimentos apresentados pelo titular, corrigir na linha estável, fazer commit e aguardar autorização para publicar em produção. Base local `dev`/`a952180` (1.31.0); alterações locais anteriores preservadas. Produção consultada somente em leitura: release 1.30.0, Turim ativa na revisão 35, modelo `gpt-4.1-mini-2025-04-14`.

## Diagnóstico

| Caso | Evidência de produção | Causa reproduzida e correção |
| --- | --- | --- |
| Pedido de fotos do Polo, 27/11 às 08h39 | `AI_INVALID_CATALOG_SELECTION`, após consumo de duas respostas | O guarda de consentimento não reconhecia “puder me encaminhar fotos”; o detector de detalhes também perdia comandos em linhas posteriores. Ambos passam a reconhecer o pedido, mantendo recusa, escolha inequívoca de IDs e envio antes de concluir a triagem. |
| Interesse em hatch até 50 mil, 26/11 às 19h26 | `invalid_json_schema`, zero tokens | Mensagens originais multilinha eram inseridas literalmente em enums de evidência comercial. Reproduzido na OpenAI com texto fictício: HTTP 400 informa que `\n` não é aceito nesses literais com `strict=true`. A normalização de espaços fica restrita ao formato enviado; o parser continua comparando com as mensagens originais. |
| Troca do Onix, nome e quitação, 27/11 às 11h07 | `AI_INVALID_LEAD_QUALIFICATION`, duas respostas, nenhuma ficha | Não havia foto armazenada: o anexo era vídeo, sem mídia armazenada pelo fluxo atual. “Já quero trocar, mas não sei como fazer” não entrava na confirmação comercial, deixando o encerramento sem caminho elegível. A intenção de trocar em negociação de veículos passa a ser reconhecida com evidência original; manutenção, perguntas hipotéticas e recusa continuam excluídas. Vídeo entra apenas como metadado de recebimento, sem análise nem contagem como foto. |

Os três chats estavam pausados após mensagens pelo WhatsApp Business; nenhum tinha ficha criada. Não foram retomados, reprocessados ou reenviados. O JSON bruto das respostas antigas não é retido: os códigos e a ausência de mídia/ficha são observados; o ponto exato de cada saída do modelo é limitado pelas evidências disponíveis. As causas do catálogo e da elegibilidade foram reproduzidas pelos guardas e por respostas sintéticas, sem presumir que representam o JSON histórico descartado.

A validação externa também revelou `awaiting_name` acompanhado de nome já escrito na assinatura. Quando o interesse e os demais critérios são válidos, um nome literal em linha original permite normalizar essa inconsistência para conclusão, sem uma segunda chamada. Nome inventado continua recusado. A espera de **15 minutos** permanece para ficha válida faltando realmente o nome, conforme o contrato existente.

Se o modelo omitir o nome do metadado mas usá-lo na saudação, esse candidato ainda precisa coincidir com uma linha original inteira. Na conclusão comercial sem novo pedido de catálogo, referências espontâneas a veículos do estoque são removidas do texto público; a ficha validada e as respostas a pedidos atuais permanecem. Isso evita finalizar sugerindo como manual um veículo automático. Não altera a consulta de catálogo nem as galerias solicitadas.

## Validação e limites

- Quatro regressões iniciais falhavam antes da correção; os novos casos incluem também retenção/guardrails do metadado de vídeo e assinatura literal sem pergunta prévia de nome.
- Suíte Node local final: **826 aprovados, 35 condicionais ignorados, zero falhas**, 861 casos. Executada com concorrência 2 após um timeout no teste de segurança de dependência sob concorrência padrão; esse teste passou isoladamente. Sintaxe dos sete arquivos de runtime alterados conferida.
- IA OpenAI real final: **três cenários aprovados, uma chamada por cenário**, com catálogo e roteiro sintéticos, usando a candidata apenas em memória e a credencial pelo cofre existente. Contabilidade volátil, sem envio de conversas de clientes, mensagens WhatsApp, fichas, escrita no banco ou mudança de configuração. O formato anterior reproduziu o 400; as execuções intermediárias encontraram a inconsistência de nome e uma sugestão indevida de veículo, corrigidas antes da execução final. Esses testes não comprovam entrega externa nem cobrem todas as respostas futuras.
- Docker local indisponível (`dockerDesktopLinuxEngine` ausente); PostgreSQL/Redis reais e build local não executados. Não há mudança de persistência, migração ou dependência nesta correção.
- `git diff --check` aprovado; manifests atualizados para **1.31.1**. A base inclui a medição de cache 1.31.0 já commitada e ainda não publicada: um deploy futuro também precisa considerar sua migração aditiva 064 e seus gates próprios.

Referência do contrato da API: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). O erro específico de literal com quebra de linha foi confirmado diretamente pelo provedor no teste fictício.

## Conjunto do commit

- IA: `src/modules/ai/ai-service.js`, `conversation-context.js`, `inbound-content.js`.
- Atendimento: `src/modules/business/catalog-sales.js`, `commercial-interest.js`, `trade-in-evaluation.js`, `website-catalog-interaction.js`.
- Regressões: `test/contextual-vehicle-service.test.js`, `test/vehicle-search.test.js`.
- Continuidade: este documento e somente as novas entradas em `PLAN.md`, `RELATORIO.md` e `.gitignore`; versões nos dois manifests.

Mensagem: `v1.31.1 - corrige falhas de catalogo e conclusao da triagem Turim`. O titular autorizou commit no pedido atual. Push de `dev` segue o procedimento do repositório; publicação em produção e promoção de main aguardam autorização específica. Evidências privadas em `.tmp/turim-ai-diagnosis-20261127/`, fora do commit. Alterações anteriores nos documentos e demais arquivos locais ficam preservadas fora desta entrega.
