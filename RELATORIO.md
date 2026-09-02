# Relatório de continuidade — WAIA

Atualizado em 2 de setembro de 2026 após a implementação e validação da Fase 5 do `PLAN.md`.

## Objetivo vigente

Evoluir o WAIA para que uma nova empresa possa ser criada, configurada, testada, publicada, ativada, operada e suspensa pelo painel, sem edição de `.env`, SQL ou código e sem reinício ou deploy por tenant.

O provisionamento de número, WABA e permissões no Meta Business permanece externo. O painel deve receber, validar e guardar os dados fornecidos pela Meta sem expor segredos.

## Estado Git e proteção da versão atual

- Desenvolvimento realizado no checkout principal `C:\Users\Samuel\Documents\Projetos\WAIA`, branch `dev`, conforme autorização do usuário.
- `origin/main` permanece no commit de produção preservado `00a0a09` e não recebeu a atualização de onboarding.
- O baseline `00a0a09` continua disponível no worktree isolado `C:\Users\Samuel\Documents\Projetos\WAIA-baseline-00a0a09`.
- `origin/dev` e a `dev` local partem de `6227959`, commit remoto da Fase 4 (`v1.5.0`).
- A Fase 5 está no working tree, preparada na versão `1.6.0`, mas ainda não foi commitada nem enviada porque depende de confirmação explícita.
- Nenhuma tag, merge em `main`, implantação ou publicação externa foi executada.

## Fases concluídas

### Fase 0 — baseline e isolamento Git

- Baseline anterior ao contrato V2 congelado e preservado.
- Respostas de caracterização do Capitão Mor protegidas por testes.
- Gate: versão atual reproduzível sem incorporar o onboarding em `origin/main`.

### Fase 1 — contratos e compilador

- Criados `TenantRuntimeConfigV2`, catálogo de capacidades, validação tipada, compilador e adaptador legado.
- A configuração existente do Capitão Mor compila sem alterar as respostas caracterizadas.
- Commit: `492a16d` (`v1.2.0`).

### Fase 2 — rascunho e publicação versionada

- Implementadas persistência de rascunho, revisão otimista, revisões imutáveis, checksum e publicação transacional.
- O runtime carrega apenas a revisão publicada e conserva fallback para configuração legada.
- Gate: editar o rascunho não altera o runtime ativo.

### Fase 3 — onboarding e readiness

- Implementados serviço, políticas, rotas administrativas, checks corrigíveis, auditoria e ativação/publicação transacionais.
- Novos tenants nascem em rascunho e não aceitam mudança de status pelo CRUD genérico.
- Empresas já ativas não são suspensas automaticamente pelas novas regras.
- Gate: dependências ausentes geram bloqueadores estáveis associados à etapa e à ação corretiva.
- Commit remoto atual: `6ec0236` (`v1.4.0`).

### Fase 4 — fluxos configuráveis

- Adicionado domínio `flows` com ações canônicas `flows.start`, `flows.continue` e `flows.cancel`.
- O contrato suporta mensagem, escolha única, texto, nome, e-mail, telefone, data, consentimento, documento/imagem, serviço, horário, handoff, conclusão e condição simples.
- O validador rejeita grafos inválidos, ciclos proibidos, referências ausentes, JavaScript, SQL, expressões arbitrárias, templates não permitidos e acesso a segredos.
- O executor é declarativo e determinístico; escolhas interativas respeitam os limites do WhatsApp.
- A migração aditiva `018_configurable_flows.sql` cria fluxos, versões imutáveis, submissões e documentos com `empresa_id`, FKs compostas, índices tenant-first e `ENABLE/FORCE ROW LEVEL SECURITY`.
- A publicação da configuração materializa as versões de fluxo dentro da mesma transação da revisão publicada.
- Conversas permanecem pinadas à versão de fluxo e à revisão de configuração em que começaram, mesmo após nova publicação.
- O runtime do worker inicia, continua, cancela, conclui ou transfere fluxos, preserva estado e anexa metadados de documentos sem chamadas externas livres.
- A retenção usa a política da revisão publicada pinada, anonimiza submissões vencidas e remove arquivos privados associados.
- O roteador permite cancelar ou trocar de intenção com segurança, mantendo compatibilidade com tenants legados sem `flows`.
- Gate atingido: o teste sintético percorre início por alias, botões, continuação pinada após uma nova versão, cancelamento, reset e reinício sem lógica específica por empresa.
- Commit remoto: `6227959` (`v1.5.0`).

