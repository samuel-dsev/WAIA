# Relatório de continuidade — WAIA

Atualizado em 30 de agosto de 2026 após implementar e comprovar em infraestrutura real o atendimento humano pelo painel.

## Diagnóstico executivo

A fundação SaaS multiempresa está funcional e tecnicamente consistente para desenvolvimento e homologação controlada. Ela ainda não deve ser considerada pronta para produção: faltam ligar algumas capacidades já implementadas, completar a operação humana, validar integrações externas reais e fechar rotinas de segurança e recuperação.

Os executáveis oficiais são `src/api.js` e `src/worker.js`. A entrada `src/server.js` permanece apenas para compatibilidade com a demonstração legada do Capitão Mor.

## O que está comprovadamente implementado

- API Express com webhook Meta, autenticação administrativa, CSRF, autorização, páginas legais e health checks.
- Worker com outbox PostgreSQL, BullMQ/Redis, locks por conversa, concorrência por tenant, retries, backoff, dead-letter e heartbeat.
- PostgreSQL como fonte de verdade, com doze migrações, chaves compostas por tenant, idempotência, índices e `ENABLE/FORCE ROW LEVEL SECURITY`.
- Resolução do tenant por `metadata.phone_number_id`; API e worker oficiais não usam credenciais Meta globais.
- Conversas, mensagens, estados, pedidos, agendamentos, uso de IA, logs e auditoria persistentes.
- Runtime configurável com catálogo, eventos, pedidos, agenda, pagamentos, handoff e IA.
- Painel administrativo estático com login, dashboards e CRUDs centrais.
- Cofre de credenciais AES-256-GCM com AAD, versionamento, rotação, revogação, máscara e auditoria atômica.
- Tenant demonstrativo do Capitão Mor em seed sintético, sem credenciais, PIX ou dados pessoais reais.
- OpenAI Responses API com isolamento por tenant, limites, contingência, defesa contra prompt injection e contabilização de custo.
- Adaptador Google Sheets multiempresa e simuladores testados isoladamente.
- Comprovantes privados em JPEG, PNG, WEBP ou PDF até 10 MB, com download Meta autenticado por tenant, SHA-256, retenção e visualização auditada no painel.
- Atendimento humano no painel com assunção da conversa, CSRF, autorização, idempotência, mensagem/outbox/auditoria transacionais e envio assíncrono pelo número do tenant.

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
- Corrigida a falsa separação de papéis PostgreSQL: a configuração anterior transferia banco e objetos ao `waia_app`, concedia `CREATE` e executava migrações com a credencial da aplicação.
- Migrações agora exigem `DATABASE_MIGRATOR_URL`; API e worker recebem apenas `DATABASE_URL` do papel restrito e não recebem a senha do owner.
- O bootstrap repara volumes antigos, devolve propriedade ao owner, revoga `CREATE` e `TEMP` do papel da aplicação e mantém privilégios DML por grants atuais e default privileges.
- Adicionado teste PostgreSQL real para propriedades do papel, negação de `CREATE TABLE`/`ALTER TABLE` e isolamento RLS entre dois tenants sintéticos.
- O worker agora baixa a mídia da Meta antes de permitir que o pedido avance, inclusive quando a conversa está em atendimento humano; pedido PostgreSQL rejeita comprovante sem arquivo e checksum persistidos.
- Adicionado armazenamento privado por tenant, compartilhado entre API e worker, com metadados de MIME, tamanho, SHA-256 e data no PostgreSQL.
- O painel passou a visualizar comprovantes por endpoint autenticado e autorizado, com auditoria, `no-store`, `nosniff` e URL `blob:` temporária.
- MIME ou tamanho recusado gera orientação determinística ao usuário e não chama runtime nem IA; bytes de comprovantes nunca são enviados à OpenAI.
- A retenção remove arquivos privados associados às mensagens anonimizadas.
- Adicionado `media-init` para corrigir a propriedade do volume sem elevar os privilégios da API ou do worker; `.gitattributes` fixa scripts Alpine em LF no Windows.
- O operador que assumiu uma conversa agora pode responder pelo painel; outro operador, conversa fora do modo humano, contato bloqueado ou número inativo são recusados no backend.
- Cada clique usa UUID v4 persistido: repetição da mesma requisição devolve a mensagem existente e não cria outra mensagem nem outro job.
- A API retorna `202` somente depois de gravar mensagem, outbox e auditoria na mesma transação; falha de auditoria reverte a operação.
- O worker processa `send_human_message`, envia pelo número/credencial Meta do tenant e mantém retry, dead-letter e estados de entrega/leitura sem carregar texto ou segredos no Redis.
- A conversa no painel passou a mostrar as 100 mensagens mais recentes em ordem cronológica e o compositor reutiliza a chave de idempotência após falha ambígua de rede.

