# Contexto e agrupamento das respostas de IA — rc.37

## Comportamento vigente, 17/11/2026

No worker de atendimento com IA habilitada, as mensagens de texto da mesma conversa formam um turno. A janela fecha após **15 segundos sem uma mensagem nova**, antes da inferência. Cada chegada atualiza o prazo, sem limitar o número de mensagens. O worker adia o job usando a fila existente, libera locks e slots e mantém PostgreSQL como fonte de ordem, horário e watermark. A geração e o envio podem acrescentar latência aos 15 segundos.

O job mais antigo pode responder ao último texto do turno. Todas as mensagens são fornecidas à IA separadamente e em ordem, sem duplicá-las no histórico. O identificador da última entrada respondida fica ligado ao checkpoint já existente. Jobs posteriores reconhecem o turno respondido, inclusive após reinício. Entradas interativas/mídias mantêm seus contratos operacionais e separam os turnos de texto.

Se chegar outra mensagem durante a inferência, o resultado anterior é descartado e o turno é reprocessado após a nova janela. Uma resposta persistida ainda não enviada também é invalidada se houver entrada posterior; o dispatch revalida isso sob o lock existente da conversa, além de posse, privacidade, canal e recursos. Não se recolhe um envio já aceito pelo provedor.

A espera de 30–45 segundos após a geração foi substituída. `responseDelayEnabled` permanece legível por compatibilidade, mas não desativa o agrupamento dos atendimentos com IA. Adaptadores antigos sem a porta de agrupamento conservam o checkpoint de espera, agora entre 10 e 15 segundos. O painel explica o agrupamento e deixou de oferecer o controle antigo. O cooldown de encaminhamento humano é independente.

## Contexto e decisões

- A IA recebe todas as páginas do histórico retido **daquela conversa e empresa**, desde a primeira mensagem disponível. Não se aplica mais o corte legado de 8/30/100 mensagens. Respostas pendentes, canceladas ou não enviadas, conteúdo apagado/expirado e entradas posteriores à âncora não são tratados como mensagens já conversadas. Citações do WhatsApp são recuperadas quando a mensagem citada ainda está disponível; a validação de dados do cliente usa somente o texto original de entradas, sem atribuir a ele o conteúdo citado.
- O roteiro define objetivos e limites. A ordem das perguntas acompanha o pedido atual; uma confirmação curta se refere à última pergunta enviada. A resposta é gerada pela IA, com ações estruturadas validadas para catálogo e qualificação. Fichas, preços e galerias continuam vindo do estoque validado.
- A ação de simulação requer veículo confirmado e aceite atual ou simulação pendente. Aceitar opções/fotos não aceita uma oferta antiga de financiamento. Uma tentativa de coleta sem esse aceite provoca uma única reavaliação; a repetição da resposta inválida recebe esclarecimento seguro, sem encerrar ou qualificar.
- Pedir fotos de dois modelos envia ambas as galerias; não exige escolher apenas um. Até três veículos podem ser apresentados por turno. A simulação pendente é preservada durante fotos/dúvidas, sem concluir pelo nome informado junto de outro pedido. Recusa/cancelamento explícitos têm estado próprio.

Os limites de retenção, orçamento e contexto do fornecedor continuam aplicáveis. Históricos extensos aumentam tokens/custo; não há resumo que substitua silenciosamente mensagens antigas. Indisponibilidade ou estouro do limite do fornecedor seguem a contingência existente. Os testes usam texto e provedores sintéticos; não certificam qualidade de uma chamada real de IA ou entrega no WhatsApp. Evidências/versão no [relatório ativo](../WAIA_EVOLUCAO_RELATORIO.md).

## Histórico preservado — entrega v1.14.2

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
