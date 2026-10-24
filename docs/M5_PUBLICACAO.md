# M5 — simulação e publicação

24/10/2026, America/Sao_Paulo. Checkout principal `new`, base **d671141 /
1.27.0**. M5 autorizada pelo usuário com contextualização do plano e commits
M0–M4. Entrega **1.28.0**, commit local no fechamento conforme AGENTS.
Sem push, promoção, deploy ou implementação da M6. A versão 2.0.0 continua futura.

## Uso pelo cliente

No [portal local](http://127.0.0.1:5035/portal/), escolha a empresa, edite e
**Salve o rascunho**. Salvar não publica ou ativa a empresa. Com as capacidades
liberadas, **Simular rascunho** testa uma mensagem isolada; IA e integrações são
fictícias, com o compilador e runtime existentes e sem envio externo. A simulação
mantém a precedência das respostas determinísticas. Não reproduz uma conversa
multietapa nem prova o comportamento de um provedor real.

**Revisar publicação** mostra empresa, versão salva, versão publicada e diff de
negócio antes/depois. Confira o conteúdo, marque a confirmação e clique
**Confirmar publicação**. A confirmação tem chave própria, preservada em retry
após indisponibilidade. Mudança de empresa, edição, recarga, revogação ou revisão
concorrente invalida a confirmação visual. Um 409 exige recarga e nova revisão.

A administração precisa publicar inicialmente uma base técnica íntegra. Mudança
técnica pendente no rascunho compartilhado impede simulação/publicação pelo
cliente. Dependência indisponível impede publicar. Empresa suspensa continua
permitindo leitura/draft autorizado, mas não simulação/publicação. O cliente
nunca ativa empresa, reconecta fornecedor ou escolhe destino/grupo.

## Contrato e segurança

GET `/api/app/v1/companies/:id/attendance` acrescenta `canSimulate`, `canPublish`
e `publication`: `ready`, motivo neutro, `changes` de negócio e `reviewToken`.
O token vincula empresa canônica, draftVersion, revisão ativa, documento e
checksums. Não é credencial nem substitui autorização.

- POST `.../attendance/simulate`: `{draftVersion,message}`. Texto até 2.000
  caracteres (campo visual até 1.000). Retorna somente `draftVersion`, `reply`
  textual e aviso de simulação; nenhum trace, módulo, ID de botão ou atividade.
- POST `.../attendance/publish`:
  `{draftVersion,reviewToken,idempotencyKey,confirmed:true}`. Chave UUID v1–5.
  Retorna somente `draftVersion`, `activeVersion`, `publishedAt`.
- Schemas estritos recusam campos desconhecidos, versões inválidas, confirmação
  ausente e material não JSON. Origem, sessão, CSRF e no-store são os existentes.
- `attendance.read` e capacidade específica são revalidadas no servidor. O
  orçamento distribuído é de 20 operações por usuário e 120 por empresa, por
  janela de 15 minutos; simulação/publicação têm chaves separadas. Redis falha
  fechado; excesso retorna 429. Não há chave de orçamento enviada pelo cliente.

A revisão ativa é verificada por tenant, versão e checksum. O candidato e a
baseline são compilados/canônicos; remove-se apenas a allowlist exata da M4
habilitada na baseline para comparar o técnico. Modelos, tokens, módulos,
conectores, credenciais/referências, números, quotas, destinos, ações e ordem das
predefinições não podem mudar por publicação customer. Unicode/defaults do
compilador não são autorização para alterar outros campos. UUID da URL nunca é
repassado como identidade da revisão: usa-se o ID canônico lido do banco.

## Pipeline, persistência e concorrência

A primeira transação autentica, trava e confere empresa/draft/base/diff/versão,
consulta recibo e reserva orçamento. O preflight administrativo existente faz
probes fora desses locks, porque pode atualizar metadados de saúde. Seu resultado
técnico não chega ao cliente. Não envia atendimento WhatsApp. A simulação não
executa preflight, não recebe gateways nem handlers reais de IA/integrações.

A segunda transação revalida identidade, sessão, vínculo, read+publish, estado da
empresa, recibo, versão e token/diff. Reutiliza `OnboardingService.publish`,
compilador, readiness em enforcement e publicador de fluxos na mesma transação.
Trava dependências existentes enquanto verifica readiness e grava a revisão.
Publicar atualiza somente a revisão em uso; `activate` não é chamado.

Locks seguem ator → sessão/vínculo/empresa → draft. `FOR NO KEY UPDATE` na
empresa serializa publicação/suspensão e permite FK de auditoria de outro editor,
evitando o ciclo empresa/draft. Publicação administrativa trava o ator antes da
empresa. Revogação ou alteração durante o preflight impede a transação final.
Probes já iniciados podem atualizar saúde após revogação; retries concorrentes
podem repetir probes, mas só uma revisão e recibo são persistidos.

Migração aditiva **030_attendance_publications.sql**: recibos por
empresa/ator/chave, hash do payload e resposta sanitizada, FORCE RLS e negação
customer. Revisão, ponte ativa, auditoria de publicação e recibo fazem commit
juntos. Mesma chave/payload retorna o recibo após nova autorização; payload
diferente retorna 409. Falha preserva a revisão anterior. Nova chave para uma
confirmação sem diff pode criar uma revisão equivalente; não existe rollback
customer nesta fase.

As policies customer de revisões/recursos técnicos continuam fechadas. Somente
operações privadas e fixas de `AttendanceService`, após autorização e locks,
usam contexto interno para ler a baseline/readiness e executar publish. Nenhum
SQL, papel ou flag de contexto vem do request. O contexto customer é restaurado
no sucesso; erro reverte toda a transação e SET LOCAL não fica no pool.

## Validação e limites

Node 22: **663 casos, 637 aprovados, 26 skips opt-in, zero falhas**. As integrações
PostgreSQL/Redis: **86 aprovadas, zero skips/falhas**; schema 30 e upgrade
histórico equivalentes, ledger/checksums e isolamento aprovados. Os dois testes
opt-in M5 também estão nos jobs correspondentes da CI; execução remota depende
de push autorizado.
Snapshot de **25 arquivos**, com sintaxe de **319 arquivos JavaScript** aprovada.
Contrato M5 tem sete casos; HTTP cobre origem/CSRF/sessão/no-store nas novas rotas.
Revisões independentes de pipeline e segurança corrigiram locks e UUID canônico.

PostgreSQL usa role real sem superuser/bypass: baseline administrativa sintética,
publicação customer, loader do runtime antes/depois, UUID em maiúsculas, duas
empresas, idempotência/concorrência, erro de auditoria, técnico oculto, dependência
indisponível e alterações/revogação durante preflight. Providers/credenciais são
fixtures técnicas inválidas para serviços externos; readiness é real e preflight
positivo é explicitamente fake. Redis real testa duas instâncias, 20/120, TTL,
isolamento e desconexão sem fallback. Nenhuma integração externa foi comprovada.

Browser Edge: servidor real comprova login/grant pelo painel, salvar/isolamento,
ausência de técnico e bloqueios de base/readiness. O preview não possui base
técnica operacional aprovada; não se criou número/token/aplicativo para forçar
aceite. Simulação/publicação bem-sucedidas na UI usam **page.route fictício**,
separado no relatório: diff, checkbox, retry 503 com mesma chave/payload, recibo,
409, XSS inerte e resposta atrasada descartada na troca. Isso verifica a interface,
não publicação real via navegador. A prova real de publicação/runtime é PostgreSQL.
Capturas desktop/390px inspecionadas, sem overflow/erros de página.

Comandos, a partir do snapshot selecionado e imagem target `validation`:

```powershell
rtk proxy docker run --rm --network none waia:v2-test-local npm test
rtk proxy docker run --rm --network none waia:v2-test-local node scripts/check-syntax.mjs
rtk proxy docker compose --project-name waia-test --env-file .secrets/v2-test.env --file infra/compose.v2-test.yml run --rm --no-deps v2-check node scripts/validate-v2-environment.mjs --tests-only
rtk proxy node scripts/m5-browser-check.mjs
```

Browser aceita como argumento o caminho absoluto de `playwright/index.mjs`,
requer o dataset/MFA/arquivos privados sintéticos da M3 e Edge. Preserva os
limites de login. `migrate-v2-preview.mjs` aceita somente schema 29→30 no alvo
isolado, com checksums e sem reset. Não editar migração já aplicada.

Evidências locais ignoradas em `.tmp/m5/`: baseline, integrações, schema,
`browser-proof.json`, capturas e build do snapshot selecionado. Arquivos privados
ficam em `.secrets/`. Snapshot exclui alterações locais anteriores alheias à M5.
Preview mantido no portal acima e [painel](http://127.0.0.1:5035/panel/), no mesmo
`waia-test`, banco/Redis/mídia/rede v2 dedicados, sem egress da API e sem worker de
atendimento. Homologação pública/serviços reais e M6 exigem suas autorizações.

Mensagem de commit: `v1.28.0 - adiciona simulação e publicação segura na M5`.