## Validação executada

- `npm test`: 163 testes descobertos; 158 aprovados, 4 testes PostgreSQL e 1 teste Redis opcionais ignorados sem infraestrutura.
- `node --check`: 134 arquivos JavaScript válidos.
- `npm run load:test`: cinco cenários sintéticos aprovados, de 250 a 800 jobs, sem falhas.
- `docker compose -p waia-today config --quiet`: configuração válida com valores sintéticos.
- Build Docker das imagens de API e worker concluído; instalação reportou zero vulnerabilidades npm.
- PostgreSQL 16 e Redis 7 iniciados em uma pilha temporária isolada.
- Migração incremental concluída; doze migrações descobertas e a migração de atendimento humano foi aplicada uma vez.
- Teste de integração real comprovou incremento de capacidade, rejeição de overbooking e liberação após cancelamento.
- API e worker iniciados com `NODE_ENV=production`; ambos ficaram saudáveis.
- `GET /health/ready` retornou HTTP 200.
- O teste real confirmou `waia_app` como `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE` e `NOBYPASSRLS`, sem `CREATE` no schema e sem `TEMP` no banco; tentativas de `CREATE TABLE`, `ALTER TABLE` e escrita em outro tenant foram rejeitadas.
- A inspeção dos contêineres confirmou ausência de `POSTGRES_PASSWORD` e `DATABASE_MIGRATOR_URL` na API e no worker.
- Bootstrap e migrações foram repetidos no mesmo volume: execução idempotente e `0` de `12` migrações reaplicadas.
- Três integrações PostgreSQL reais passaram: privilégios/RLS, capacidade da agenda e metadados/arquivo privado de mídia.
- A quarta integração PostgreSQL real comprovou resposta humana idempotente e auditada, envio bem-sucedido, retry e falha final em dead-letter.
- Redis real recebeu o job `send_human_message` contendo somente IDs, tipo, correlação e versão do payload.
- API e worker montam o mesmo `media_data`, permanecem como usuário `node` e ficaram saudáveis; `/health/ready` retornou 200.

O teste de carga continua sendo uma regressão em memória; ele não mede capacidade de VPS, latência de rede ou limites dos provedores.

## Lacunas e riscos ainda existentes

### Bloqueiam produção

- Google Sheets não está ligado ao `createPostgresRuntime` nem aos handlers oficiais. O adaptador existe, mas habilitar o módulo hoje não executa sincronização/exportação real.
- Não há tela/endpoint operacional para listar, reenfileirar ou resolver `jobs_falhos`; apenas contadores aparecem no dashboard.
- Métricas possuem registry em código, porém não são alimentadas nem exportadas para coleta.
- 2FA/MFA possui colunas no banco, mas não tem fluxo de cadastro, desafio ou recuperação.
- Backup e, principalmente, restauração ainda não foram exercitados em uma cópia descartável do ambiente alvo.
- Meta, OpenAI e Google não foram homologados com credenciais reais nesta base SaaS.
- O download de mídia foi validado com provedor simulado e armazenamento real, mas ainda precisa de homologação com um número Meta exclusivo de teste.

