# Relatório de continuidade — WAIA

Atualizado em 29 de agosto de 2026 após auditoria integral de código, testes, banco, infraestrutura e painel.

## Diagnóstico executivo

A fundação SaaS multiempresa está funcional e tecnicamente consistente para desenvolvimento e homologação controlada. Ela ainda não deve ser considerada pronta para produção: faltam ligar algumas capacidades já implementadas, completar a operação humana, validar integrações externas reais e fechar rotinas de segurança e recuperação.

Os executáveis oficiais são `src/api.js` e `src/worker.js`. A entrada `src/server.js` permanece apenas para compatibilidade com a demonstração legada do Capitão Mor.

## O que está comprovadamente implementado

- API Express com webhook Meta, autenticação administrativa, CSRF, autorização, páginas legais e health checks.
- Worker com outbox PostgreSQL, BullMQ/Redis, locks por conversa, concorrência por tenant, retries, backoff, dead-letter e heartbeat.
- PostgreSQL como fonte de verdade, com dez migrações, chaves compostas por tenant, idempotência, índices e `ENABLE/FORCE ROW LEVEL SECURITY`.
- Resolução do tenant por `metadata.phone_number_id`; API e worker oficiais não usam credenciais Meta globais.
- Conversas, mensagens, estados, pedidos, agendamentos, uso de IA, logs e auditoria persistentes.
- Runtime configurável com catálogo, eventos, pedidos, agenda, pagamentos, handoff e IA.
- Painel administrativo estático com login, dashboards e CRUDs centrais.
- Cofre de credenciais AES-256-GCM com AAD, versionamento, rotação, revogação, máscara e auditoria atômica.
- Tenant demonstrativo do Capitão Mor em seed sintético, sem credenciais, PIX ou dados pessoais reais.
- OpenAI Responses API com isolamento por tenant, limites, contingência, defesa contra prompt injection e contabilização de custo.
- Adaptador Google Sheets multiempresa e simuladores testados isoladamente.

## Correções desta auditoria

- Corrigido erro de sintaxe que impedia o JavaScript do painel de carregar.
- O painel agora interpreta corretamente erros administrativos estruturados, sem exibir `[object Object]`.
- Cookies malformados deixam de causar erro 500 durante autenticação.
- Restrições do PostgreSQL na API administrativa agora retornam erro público 400/409, sem expor SQL interno.
- API e worker deixaram de tentar conectar duas vezes o mesmo cliente Redis; ambos agora iniciam no Compose.
- O diagnóstico de heartbeat percorre todos os cursores do `SCAN` antes de declarar o worker indisponível.
- A perda do lease de concorrência por tenant interrompe o job, evitando conclusão concorrente sem posse do slot.
- A abertura concorrente da primeira conversa passou a usar `ON CONFLICT`, evitando erro transitório no webhook.
- `ultima_mensagem_at` passou a ser monotônico, impedindo regressão por mensagens recebidas fora de ordem.
- O fluxo de agenda preserva a etapa quando recebe um horário inválido.
- Pedidos agora exigem comprovante de imagem/documento realmente persistido, evento publicado e preço atual do banco.
- Pedidos e agendamentos passaram a usar lock de idempotência transacional.
- Agendamentos agora vinculam uma disponibilidade real e reservam/liberam capacidade atomicamente por trigger PostgreSQL; overbooking é rejeitado.
- O catálogo de preços da IA agora inclui o modelo padrão `gpt-4.1-mini`, evitando falha de toda chamada real antes do provedor.
- Corrigidos textos corrompidos em rotas administrativas e scripts sensíveis.
- O histórico `codex-session-*.md` foi excluído do contexto de build Docker, reduzindo o envio de aproximadamente 3,5 MB para cerca de 240 KB no primeiro rebuild.
- `.env.example` agora indica `INFRASTRUCTURE_MODE=postgres`, coerente com os executáveis oficiais.
- `npm start` e `npm run dev` agora apontam para a API oficial; a demonstração antiga exige `npm run start:legacy` ou `npm run dev:legacy`.

## Validação executada

- `npm test`: 144 testes descobertos; 143 aprovados e 1 teste PostgreSQL opcional ignorado sem `RUN_POSTGRES_INTEGRATION=true`.
- `node --check`: 131 arquivos JavaScript válidos.
- `npm run load:test`: cinco cenários sintéticos aprovados, de 250 a 800 jobs, sem falhas.
- `docker compose -p waia-audit config --quiet`: configuração válida.
- Build Docker das imagens de API e worker concluído; instalação reportou zero vulnerabilidades npm.
- PostgreSQL 16 e Redis 7 iniciados em uma pilha temporária isolada.
- Migração de banco vazio e seed concluídos; dez migrações descobertas.
- Teste de integração real comprovou incremento de capacidade, rejeição de overbooking e liberação após cancelamento.
- API e worker iniciados com `NODE_ENV=production`; ambos ficaram saudáveis.
- `GET /health/ready` retornou HTTP 200.

