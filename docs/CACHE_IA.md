# Cache da IA — medição antes de otimizar

## Escopo autorizado e estado

Pedido de 25/11/2026: reduzir o custo das conversas sem mudar o atendimento. Primeira etapa preparada no checkout estável WAIA, branch `dev`, sobre `576f6c0`/1.30.0, como candidata **1.31.0**. Ainda sem commit, push ou publicação.

Esta etapa observa o cache que a OpenAI já pode aplicar automaticamente. Roteiro completo, histórico, modelo, schema de resposta, agrupamento de mensagens, contingências, triagem, timers e follow-up conservam o caminho atual. Nenhum parâmetro de cache foi acrescentado à requisição. Nenhuma configuração de empresa foi editada.

O custo anterior alimenta a quota mensal. Para preservar o comportamento de bloqueio, a reserva e a finalização da quota continuam usando todos os tokens e a tarifa comum de entrada/saída. A nova estimativa com cache é informativa e independente do saldo de quota. Descontar cache da quota será uma decisão posterior, não parte desta etapa.

## O que passa a ser medido

- `cachedInputTokens`: parcela de `input_tokens` reportada em `usage.input_tokens_details.cached_tokens`; não é um consumo adicional.
- `cacheWriteInputTokens`: tokens cobrados como gravação de cache quando informados pelo provedor. Modelos anteriores que informam leitura, mas não têm esse campo, são tratados com zero gravação.
- `cacheAdjustedCost`: estimativa em US$ usando tarifa comum para entrada não reaproveitada, tarifa de cache para entrada reaproveitada e tarifa de saída.
- A medição agrega até as duas chamadas do turno. Se uma não informar cache, o agregado fica desconhecido, evitando apresentar uma taxa parcial como se cobrisse o turno inteiro.
- Sucesso, resposta incompleta e falha de validação preservam o consumo efetivamente reportado. Ausência de resposta do provedor não gera tokens presumidos.

Atendimento normal e geração de follow-up usam a mesma coleta de uso. O follow-up mantém seu prompt separado; esta entrega não modifica o conteúdo dele.

## Precisão e limites

A migração aditiva `064_ai_cache_usage.sql` inclui três colunas anuláveis em `uso_ia`, com limites de contagem e custo não negativo. Os registros anteriores continuam com cache desconhecido; não há recomposição retroativa nem alteração de saldos.

Medição ausente ou inválida aparece como `null`/`—`, distinta de zero informado. A estimativa também fica desconhecida se houver leitura sem tarifa cadastrada ou gravação de cache positiva: as tarifas de gravação variam por modelo e prazo e não são presumidas nesta etapa.

O catálogo padrão de `gpt-4.1-mini` e `gpt-4.1-mini-2025-04-14` passa a incluir entrada em cache a US$ 0,10/milhão; entrada comum US$ 0,40 e saída US$ 1,60 permanecem iguais. Revisão de preço: `openai-2026-11-25-cache-v1`. Uma sobrescrita do catálogo substitui a entrada inteira do modelo: não herda automaticamente o desconto padrão.