### Riscos técnicos relevantes

- O envio Meta é `at-least-once`: uma queda depois de a Meta aceitar a mensagem e antes do checkpoint no banco pode duplicar a resposta.
- Um webhook muito grande é processado sequencialmente, com uma transação por evento, podendo pressionar o tempo de ACK.
- Respostas interativas usam até três botões e descartam opções excedentes; catálogos/eventos maiores precisam de paginação ou mensagens de lista.
- A validação administrativa ainda depende de algumas constraints do banco para domínios e limites; o erro agora é seguro, mas a UX deve validar antes da escrita.
- Cabeçalhos HTTP estão razoáveis com Helmet, mas CSP do app está desabilitada e a política do proxy ainda precisa de hardening para produção.
- O arquivo `codex-session-01a044fd-4841-73b3-b456-d9d028928dee.md` tem cerca de 2,7 MB e permanece na raiz. Não foi removido por pertencer ao histórico do usuário.
- O volume local `media_data` é adequado para homologação em host único, mas deve entrar no backup/restauração e ser substituído ou replicado se a produção usar múltiplos workers/hosts.
- O repositório Git está presente, na branch `main`, conectado a `origin`; as mudanças desta continuidade permanecem locais e ainda não foram commitadas.
- A entrada legada mantém endpoints de diagnóstico/sincronização sem autenticação e aceita webhook sem assinatura quando não há segredo; ela não deve ser exposta nem usada como produção.

## Plano para concluir o projeto

### Fase 1 — fechar o núcleo operacional

1. Criar gestão de jobs falhos: consulta, detalhe sanitizado, retry explícito e resolução auditada.
2. Ligar as métricas aos fluxos reais e publicar endpoint protegido para coleta.
3. Paginar menus/eventos e usar mensagens de lista quando houver mais de três opções.
4. Ligar Google Sheets ao runtime oficial somente se ele for requisito da primeira empresa, mantendo PostgreSQL como fonte de verdade.

### Fase 2 — segurança e recuperação

6. Implementar MFA para administrador da plataforma, incluindo recuperação segura.
7. Endurecer CSP, HSTS e demais cabeçalhos no Caddy/Nginx após definir os domínios reais.
8. Expandir a integração contínua PostgreSQL/Redis, agora já cobrindo privilégios, RLS e agenda, para concorrência de webhook e pedidos.
9. Validar backup e restauração ponta a ponta em banco descartável, documentando RPO/RTO e rollback de migração.
10. Retirar o artefato de sessão da raiz somente após autorização do usuário.

### Fase 3 — homologação e produção

11. Subir uma homologação isolada com domínio, TLS, volumes, monitoramento e credenciais exclusivas de teste.
12. Cadastrar duas empresas completas e provar isolamento de números, credenciais, mensagens, limites, painel e integrações.
13. Homologar Meta, OpenAI e Google com dados sintéticos; testar retries, indisponibilidade e limites reais.
14. Executar teste ponta a ponta: webhook assinado → persistência/outbox → worker → resposta Meta → status de entrega/leitura.
15. Fazer revisão LGPD/retenção, runbook de incidentes e checklist de go-live antes de qualquer tráfego real.

## Decisões que ainda dependem do usuário/produto

- Google Sheets será fonte complementar, exportação ou ambos?
- O painel WAIA já cobre o atendimento humano mínimo; ainda deve ser decidido se haverá integração futura com uma caixa externa.
- Qual provedor/estratégia será adotado para reduzir duplicidade no envio Meta?
- Quais domínio, VPS, RPO/RTO, política de retenção e orçamento por tenant serão usados?
- O artefato de sessão da raiz pode ser removido?

Nenhuma credencial real foi lida, exposta ou usada nesta auditoria.
