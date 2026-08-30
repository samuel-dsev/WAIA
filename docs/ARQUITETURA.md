# Arquitetura da plataforma

## Decisões consolidadas

A evolução preserva a base atual e adota um monólito modular com três superfícies executáveis no mesmo repositório:

- **API:** webhook público, API administrativa autenticada, páginas legais e health checks mínimos.
- **Worker:** processamento ordenado das conversas, integrações, retries e envio de mensagens.
- **Painel:** aplicação web estática responsiva que consome a API administrativa.

PostgreSQL é a fonte de verdade. Redis é transporte de fila, lock, rate limiting e cache temporário; sua perda não pode apagar mensagens ou estados. Um outbox PostgreSQL é gravado na mesma transação da mensagem e permite republicar jobs depois de indisponibilidade ou reinício.

## Limites dos módulos

- `platform`: empresas, usuários, vínculos, ciclo de vida e publicação.
- `webhook` e `whatsapp`: assinatura, parsing, resolução do número e gateway Meta.
- `conversations`: contatos, conversas, mensagens e estado persistente.
- `modules`: catálogo, pedidos, eventos, agendamentos, pagamentos, handoff e IA.
- `integrations`: Meta, OpenAI e Google Sheets, com adaptadores simulados.
- `auth` e `security`: sessão, autorização, criptografia, rate limit e auditoria.
- `operations`: health, métricas, logs, retenção, outbox e jobs falhos.

Empresas são dados, não variantes de código. O registro de capacidades pode selecionar handlers por código de módulo, mas nenhum fluxo pode selecionar comportamento pelo nome ou slug de uma empresa.

## Contratos centrais

`RequestContext` contém correlação, ator autenticado, papel e empresas autorizadas. O backend deriva o tenant da sessão e do vínculo; `empresa_id` recebido do cliente nunca concede autorização.

`TenantRuntimeConfig` contém identidade, versão publicada, módulos, menu, IA, pagamentos, atendimento e integrações. Alterações incrementam a versão e invalidam cache, sem build nem reinício.

O webhook normaliza eventos de mensagem e status com `phoneNumberId`. A ingestão resolve o número, abre transação tenant, persiste mensagem idempotente e outbox, faz commit e só então responde à Meta. IA, Google e envio nunca ficam no caminho do ACK.

O worker recebe apenas referências por ID. Segredos não entram em Redis. Um lock por conversa e a sequência persistida garantem ordem; a confirmação no banco torna reentregas no-op. Retry usa backoff com jitter e dead-letter sanitizada.

Respostas humanas seguem o mesmo contrato assíncrono: o operador autenticado assume a conversa, e a API persiste mensagem de saída, chave de idempotência, outbox e auditoria na mesma transação. O worker resolve telefone, número e credencial dentro do tenant e registra o ID Meta antes de concluir o job. Estados de entrega e leitura continuam chegando pelo webhook assinado.

Falhas finais permanecem em `jobs_falhos` como incidentes imutáveis quanto ao erro original. A API administrativa expõe somente campos explicitamente selecionados, nunca o payload bruto. Um retry manual encerra o incidente e cria outra outbox com novo ID, evitando colisão com o job falho retido no BullMQ; uma resolução simples encerra apenas o alerta. Motivo, ator, tipo de resolução e vínculo com o novo job ficam persistidos e a auditoria participa da mesma transação.

## Isolamento

As tabelas operacionais possuem `empresa_id` direto ou uma relação composta que o valida. Repositórios sempre filtram explicitamente pelo tenant. PostgreSQL aplica `ENABLE/FORCE ROW LEVEL SECURITY`, com contexto definido somente por `SET LOCAL` dentro de transação. Consultas globais exigem papel de administrador da plataforma.

Migrações e DDL usam o owner por `DATABASE_MIGRATOR_URL`. API e worker usam exclusivamente `waia_app`, que não possui objetos, superusuário, criação de banco/papel, `BYPASSRLS`, `CREATE` no schema nem `TEMP` no banco. O bootstrap também repara volumes antigos antes de reaplicar os privilégios operacionais mínimos.

O mesmo telefone pode existir em tenants diferentes. Conversas, históricos, pedidos, consumo, logs e limites são identificados por empresa e nunca apenas pelo telefone.

## Segurança

Segredos recuperáveis usam AES-256-GCM, IV aleatório, tag de autenticação, versão da chave e AAD vinculada a empresa, credencial, provedor e finalidade. A chave mestra fica fora do banco. APIs retornam apenas máscara e metadados; auditoria nunca registra valores. O runtime multiempresa não aceita token de acesso nem `phone_number_id` globais para a Meta: ambos são resolvidos pelo tenant e pelo cofre.

Mídias recebidas não entram em Redis nem no contexto da IA. O worker resolve o `mediaId` na Meta, limita host, timeout, MIME e tamanho, calcula SHA-256 e grava em armazenamento privado com chave prefixada pelo tenant. A API lê o arquivo somente após autenticação e autorização no tenant, com auditoria, `no-store` e verificação de integridade.

Produção falha fechada se os segredos de validação do webhook ou a infraestrutura essencial estiverem ausentes. Desenvolvimento e testes podem usar adaptadores simulados explicitamente habilitados.

Sessões administrativas são opacas, revogáveis e persistidas, com cookies `HttpOnly`, `Secure` em produção e `SameSite=Strict`. Mutações exigem CSRF e autorização no backend. A alteração principal e seu log de auditoria compartilham a mesma transação, inclusive para credenciais e mudanças de atendimento; sem auditoria persistida, a mutação é revertida.

O envio manual só é aceito em conversa aberta, no modo humano e pelo usuário atualmente responsável. Contatos bloqueados e números inativos falham antes da criação da mensagem. O texto não é enviado à IA e o Redis recebe apenas a referência persistida.

## Operação inicial

Docker Compose executa proxy, API, worker, painel, PostgreSQL e Redis em rede interna. Somente proxy publica portas. Health público informa apenas vida/prontidão; diagnósticos detalhados exigem autenticação. PostgreSQL e Redis usam volumes e nunca são publicados diretamente.

O volume `media_data` é compartilhado apenas por API e worker. Um inicializador efêmero ajusta sua propriedade para o UID não privilegiado da aplicação; API e worker continuam executando como `node`. A rotina de retenção remove o arquivo depois de anonimizar seus metadados no banco.

O ambiente local pode usar adaptadores em memória para desenvolvimento da interface e dos fluxos sem credenciais externas. O modo de produção exige PostgreSQL, Redis e chave mestra.