Fontes oficiais consultadas em 25/11/2026: [preços GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini) e [Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching). Cache reaproveita processamento do prefixo; a resposta continua sendo gerada para a solicitação atual. Uma chave de conversa ou `previous_response_id`, por si só, não elimina a cobrança do contexto anterior: [estado de conversação](https://developers.openai.com/api/docs/guides/conversation-state).

## Consulta pelo painel

Em **Consumo de IA**, cada registro mostra entrada, entrada reaproveitada, gravação de cache, saída, base da quota e estimativa com cache. Os dois valores monetários são apresentados em **US$**, com precisão suficiente para chamadas pequenas; antes o formatador genérico apresentava a estimativa em R$ sem conversão.

A API administrativa preserva os filtros por modelo, conversa, período e empresa; acrescenta metadados de cache, provedor e versões de configuração/preço, sob a permissão existente de consumo. Não há nova rota pública, acesso a roteiro, mensagem, segredo ou credencial.

## Validação

Os testes específicos com respostas simuladas verificam igualdade do payload de geração e da quota, cálculo de custo, ausência versus zero, metadados inválidos, tarifa ausente, gravação sem tarifa, agregação na reavaliação, falha de validação e geração/bloqueio de follow-up. A validação PostgreSQL usa apenas dados sintéticos no banco isolado existente de `waia-test`, incluindo persistência, idempotência, isolamento e limites das colunas.

Resultados finais:

- Node 24.18.0 local: **819 aprovados, 35 condicionais ignorados, zero falhas**. Log: `.tmp/ai-cache/unit-final.tap`.
- Node 22 na imagem 1.30.0 existente, com a fonte da candidata montada e sem rede: **80 testes afetados aprovados**, incluindo publicação dos assets e montagem do pacote de produção. Os oito testes de cache foram repetidos após o ajuste final de tolerância a tarifa opcional inválida; aprovados. Logs: `.tmp/ai-cache/node22.tap` e `.tmp/ai-cache/node22-cache-final.tap`.
- PostgreSQL real no banco isolado `waia_v2_upgrade` do projeto existente `waia-test`: **um cenário integrado aprovado**, com persistência, leitura administrativa, RLS, finalização idempotente, limites das colunas e quota sem desconto. Contagens e hashes dos dados das **142 tabelas anteriores preservados**, desconsiderando apenas as três colunas aditivas de `uso_ia`; migração 064 exercitada. Contêiner devolvido ao estado parado. Executor: `.tmp/ai-cache/validate-postgres.mjs`.
- `git diff --check` aprovado. Sem nova dependência.

Nenhum teste simulado comprova cache real, economia efetiva ou entrega no WhatsApp. A medição real só começa depois da publicação autorizada.

## Arquivos para revisão e commit

- `src/modules/ai/usage.js`, `pricing.js`, `ai-service.js`, `memory-adapters.js`, `postgres-adapters.js`.
- `src/modules/follow-up/ai.js`.
- `db/migrations/064_ai_cache_usage.sql`.
- `src/modules/admin/postgres-admin-repository.js`.
- `panel/app.js`, `panel/ai-usage.js`.
- `src/operations/static-assets.js`, com o novo módulo na lista de publicação do painel.
- `test/ai-cache.test.js`, `test/ai-cache-postgres.test.js`, `test/ai-multitenant.test.js`.
- `docs/CACHE_IA.md`, somente as novas entradas desta etapa em `PLAN.md` e `RELATORIO.md`.
- Somente a exceção de `docs/CACHE_IA.md` em `.gitignore`.
- `package.json`, `package-lock.json` em 1.31.0.

São 20 arquivos. Alterações locais anteriores de publicação/documentação e os arquivos preexistentes em `.tmp/` e `infra/postgres/init-v2-test.sh` ficam fora da candidata. Os novos logs/harness em `.tmp/ai-cache/` são evidências locais, não arquivos do produto.

Mensagem proposta: **`v1.31.0 - mede cache da IA sem alterar atendimento e quotas`**. Commit e push de `dev` exigem a confirmação prevista em `AGENTS.md`; deploy e próxima etapa têm aprovação própria.

## Publicação e continuação

Após autorização específica de publicação, executar o procedimento de `docs/OPERACAO_RELEASE.md`: mesma imagem validada, backup conferido, migração 064 antes de ativar API/worker e publicação do painel incluindo `ai-usage.js`. Em retorno à imagem anterior, as colunas podem permanecer; o código anterior as ignora e grava `null` nos campos novos. Não é necessário apagar dados ou restaurar banco para retornar o runtime.

Observar chamadas normais por empresa, modelo e revisão, incluindo atendimentos curtos/longos e follow-up. Comparar entrada total, parcela reaproveitada, registros sem medição e diferença entre as estimativas, sem extrapolar o desconto de uma parcela para a conversa inteira.

Só depois propor a segunda etapa: otimizar prefixo/chave de cache conforme o modelo efetivamente usado e os dados observados. Preservar o texto das instruções e testar equivalência antes de publicar qualquer reorganização. Não há resumo de histórico, recorte de roteiro, troca de modelo ou ativação de retenção ampliada nesta primeira etapa.
