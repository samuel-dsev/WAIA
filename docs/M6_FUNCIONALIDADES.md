# M6 — funcionalidades de atendimento

Fechamento em 25/10/2026, America/Sao_Paulo. Checkout principal `new`, base
**31730d6 / 1.28.0**. M6 autorizada pelo usuário e retomada do checkout existente.
Entrega **1.29.0**, com commit local no fechamento conforme AGENTS. Sem push,
promoção, deploy ou avanço para M7. A versão estável 2.0.0 permanece futura.

## Uso do portal

No [portal local](http://127.0.0.1:5035/portal/), abra uma empresa. **Recursos do
atendimento** distingue o conteúdo liberado para preparar no rascunho da situação
do atendimento publicado. Os sete recursos são mensagens, informações/horários,
roteiro/estilo, respostas predefinidas, encaminhamento humano, qualificação e
confirmação de interesse comercial. Cada campo informa seus limites e orientações.

Os estados são **Não liberado**, **Preparado no rascunho**, **Precisa de liberação
administrativa**, **Empresa suspensa** e **Disponível no atendimento**.
Uma habilitação no rascunho não ativa o recurso nem altera a revisão em uso.
Dependências indisponíveis exigem atuação administrativa; nenhum detalhe técnico
da pendência é devolvido ao cliente. Disponibilidade usa metadados locais e não
equivale a uma verificação externa em tempo real.

**Comportamentos liberados pela administração** é somente leitura: espera da IA,
pausa ao responder pelo aplicativo, atendimento comercial e triagem de novos
interessados. Mostra separadamente rascunho e revisão publicada. Não há switches
para alterar módulos, prazo de espera, retomada automática, quotas, fornecedores,
credenciais, números, conexões, planilhas, grupos, remetente ou destinos.

Salvar continua sendo apenas draft; simulação/publicação seguem a M5. Uma empresa
suspensa permite preparar conteúdo conforme o vínculo, sem operar ou reativar.
Revalidação de permissões/recursos durante edição mantém o texto local, torna os
campos removidos somente leitura e exige recarga antes de salvar/publicar. Troca
de empresa e descarte continuam protegidos pelo escopo de requests da M3/M4.

## Catálogo e efeito real

`src/modules/attendance/feature-catalog.js` contém catálogo fechado de negócio,
limites e orientações. Não é o catálogo administrativo de módulos/ações. O novo
GET `/api/app/v1/companies/:id/capabilities` exige sessão e `attendance.read`,
revalida vínculo e retorna somente `companyId`, capacidades efetivas, `features`,
`behaviors`, `fieldLimits` e `guidance`. O mesmo catálogo aparece em `resources`
no DTO de atendimento. `enabled`/`canEdit` descrevem os campos autorizados no
rascunho; `state` descreve o uso da versão publicada.

A allowlist de conteúdo da M4 permanece: não se adicionaram caminhos livres,
flags de módulos ou parâmetros técnicos ao PATCH. Módulo desabilitado omite seus
campos, orientações e limites; injeção pelo HTTP/serviço é recusada. Módulos
futuros não aparecem nem ganham capacidades por nomes vindos da configuração.
O catálogo nunca devolve documento V2, referências, payload de credencial, IDs
de terceiros, dados de planilha, quotas ou modelos.

Prontidão confere envelope/checksum e a coerência entre modo, revisão ativa e
versão da empresa. Divergência operacional não pode aparecer como recurso pronto
nem ser reparada implicitamente pelo publish customer. Credencial de pagamento
indisponível, que impediria carregar todo o runtime, também impede estado pronto.
Qualificação depende do encaminhamento liberado. Interesse comercial exige
catálogo/IA/handoff habilitados e os modos compatíveis; reutiliza o resolvedor do
runtime para binding publicado, perfil, versão e frescor do cache. Só o resultado
booleano chega ao catálogo, sem expor a conexão.

Horários, fuso e regras públicas passam da revisão V2 para os opcionais já
compatíveis de `runtime.identity`, validados e imutáveis, e daí ao contexto
allowlisted da IA. Não há segunda fonte de roteiro: continua sendo
`configuration.ai.prompt`. Horários são texto informativo, sem criar agenda ou
fechamento automático. Tom complementa o roteiro, subordinado às guardrails.
Saudações podem ceder ao texto do menu; respostas predefinidas precedem a IA.
Com roteiro completo, as perguntas seguem o roteiro e a pergunta adicional não
é anexada automaticamente. Interesse comercial e conclusão de qualificação
mantêm os contratos existentes de seleção/ficha validada e seus gates.

## Revalidação de envio e encaminhamento

O worker revalida estado operacional imediatamente antes de **todo envio
automático**, incluindo saudação/FAQ/fallback imediato e cada parte de um lote.
Guarda ausente, erro ou resultado indefinido falham fechado. Empresa suspensa ou
excluída, conversa fora do estado permitido, contato bloqueado/pausado/excluído/
anonimizado, mensagem redigida ou número indisponível impedem o envio. Opt-out
aqui significa os estados persistidos do contato; não se criou um comando textual
novo como “parar”. Envio humano não foi alterado.

O encaminhamento sem espera já pausava a conversa antes de enviar a confirmação.
Para preservá-la sem abrir exceção genérica à pausa humana, a pausa própria usa
CAS de modo bot/versão observada. Só o retorno interno desse CAS pode gerar
`handoffPauseVersion`, persistido no checkpoint. A guarda exige a mesma versão
da conversa pausada sem operador e checkpoint pendente vinculado ao mesmo inbound.
Saída da IA não cria essa prova. Nova pausa, assunção humana, retomada, outro
avanço da versão ou bloqueio do contato invalidam a confirmação. Retry usa o
checkpoint e não repete a geração. Cooldown positivo preserva seu fluxo anterior.

Limites: permanece uma janela entre a última leitura e a chamada ao gateway;
não há transação distribuída com o fornecedor. Pausa CAS e checkpoint continuam
em transações separadas: interrupção nesse intervalo mantém a pausa e pode perder
a confirmação, sem reativação automática. Resposta já persistida conserva sua
revisão e prazo, conforme contrato anterior; publicar outro roteiro não a recria.

## Validação e continuidade

Snapshot selecionado: **32 arquivos**; Node 22 **680 casos, 652 aprovados,
28 skips opt-in, zero falhas**; **97 integrações PostgreSQL/Redis aprovadas,
sem skips/falhas**. Sintaxe de **326 arquivos JavaScript** aprovada. Sem migração
nova: schema **30**, ledger/checksums e equivalência dos alvos sintéticos
preservados. Novos testes opt-in incluídos na CI; nenhuma execução remota.

Dois roteiros fictícios distintos atravessam runtime e serviço de IA reais com
cliente/ledger fake: contexto próprio, tom, horários/regras e precedência
determinística, sem técnica/vizinho no contexto. PostgreSQL usa role real sem
bypass e cobre DTO/HTTP/capacidades, módulo negado, suspensão, revogação, hashes
técnicos/vizinho, cache comercial inválido, ponte de revisão inconsistente,
guarda operacional e checkpoint/CAS de encaminhamento. Fixtures técnicas de
repositório não equivalem a cadastro de cliente nem comprovam fornecedor externo.

Browser Edge/Playwright usa **APIs reais**, sem fixtures de publicação: catálogo,
limites/orientações, behaviors somente leitura, empresa alheia 404, retirada da IA
pelo admin durante edição, texto preservado, PATCH forçado 403, recarga e remoção
dos campos, salvamento de horários apenas no draft e ausência de overflow em
390px. Capturas desktop/móvel inspecionadas; sem erros de página. Configuração
inicial de Aurora restaurada pela API administrativa e Horizonte intacta; apenas
versões/auditoria sintéticas avançaram. Sucesso de publicação/integrações externas
no navegador não foi alegado.

Revisões independentes de domínio/runtime e segurança incorporadas: correção da
guarda de envio, confirmação CAS, ponte de revisão e dependência obrigatória.
Nenhum bloqueador alto/crítico conhecido no fechamento. Os primeiros ensaios PG
corrigiram apenas fixtures (UUID de correlação obrigatório e captura de validação
síncrona); a rodada final passou integralmente.

Comandos reproduzíveis, após build do target `validation` no snapshot selecionado:

```powershell
rtk proxy docker run --rm --network none waia:v2-test-local npm test
rtk proxy docker run --rm --network none waia:v2-test-local node scripts/check-syntax.mjs
rtk proxy docker compose --project-name waia-test --env-file .secrets/v2-test.env --file infra/compose.v2-test.yml run --rm --no-deps v2-check node scripts/validate-v2-environment.mjs --tests-only
rtk proxy node scripts/m6-browser-check.mjs
```

O browser aceita o caminho absoluto de `playwright/index.mjs` como argumento e
usa Edge/dataset/arquivos privados da M3, sem imprimir senhas, cookies ou tokens.
Evidências em `.tmp/m6/`: build, baseline, integrações, sintaxe, `browser-proof.json`
e capturas reais. Não versionar `.tmp/` ou `.secrets/`.

Preview mantido em **http://127.0.0.1:5035/portal/** e painel em
**http://127.0.0.1:5035/panel/**. Reutilizado `waia-test` com banco/Redis/mídia/rede
v2 isolados, egress da API bloqueado, e-mail fake e sem worker de atendimento.
Sem reset/seed/importação; produção, ambiente anterior e alterações locais alheias
preservados. M7 aguarda autorização própria.

Mensagem de commit: `v1.29.0 - libera recursos de atendimento e reforça envio seguro na M6`.
