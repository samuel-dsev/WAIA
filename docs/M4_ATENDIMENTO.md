# M4 — editor de atendimento

24/10/2026, America/Sao_Paulo. Checkout principal `new`, base **2d28a8c /
1.26.0**. M4 autorizada e concluída em **1.27.0**, com commit local no
fechamento conforme AGENTS. Sem push, promoção, deploy ou implementação da M5.

## Uso do portal

Abra **http://127.0.0.1:5035/portal/**, entre com o acesso liberado e escolha
**Abrir atendimento**. O workspace mostra rascunho, versão publicada, data e
autoria sanitizada. Preencha os campos liberados e clique **Salvar rascunho**.
Salvar incrementa `draftVersion`; não publica, ativa empresa ou envia mensagens.
O roteiro também permite **Tela cheia**, com Escape para retornar.

Sem `attendance.edit`, os campos e o modal ficam somente para leitura e a API
recusa PATCH. Leitura exige `attendance.read`, inclusive para quem tem edição.
Empresa suspensa permite preparar o rascunho conforme essas capacidades.
Suspensão/remoção do vínculo ou identidade impede o acesso.

Em conflito **409**, o texto local permanece visível. **Recarregar versão atual**
pede confirmação para descartá-lo. A recarga bloqueia os campos durante a espera.
Troca de empresa/saída exige confirmação quando há alterações; cancelamento,
geração da navegação e descarte do componente impedem respostas antigas de
preencher outro contexto. Revogação retorna ao login ou ao estado de acesso
indisponível e limpa o editor. Alternar abas revalida sessão, vínculo, campos e
predefinições liberados antes de retomar uma edição local.

## Contrato congelado

GET `/api/app/v1/companies/:id/attendance` retorna somente a projeção de negócio.
PATCH `.../attendance/draft` recebe `{draftVersion, changes}`; `changes` é um
objeto parcial dos campos abaixo. Não recebe documento V2 integral, caminhos
JSON arbitrários, IDs de autor/empresa, habilitação de módulos ou parâmetros livres.

| Campos do patch | Caminhos V2 | Limites |
|---|---|---|
| greeting, fallbackMessage | identity.welcomeMessage / fallbackMessage | 1.000 por texto |
| timezone | identity.timezone | IANA válido, 80 |
| schedules | identity.schedules | 50 linhas de 300 |
| publicRules | identity.publicRules | 100 linhas de 1.000 |
| establishmentRules | identity.establishmentRules | 10.000 |
| script, tone | ai.prompt / personality | 20.000 / 2.000 |
| aiFallback, followUp | ai.fallbackMessage / followUpQuestion | 1.000 / 300 |
| qualificationCriteria, qualificationClosing | ai.leadQualificationCriteria / leadQualificationClosing | 2.000 / 1.000 |
| handoffMessage, salesInterestMessage | humanHandoff.message / salesInterestMessage | 1.000 |
| replies: [{key,text}] | publicReplies, somente texto de vínculo existente | 2.000 por texto |

Campos AI exigem módulo `ai_freeform` e `ai.enabled`; qualificação exige também
`leadQualificationEnabled`. Roteiro e critérios habilitados não aceitam vazio.
Handoff exige seu módulo. Flags, modelos, limites, credenciais, referências,
conectores, destinos, números, grupos, ações e módulos permanecem administrativos.
Os campos não habilitados não são projetados nem aceitos por injeção de payload.

Predefinições editáveis: somente vínculos existentes `catalog.address`,
`catalog.menu` e `events.birthday_rule`, com o módulo respectivo habilitado.
O cliente não adiciona/remove/troca ações. Ações operacionais, como handoff,
pagamentos e execução de integração, não são oferecidas como respostas textuais.
Não existe campo de ausência nem uma fonte paralela de FAQ no V2 atual; nenhum
foi inventado. Saudação/predefinições continuam precedendo a IA.

Tipos, limites, chaves desconhecidas, objetos aninhados, protótipos e material
com formato de segredo são validados. Erros conhecidos usam rótulos de negócio;
erros internos não retornam paths técnicos, SQL, stack, modelo ou referência.
Campos de horário/tom/regras são rascunho V2; não foi comprovado seu efeito em
uma conversa externa. Funcionalidades/runtime correspondentes permanecem em M6.

## Persistência e proteção

Migração aditiva **029_customer_attendance_draft.sql**, sem alterar 001–028.
RLS força contexto customer com sessão válida, vínculo e capacidade; libera
somente o draft autorizado e INSERT de auditoria estritamente redigido.
Revisões ativas, credenciais, auditoria de leitura e demais recursos continuam
negados ao customer. Trigger protege campos técnicos, módulos, autoria original,
schema, identidade da empresa e incremento exato de versão. Não há criação ou
exclusão de draft por esse fluxo; uma base ainda não preparada retorna 409 neutro.

