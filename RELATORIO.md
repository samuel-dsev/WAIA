# Relatório de continuidade — WAIA

Atualizado em 2 de setembro de 2026 após a implementação da Fase 4 do `PLAN.md`.

## Objetivo vigente

Evoluir o WAIA para que uma nova empresa possa ser criada, configurada, testada, publicada, ativada, operada e suspensa pelo painel, sem edição de `.env`, SQL ou código e sem reinício ou deploy por tenant.

O provisionamento de número, WABA e permissões no Meta Business permanece externo. O painel deve receber, validar e guardar os dados fornecidos pela Meta sem expor segredos.

## Estado Git e proteção da versão atual

- Desenvolvimento realizado no checkout principal `C:\Users\Samuel\Documents\Projetos\WAIA`, branch `dev`, conforme autorização do usuário.
- `origin/main` permanece no commit de produção preservado `00a0a09` e não recebeu a atualização de onboarding.
- O baseline `00a0a09` continua disponível no worktree isolado `C:\Users\Samuel\Documents\Projetos\WAIA-baseline-00a0a09`.
- `origin/dev` está em `6ec0236`; a `dev` local também contém o commit anterior `66a34de`, ainda não enviado ao remoto.
- A Fase 4 está no working tree, preparada na versão `1.5.0`, mas ainda não foi commitada nem enviada porque depende de confirmação explícita.
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

## Validação da Fase 4

- `npm test`: 279 testes descobertos, 270 aprovados, 0 falhas e 9 integrações opcionais ignoradas sem variáveis de infraestrutura.
- `node --check`: todos os arquivos JavaScript válidos.
- `npm run load:test`: cinco cenários sintéticos aprovados, de 250 a 800 jobs, sem falhas.
- `docker compose config --quiet`: configuração válida com valores sintéticos.
- PostgreSQL 16 real em projeto Compose isolado `waia-f4-flow`: 18 migrações aplicadas; integração de publicação v1/v2, pinagem em v1, isolamento entre tenants, conclusão e anonimização aprovada.
- O ambiente temporário `waia-f4-flow`, sua rede e seu volume sintético foram removidos após o teste.
- A pilha existente `waia-today` não foi alterada e permaneceu com API, worker, PostgreSQL, Redis, Caddy e painel saudáveis.

## Segurança e limites preservados

- Nenhuma credencial real foi lida, registrada ou usada.
- Nenhum dado da Filaretti foi criado.
- Configurações e revisões não armazenam segredos; apenas referências ao cofre são permitidas.
- Fluxos não executam JavaScript, SQL, HTTP livre nem templates arbitrários.
- O endpoint legado `/webhook` continua necessário temporariamente para o Capitão Mor.
- O painel construtor de fluxos e seus CRUDs visuais pertencem à Fase 6; a Fase 4 fornece o contrato, persistência e runtime que eles consumirão.

## Próxima fase planejada — Fase 5

A Fase 5 — Meta multiaplicativo só pode começar após o commit e push confirmados da Fase 4 e uma nova autorização explícita do usuário.

Escopo previsto:

- aplicativo Meta por tenant;
- referências a credenciais no cofre;
- callback dinâmico `GET/POST /webhook/meta/:webhookPublicId`;
- validação da assinatura sobre os bytes brutos;
- vínculo e conferência de WABA e `phone_number_id`;
- rotação segura de App Secret;
- health check e compatibilidade temporária com `/webhook`.

Gate: duas assinaturas e dois números não podem se confundir.

## Pendências posteriores

- Fase 6: wizard completo do painel, inclusive construtor visual de fluxos e CRUDs.
- Fase 7: simulador isolado e preflight externo auditado.
- Fase 8: regressão integral do Capitão Mor.
- Fase 9: Empresa Beta Sintética criada e ativada somente pelo painel, sem dados da Filaretti.
- Fase 10: validação final com PostgreSQL, Redis, Docker, RLS, carga, auditoria, segredos e navegação real.

O teste de carga atual é uma regressão em memória; não mede capacidade de VPS, latência de rede nem limites de provedores externos.
