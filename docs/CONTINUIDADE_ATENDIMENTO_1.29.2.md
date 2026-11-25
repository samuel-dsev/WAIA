# Continuidade do atendimento — candidata 1.29.2

Correção local em 25/11/2026 no checkout principal WAIA, branch `dev`, sobre `38e294a`/runtime publicado `aea40aa` (1.29.1). Escopo: compreensão contextual e recuperação das falhas apresentadas nos quatro prints da Turim Autos. Sem alteração de roteiro publicado, critérios comerciais, configurações por empresa, follow-up, envio de galerias ou pausas manuais.

## Diagnóstico confirmado

Consulta de produção somente em leitura confirmou Turim ativa na revisão 34, modelo `gpt-4.1-mini-2025-04-14`, runtime 1.29.1 e worker sem reinícios. Nos quatro atendimentos: timeout após o envio dos dados de financiamento; rejeições `AI_INVALID_CUSTOMER_SERVICE` e `AI_INVALID_CATALOG_SELECTION` nos demais turnos. A frase de não entendimento também era usada para falhas técnicas; sua supressão nos erros posteriores deixava novas mensagens sem resposta.

Reprodução com mensagens fictícias e IA real mostrou respostas públicas úteis acompanhadas de metadados inválidos: interesse comercial confirmado sem evidência de consentimento; aceitação de simulação confundida com intenção comercial independente; recorte ou combinação indevida de evidências. A reavaliação genérica orientava principalmente sobre garantia e podia repetir o erro em outro campo. A oferta de follow-up com uma frase explicativa depois da pergunta também perdia a identificação da pergunta pendente.

## Correção

- Retomar a última pergunta útil e todo o histórico retido após contingência ou falha técnica. Reconhecer oferta com explicação posterior, aceite acompanhado de agradecimento/saudação e coleta escrita sem interrogação.
- Impedir combinações inválidas de status/evidência comercial no formato enviado ao modelo. As alternativas confirmadas são fundamentadas nas mensagens originais e conferidas novamente pelo parser; saudação, nome e aceite de simulação/fotos não criam consentimento comercial independente.
- Aceitar formas concretas como “estou interessada em comprar” e necessidade de carro para trabalhar, preservando as barreiras contra citações, oferta incorreta e recusa posterior.
- Reparar o campo que falhou, mantendo o limite de duas chamadas, a mesma reserva de consumo e o prazo total existentes.
- Recuperar metadado financeiro omitido quando há pedido de dados, IDs válidos e aceite comprovado. Dúvida sobre possibilidade de financiamento continua sem autorizar coleta.
- Preservar CPF/nascimento enviados após falha e nomes respondidos à pergunta original. Reutilizar nome literal único em ficha que já estava completa faltando apenas a identidade; a validação pelas mensagens originais continua obrigatória.
- Não confundir reconhecimento de fotos adiadas com uma nova oferta, nem descartar uma resposta textual porque seus IDs de contexto incluem mais de um veículo. Ações de galeria/financiamento continuam exigindo os guardas próprios.
- Uma ficha comercial completa não volta à coleta por um convite extra criado pela assistente. Respostas úteis são preservadas; o encerramento usa o fluxo existente.
- Falhas técnicas/contratuais recebem aviso de processamento, sem atribuir incompreensão ao cliente ou silenciar a próxima falha. A contingência sem repetição permanece reservada à ambiguidade semântica.

## Regra sem nome preservada

Conferidos o chat **“Enviar leads sem nome ao grupo”**, os commits `1f92358` e `aea40aa`, [o contrato](TRIAGEM_SEM_NOME.md) e o worker atual. Faltando exclusivamente nome, a ficha fica em `awaiting_name`; após **15 minutos sem nova resposta à pergunta confirmada pelo provedor**, encaminha ao grupo e pausa somente o chat. Interesse comercial confirmado também admite esse caminho sem fotos ou simulação. Nome já informado permite conclusão normal. Nova resposta invalida o timer antigo; follow-up não é reiniciado.

A recuperação de ficha com nome ausente/inválido preserva os demais dados validados e prepara a pergunta/checkpoint sem inventar identidade. Não antecipa o disparo ao grupo. Nenhum arquivo do timer, ACK, fila ou política de follow-up foi modificado.

## Validações e limites

- Suíte geral Node 24: **796 aprovados, 33 condicionais ignorados, zero falhas**.
- Checkout atual em Node 22 na imagem existente, com mounts somente leitura: **796 aprovados, 33 condicionais ignorados, zero falhas**. O primeiro harness omitia arquivos usados pelos testes de infraestrutura; os mounts foram corrigidos, sem mudanças no produto para contornar as falhas. Não é imagem nova de release.
- PostgreSQL real/Node 22: **25 aprovados, zero falhas/skips**, cobrindo nome pendente, ficha e follow-up. Reutilizado o banco isolado existente `waia_v2_upgrade`, com hashes/contagens das **140 tabelas anteriores iguais** e contêiner devolvido ao estado parado; sem migração/reset/remoção de volumes.
- IA real autorizada pelo titular: **cinco cenários aprovados** com a configuração publicada da Turim e candidata carregada somente em memória: dados após falha, aceite com saudação, correção da troca, nome/finalidade e retomada da compra após contingência. A execução final fez sete chamadas no total, todas com dados fictícios. A contabilidade do teste ficou volátil; não criou lead, não enviou WhatsApp e não escreveu no banco. A reprodução anterior na 1.29.1 confirmou erros; tentativas intermediárias da candidata revelaram os pontos de recuperação corrigidos acima.
- Evidências locais: `.tmp/continuity-bugs/` (`read-live.log`, `baseline-ai.log`, `candidate-ai.log`, `full-suite.tap`, `node22.tap`, `postgres.tap`). Diagnóstico com dados de clientes permanece local e não integra o commit.

Testes de IA verificam os cenários executados; não garantem todas as respostas futuras do modelo. Não comprovam recebimento de ficha/WhatsApp. Produção permanece na 1.29.1: sem commit, push, promoção, deploy, edição de empresa, reabertura ou reenvio de atendimento nesta etapa.

## Arquivos para revisão

| Grupo | Arquivos |
| --- | --- |
| IA/contexto | `src/modules/ai/ai-service.js`, `choice-clarification.js`, `customer-name-turn.js`, `guardrails.js` |
| Atendimento/catálogo | `src/modules/business/catalog-sales.js`, `commercial-interest.js`, `contextual-vehicle-service.js`, `website-catalog-interaction.js` |
| Dados coletados | `src/modules/group-notifier/collected-financing-data.js` |
| Regressões | `test/choice-clarification.test.js`, `collected-financing-data.test.js`, `contextual-vehicle-service.test.js`, `vehicle-search.test.js` |
| Versão/continuidade | `.gitignore` (exceção somente para este documento), `package.json`, `package-lock.json`, `PLAN.md`, `RELATORIO.md`, este documento |

Versão patch **1.29.2**, sem dependência ou migração. Mensagem: `v1.29.2 - corrige interpretacao contextual e continuidade apos falhas da IA`. Titular autorizou commit e publicação em 25/11/2026 após revisar o conjunto; execução do commit/push de `dev`, gates da imagem e deploy em andamento. O registro operacional posterior manterá a versão e o commit do runtime aprovado.