### Fase 5 — Meta multiaplicativo

- A migração aditiva `019_meta_multi_application.sql` cria aplicativos Meta tenant-scoped, referências ao cofre, identificador público opaco do webhook, revisão otimista, estado, health, último webhook válido e retenção de erro sanitizado.
- Números WhatsApp passam a ter vínculo explícito com aplicativo Meta e credencial de access token do mesmo tenant, protegidos por FK composta e revisão do vínculo.
- Todas as novas estruturas usam índices tenant-first e `ENABLE/FORCE ROW LEVEL SECURITY`; nenhum segredo é armazenado na configuração ou nas revisões.
- A API administrativa permite listar, criar e editar aplicativos, vincular números, rotacionar App Secret e executar preflight sem receber ou devolver valores secretos.
- O callback dinâmico `GET/POST /webhook/meta/:webhookPublicId` resolve a conexão por identificador aleatório, valida assinatura sobre os bytes brutos, confere WABA e `phone_number_id` e só depois ingere os eventos.
- A rotação aceita o App Secret anterior por uma janela curta e limitada; fora dela, a credencial anterior não é carregada.
- O preflight consulta app, WABA e número na Graph API por cliente injetável, persiste somente resultado sanitizado e controla o estado do aplicativo com revisão otimista.
- O envio resolve exclusivamente o access token vinculado ao número e ao aplicativo ativo; números ainda não migrados conservam o fallback legado tenant-scoped.
- O endpoint legado `/webhook` permanece disponível para o Capitão Mor.
- Gate atingido: duas conexões com assinaturas, números, WABAs e credenciais diferentes foram testadas sem cruzamento, inclusive em PostgreSQL real.

## Validação da Fase 5

- `npm test`: 334 testes descobertos, 324 aprovados, 0 falhas e 10 integrações opcionais ignoradas sem variáveis de infraestrutura.
- `node --check`: 197 arquivos JavaScript válidos.
- `npm run load:test`: cinco cenários sintéticos aprovados, entre 250 e 800 jobs, sem falhas.
- `docker compose -p waia-test config --quiet`: configuração válida com valores sintéticos.
- O padrão permanente para novas validações Docker é o projeto isolado `waia-test`; projetos existentes não serão removidos sem autorização explícita.
- PostgreSQL 16 real no `waia-test`: 19 migrações aplicadas; integração de dois aplicativos, números e credenciais Meta por tenant aprovada, incluindo bloqueio de vínculo cruzado.
- API e worker do `waia-test` ficaram saudáveis; `/health/ready` respondeu HTTP 200 com estado `ready`.

## Segurança e limites preservados

- Nenhuma credencial real foi lida, registrada ou usada.
- Nenhum dado da Filaretti foi criado.
- Configurações e revisões não armazenam segredos; apenas referências ao cofre são permitidas.
- Fluxos não executam JavaScript, SQL, HTTP livre nem templates arbitrários.
- O endpoint legado `/webhook` continua necessário temporariamente para o Capitão Mor.
- O painel ainda não expõe a gestão visual das conexões Meta; ele será implementado junto ao wizard na Fase 6.

## Próxima fase planejada — Fase 6

A Fase 6 — wizard do painel só pode começar após o commit e push confirmados da Fase 5 e uma nova autorização explícita do usuário.

Escopo previsto:

- dez etapas do onboarding;
- autosave e retomada com revisão otimista;
- formulários condicionais e seletores sem IDs técnicos;
- CRUDs completos da operação;
- construtor visual de fluxos;
- checklist, simulador e erros por campo;
- acessibilidade do painel.

Gate: nenhuma etapa pode exigir IDs internos, SQL ou edição de `.env`.

## Pendências posteriores

- Fase 7: simulador isolado e preflight externo auditado.
- Fase 8: regressão integral do Capitão Mor.
- Fase 9: Empresa Beta Sintética criada e ativada somente pelo painel, sem dados da Filaretti.
- Fase 10: validação final com PostgreSQL, Redis, Docker, RLS, carga, auditoria, segredos e navegação real.

O teste de carga atual é uma regressão em memória; não mede capacidade de VPS, latência de rede nem limites de provedores externos.
