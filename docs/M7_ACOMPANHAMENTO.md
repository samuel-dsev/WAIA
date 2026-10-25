# M7 — acompanhamento e perfil

Fechamento em 25/10/2026, America/Sao_Paulo. Checkout principal `new`, base
**6e07e3e / v1.29.0**, entrega **v1.30.0**. M0–M6 conferidas no histórico:

| Fase | Commit local | Versão |
|---|---|---|
| M0 | 89d46af | 1.23.3 |
| M1 | 88f7b21 | 1.24.0 |
| M2 | c59a905 | 1.25.0 |
| M3 | 2d28a8c | 1.26.0 |
| M4 | d671141 | 1.27.0 |
| M5 | 31730d6 | 1.28.0 |
| M6 | 6e07e3e | 1.29.0 |

Usuário autorizou a M7 e escolheu manter conversas, fichas, mídia e ações humanas
fechadas. Commit local no fechamento conforme AGENTS. Sem push, promoção, deploy
ou avanço à M8. A entrega estável 2.0.0 permanece futura.

## Uso

Abra uma empresa no [portal local](http://127.0.0.1:5035/portal/). A visão geral
mostra situação da empresa, versão/data do rascunho e da publicação, além de
pendência de negócio ou revisão administrativa. Sem rascunho, informa que a
administração precisa preparar o atendimento. O resumo não apresenta métricas de
conversas, fichas ou entregas. Conteúdo igual ao publicado não significa fornecedor
saudável; os estados funcionais continuam no catálogo da M6.

Salvar prepara apenas draft e atualiza o resumo automaticamente. Publicar continua
exigindo revisão/confirmação da M5; não reativa empresa. **Atualizar resumo**
consulta novamente o servidor. Não libera conversas/fichas/mídia/ações humanas.

**Perfil** mostra nome editável e e-mail de acesso somente leitura, com orientação
para mudança administrativa. Trocar senha encerra todas as sessões. **Segurança e
sessões** atualiza a identidade antes de mostrar MFA e sessões próprias, com
último acesso e expiração. É possível encerrar sessão própria, ativar duas etapas,
guardar códigos de recuperação e, após reautenticação, gerenciar sua proteção
conforme regras existentes. Cliente nunca administra outro usuário; MFA de admin
continua obrigatório. Não houve mudança de e-mail ou entrega real nesta fase.

Remoção do vínculo/permissão nega a próxima operação. Revogação/expiração limpa a
tela ao ser detectada pela API ou ao retornar à aba; não há stream nem polling
novo. Troca do cookie/identidade limpa empresa/editor e retorna à lista. Um fator
MFA incorreto continua permitindo nova tentativa se a sessão ainda for válida.

## Contrato e arquivos

GET `/api/app/v1/companies/:id/overview` exige sessão customer, identidade ativa,
vínculo ativo e `attendance.read`, revalidados na transação existente sob role
restrita/RLS. DTO fechado: `company`, `hasDraft`, `draftVersion`, `activeVersion`,
`savedAt`, `publishedAt`, `publication: {state, changeCount}` e
`optionalResources` com todos os quatro recursos `false`.

Estados: `preparing`, `unpublished`, `published`, `changes_pending` e
`administrative_pending`. `changeCount` só existe numericamente quando a revisão
de negócio da M5 é segura; caso contrário é `null`. Nenhum texto, diff, autor,
token de revisão, segredo/referência, número/grupo/modelo/quota é retornado. As
leituras internas necessárias continuam fixas e restauram o contexto customer.

Opcionais não possuem rotas customer nem habilitação efetiva; inserir nomes de
permissões ou usar owner/admin legado em sessão customer não os abre. APIs admin
continuam exigindo cookie/audience/perímetro próprios. Nenhum acesso a storage ou
ação operacional foi adicionado. Empresa suspensa permite somente o resumo e
operações já autorizadas pela matriz; nenhuma reativação ou envio.

Arquivos da fase:

- `src/modules/attendance/attendance-service.js`: overview e leitura sem draft.
- `src/modules/accounts/http.js`: rota de visão geral com auth/no-store existentes.
- `portal/{app,attendance,security}.js` e `index.html`: resumo, perfil, sincronização,
  sessão e limpeza do DOM; nenhum CSS preexistente incorporado.
- `test/m7-{overview,personal-security}-postgres.test.js`: contratos e segurança.
- `scripts/m7-browser-check.mjs`: jornada reproduzível com APIs reais.
- `scripts/validate-v2-environment.mjs` e `.github/workflows/ci.yml`: testes opt-in.
- `package.json`, `package-lock.json`, plano, índice, relatório e este manual.

## Validações e limites

Snapshot selecionado, excluindo alterações locais anteriores: **17 arquivos**.
Node22 **682 casos, 652 aprovados, 30 skips opt-in, zero falhas**. PostgreSQL/Redis:
**113 aprovados, zero skips/falhas**. Sintaxe de **329 arquivos JavaScript**.
Schema **30**, sem migração nova, ledger/checksums equivalentes, role real sem
superuser/BYPASSRLS e pool sem contexto residual. Redis/mídia v2 e egress bloqueado
conferidos; bases/volumes antigos preservados. Auditoria npm sem vulnerabilidades.
CI preparada, sem execução remota.

Integração testa contrato/HTTP/no-store, dados técnicos/textos ausentes, sem draft,
publicado/mudanças/pendência técnica, vizinho, IDs/audience/capacidades, suspensão,
revogação e grants opcionais sem efeito. Perfil rejeita mass assignment; nome com
marcação fica literal e só altera identidade própria. Sessões alheias não são
listadas/revogadas; troca de senha invalida todas as sessões e desafio MFA de
matrícula pendente. Contextos e cookies revogados não alteram dados.

Browser Edge com APIs reais, sem respostas fictícias: resumo, salvamento e
sincronização da versão sem publicação, e-mail somente leitura, XSS literal,
mass assignment recusado, sessões/expiração e revogação atual. Resposta real retida
de Aurora não preenche Horizonte; troca de identidade pelo cookie enquanto a
tela permanece aberta limpa a empresa anterior e abre lista vazia. Teclado e
390px sem overflow ou pageerrors; capturas desktop/móvel inspecionadas. Saudação
e nome fictícios restaurados; versões/auditoria sintéticas avançaram. Nenhum
contato/conversa/mídia foi criado ou importado no dataset de produto.

Revisões independentes de autorização/mídia e jornada incorporaram limpeza real
do editor, atualização da sessão e proteção contra troca de identidade/CSRF.
Sem bloqueador alto/crítico conhecido. Primeiro build com snapshot incompleto
foi descartado; fixture de revisão foi completada para o compilador real; seletor
do teste de saudação foi corrigido. Rodadas finais aprovadas. Esses ensaios não
equivalem a falha ou liberação de fornecedor.

Comandos após preparar snapshot selecionado e concluir seu build `validation`:

```powershell
rtk proxy docker build --target validation -t waia:v2-test-local .tmp/m7/selected
rtk proxy docker run --rm --network none waia:v2-test-local npm test
rtk proxy docker run --rm --network none waia:v2-test-local node scripts/check-syntax.mjs
rtk proxy docker compose --project-name waia-test --env-file .secrets/v2-test.env --file infra/compose.v2-test.yml run --rm --no-deps v2-check node scripts/validate-v2-environment.mjs --tests-only
rtk proxy node scripts/m7-browser-check.mjs
```

O browser aceita como argumento o caminho absoluto de `playwright/index.mjs`, usa
Edge e arquivos privados do dataset existente, sem imprimir senhas/cookies/tokens.
Evidências sanitizadas em `.tmp/m7/`, incluindo logs, `browser-proof.json` e
capturas; não versionar `.tmp/` ou `.secrets/`.

Preview mantido em **http://127.0.0.1:5035/portal/** e painel em
**http://127.0.0.1:5035/panel/**, no mesmo `waia-test` com banco/Redis/mídia v2
isolados, e-mail fake, egress da API bloqueado e sem worker de atendimento. Não
houve WhatsApp/OpenAI/e-mail real, teste de mídia/ações humanas liberadas, restore,
reset, seed, importação ou acesso a produção. Mudanças preexistentes em
`.env.example`, `docker-compose.yml`, `docs/PAUSA_WHATSAPP_BUSINESS.md`,
`portal/styles.css`, `src/config.js` e `portal/security-team.js` preservadas fora
do commit. Homologação ampla T01–T24 permanece na M8, ainda não autorizada.

Mensagem de commit: `v1.30.0 - adiciona acompanhamento e segurança pessoal na M7`.