O teste de carga continua sendo uma regressão em memória; ele não mede capacidade de VPS, latência de rede ou limites dos provedores.

## Lacunas e riscos ainda existentes

### Bloqueiam produção

- Google Sheets não está ligado ao `createPostgresRuntime` nem aos handlers oficiais. O adaptador existe, mas habilitar o módulo hoje não executa sincronização/exportação real.
- O painel não envia mensagens humanas; assumir/pausar a conversa funciona, mas o operador não consegue responder por essa interface.
- Não há tela/endpoint operacional para listar, reenfileirar ou resolver `jobs_falhos`; apenas contadores aparecem no dashboard.
- Métricas possuem registry em código, porém não são alimentadas nem exportadas para coleta.
- 2FA/MFA possui colunas no banco, mas não tem fluxo de cadastro, desafio ou recuperação.
- Backup e, principalmente, restauração ainda não foram exercitados em uma cópia descartável do ambiente alvo.
- Meta, OpenAI e Google não foram homologados com credenciais reais nesta base SaaS.

### Riscos técnicos relevantes

- O envio Meta é `at-least-once`: uma queda depois de a Meta aceitar a mensagem e antes do checkpoint no banco pode duplicar a resposta.
- Um webhook muito grande é processado sequencialmente, com uma transação por evento, podendo pressionar o tempo de ACK.
- Respostas interativas usam até três botões e descartam opções excedentes; catálogos/eventos maiores precisam de paginação ou mensagens de lista.
- A validação administrativa ainda depende de algumas constraints do banco para domínios e limites; o erro agora é seguro, mas a UX deve validar antes da escrita.
- Cabeçalhos HTTP estão razoáveis com Helmet, mas CSP do app está desabilitada e a política do proxy ainda precisa de hardening para produção.
- O arquivo `codex-session-01a044fd-4841-73b3-b456-d9d028928dee.md` tem cerca de 2,7 MB e permanece na raiz. Não foi removido por pertencer ao histórico do usuário.
- Esta pasta não contém `.git`; portanto não há diff, commit ou rollback por controle de versão comprovável nesta cópia.
- A entrada legada mantém endpoints de diagnóstico/sincronização sem autenticação e aceita webhook sem assinatura quando não há segredo; ela não deve ser exposta nem usada como produção.

## Plano para concluir o projeto

### Fase 1 — fechar o núcleo operacional

1. Ligar Google Sheets ao runtime oficial com resolvers PostgreSQL/cofre, cache persistente e jobs de sincronização/exportação idempotentes.
2. Implementar envio humano no painel com autorização, auditoria, persistência da mensagem e envio pelo número correto do tenant.
3. Criar gestão de jobs falhos: consulta, detalhe sanitizado, retry explícito e resolução auditada.
4. Ligar as métricas aos fluxos reais e publicar endpoint protegido para coleta.
5. Paginar menus/eventos e usar mensagens de lista quando houver mais de três opções.

### Fase 2 — segurança e recuperação

6. Implementar MFA para administrador da plataforma, incluindo recuperação segura.
7. Endurecer CSP, HSTS e demais cabeçalhos no Caddy/Nginx após definir os domínios reais.
8. Criar teste de integração contínuo com PostgreSQL/Redis e RLS, incluindo concorrência de webhook, pedidos e agenda.
9. Validar backup e restauração ponta a ponta em banco descartável, documentando RPO/RTO e rollback de migração.
10. Inicializar/reconectar o repositório Git e retirar o artefato de sessão somente após autorização do usuário.

### Fase 3 — homologação e produção

11. Subir uma homologação isolada com domínio, TLS, volumes, monitoramento e credenciais exclusivas de teste.
12. Cadastrar duas empresas completas e provar isolamento de números, credenciais, mensagens, limites, painel e integrações.
13. Homologar Meta, OpenAI e Google com dados sintéticos; testar retries, indisponibilidade e limites reais.
14. Executar teste ponta a ponta: webhook assinado → persistência/outbox → worker → resposta Meta → status de entrega/leitura.
15. Fazer revisão LGPD/retenção, runbook de incidentes e checklist de go-live antes de qualquer tráfego real.

## Decisões que ainda dependem do usuário/produto

- Google Sheets será fonte complementar, exportação ou ambos?
- O atendimento humano será feito no painel WAIA ou integrado a uma caixa externa?
- Qual provedor/estratégia será adotado para reduzir duplicidade no envio Meta?
- Quais domínio, VPS, RPO/RTO, política de retenção e orçamento por tenant serão usados?
- O artefato de sessão da raiz pode ser removido e esta cópia deve ser transformada em repositório Git?

Nenhuma credencial real foi lida, exposta ou usada nesta auditoria.
