# Espera das respostas de IA — v1.14.2

Pedido de 11/10/2026, implementado no checkout principal e `dev`, sobre `84f13d9` (v1.14.1). Commit, push de dev e deploy explicitamente aprovados após apresentação; execução em andamento com backup e rollback para v1.14.1. Versão patch conforme orientação do usuário para alterações pontuais. Não conclui a F6 do SaaS.

## Comportamento

Uma resposta bem-sucedida da IA passa por três passos: geração, espera aleatória de 30 a 45 segundos, envio. O relógio da espera começa depois que a IA termina. Falha/contingência, guardrail, menu/respostas determinísticas e mensagens humanas mantêm envio imediato.

O prazo planejado é sorteado uma vez por resposta e persistido em `mensagens.outbound_payload.sendNotBefore`, junto do checkpoint já existente. A espera não usa sleep no worker: o mesmo job vai ao estado delayed do BullMQ e seu horário de disponibilidade também fica no PostgreSQL. Locks e slots por tenant são liberados durante a espera. Outros contatos podem avançar; mensagens posteriores da mesma conversa aguardam o job anterior. Adiamento e conversa ocupada não contam como falhas nem esgotam attempts.

Na retomada, o worker usa a resposta pronta e o prazo persistido. Se a resposta já está no checkpoint, a espera/reinício não causa nova geração. Antes do envio, verifica modo bot, conversa aberta, contato não excluído/bloqueado/pausado e número ativo. Assunção ou pausa cancelam a resposta pendente; a exclusão de contato conclui a outbox e o job atrasado vira duplicata sem envio. Horário inválido e perda de lease impedem o envio.

Intervalo global fixo nesta entrega; não há campo de configuração por empresa. O valor planejado fica entre 30 e 45 segundos; fila congestionada, indisponibilidade e retentativas do provedor podem acrescentar tempo. Não agrupa mensagens novas nem reinicia o prazo a cada mensagem. Preserva o cooldown existente de encaminhamento humano como mecanismo separado.

## Arquivos

- `src/modules/jobs/handlers.js`: checkpoint do prazo, sorteio, adiamento e revalidação do envio.
- `src/modules/jobs/processor.js`, `postgres-repository.js`, `memory-adapter.js`: resultado deferred e persistência/ordem sem registrar falha.
- `src/infra/redis/bullmq-adapter.js`: `moveToDelayed`/`DelayedError`, sem consumir attempts.
- `test/ai-reply-delay.test.js`, `test/ai-reply-delay-postgres.test.js`, `test/ai-reply-delay-redis.test.js`.
- `test/bootstrap-runtime.test.js`, `test/capitao-mor-phase8-isolation.test.js`: fixtures ajustadas para resposta persistida, relógio controlado e verificação após a espera; isolamento/privacidade anteriores preservados.
- `package.json`, `package-lock.json`: 1.14.2, sem mudança de dependências.
- `.gitignore`, `PLAN.md`, `RELATORIO.md` e este documento.

Mensagem proposta: `v1.14.2 - adiciona espera de 30 a 45 segundos após respostas da IA`.

## Verificações e limites

Candidata de HEAD + somente este escopo, excluindo equipe/MFA: Node 22, 471 casos, 453 aprovados, 18 skips, zero falhas. Relógio controlado verifica limites de 30/45 segundos após geração, nenhum envio antecipado, retomada sem nova geração/sorteio, retry, pausas, bloqueio, exclusão, lease perdido, prazo inválido, ordem e liberação dos slots. Regressões mantêm handoff, menus, privacidade e isolamento entre empresas.

Checkout completo em Node 24, com as alterações anteriores preservadas: 475 casos, 456 aprovados, 19 skips opt-in, zero falhas. Versões e whitespace conferidos.

PostgreSQL 16 e Redis reais de `waia-test`, banco temporário exclusivo e fila sintética com nome aleatório: dois testes aprovados. PostgreSQL verifica persistência do prazo e bloqueio da outbox antes da disponibilidade; Redis verifica o adiamento com attempts=1, avanço de outra conversa e ordem. O teste Redis usa prazo curto de 250ms para verificar o mecanismo; os 30–45 segundos são verificados com relógio controlado. Fixtures/banco/fila temporários removidos e serviços devolvidos ao estado parado; dados e volumes existentes preservados.

Nenhuma migração, `.env`, cofre ou tenant real alterado. Sem testes reais de OpenAI/WhatsApp ou publicação desta entrega. O gate de pausa é uma checagem imediatamente antes do envio; mudança concorrente após a checagem e envio já aceito pelo provedor não podem ser recolhidos. Não promete entrega externa exatamente no segundo sorteado nem elimina a janela preexistente entre aceite do provedor e gravação do ID externo.

Evidências locais em `.tmp/ai-delay/node22-tests.tap`, `.tmp/ai-delay/candidate/` e `.tmp/ai-delay/integration-check.mjs`.