O serviço trava identidade/sessão/vínculo/empresa, depois draft. Revalida leitura
e edição, verifica versão, aplica a lista permitida sobre o documento completo
carregado no servidor e reutiliza o serviço/repositório V2 na **mesma transação**.
Auditoria falha faz rollback. O escritor administrativo passa a travar seu ator
antes do draft, evitando deadlock com a FK da auditoria na disputa pelo mesmo
usuário. As corridas cliente/cliente e cliente/admin têm um vencedor e um 409.

O parser V2 valida o draft, com validação explícita dos tipos/limites de negócio.
A opção interna `preserveDraftValues` retém os valores originais após validar:
normalização Unicode do parser não pode reescrever um modelo técnico oculto.
Não se persiste saída compilada/defaults. A compilação/publicação integral é M5,
e um rascunho administrativo tecnicamente incompleto pode ser preparado aqui.
`configuration.ai.prompt` continua sendo a única fonte do roteiro.

Autoria própria mostra o nome; outro editor aparece como **Outro acesso
autorizado**. A publicação usa metadados existentes e rótulo neutro **Acesso
autorizado**, sem liberar revisões integrais ou enumerar identidades.

## Validação e continuidade

Node 22: **654 casos, 630 aprovados, 24 skips opt-in, zero falhas**.
PostgreSQL/Redis reais: **70 aprovados, zero skips/falhas**, incluindo 11 casos
M4 (dez subtestes e seu pai). Contrato: 13 casos; HTTP: sessão, origem, CSRF,
no-store, 409 e erro interno sanitizado. Auditoria de dependências zerada.
Snapshot selecionado: **26 arquivos**, sintaxe de **314 arquivos** e 68 links
documentais conferidos. Imagem de runtime sem testes, temporários ou material
privado: `sha256:c3733ccb24d086664592f964255a8c6593e06d076a661156a16176b277c1a36e`.
Mensagem do commit: `v1.27.0 - adiciona editor seguro de atendimento na M4`.

Browser Edge/Playwright: base simulada preparada pelo painel, script/horários
salvos, técnico/empresa vizinha preservados por hash, mass assignment recusado,
dois editores com 409/texto preservado, leitura inclusive no modal, 390px sem
overflow, Escape, recarga lenta, troca e revogação antes de enviar o PATCH.
O principal inspecionou capturas desktop/móvel. Revisões independentes de contrato,
persistência e segurança resolvidas, sem bloqueador alto pendente.

Infraestrutura reaproveitada de `waia-test`: PostgreSQL/Redis/mídia/rede v2
dedicados, egress bloqueado, e-mail fake, sem worker de atendimento. A 029 foi
aplicada no preview por `scripts/migrate-v2-preview.mjs`, que recusa outro alvo,
valida ledger/checksums e aplica somente essa migração pendente, preservando os
dados fictícios existentes. Nada foi importado, apagado ou semeado. Base técnica
de Aurora e rascunho de Horizonte preparados pelo painel.

Após build do target `validation`, comandos reproduzíveis:

```powershell
rtk proxy docker run --rm --network none waia:v2-test-local npm test
rtk proxy docker run --rm --network none waia:v2-test-local node scripts/check-syntax.mjs
rtk proxy docker compose --project-name waia-test --env-file .secrets/v2-test.env --file infra/compose.v2-test.yml run --rm --no-deps v2-check node scripts/validate-v2-environment.mjs --tests-only
rtk proxy node scripts/m3-browser-check.mjs
rtk proxy node scripts/m4-browser-check.mjs
```

Browser opt-in usa Playwright do runtime de dependências do Codex e Edge;
aceita como argumento o caminho absoluto de `playwright/index.mjs` quando não
resolvível no Node. Exige o dataset e os arquivos privados sintéticos da M3.
O roteiro M4 guarda cookies sintéticos em `.secrets/` para evitar login repetido;
não os versiona nem desabilita limites. O último caso revoga a sessão cliente.
Evidências sanitizadas em `.tmp/m4/`: testes, integrações, auditoria,
`browser-proof.json`, capturas, build e upgrade. Não versionar `.tmp` ou segredos.
O fechamento validou `selected-{baseline.tap,integrations.log,syntax.log,build.log}`,
`browser-final.log` (oito grupos aprovados) e `runtime-proof.log` sobre o snapshot
selecionado, sem incorporar alterações locais anteriores alheias à fase.

Preview permanece em **http://127.0.0.1:5035/portal/**; painel em
**http://127.0.0.1:5035/panel/**. Produção, ambiente anterior e trabalho local
alheio preservados. E-mail/WhatsApp/OpenAI reais não comprovados; M5 aguarda
autorização específica.
