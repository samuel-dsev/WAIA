# ADR 001 — portal e migração de identidade

Atualização F1, 18/09/2026: decisões 1, 2, 4, 5 e 6 implementadas localmente em v1.11.0; decisão 3 mantém unificação completa/MFA na F2. Migrações aditivas 021/022 e testes reais com duas identidades, isolamento RLS, rollback de auditoria e revogação passaram. Provedor de e-mail ainda não homologado. Estado operacional em [CONTAS_CLIENTE_F1.md](CONTAS_CLIENTE_F1.md) e evidências atuais em RELATORIO.md. O texto abaixo preserva o contexto da F0.

Data: 16/09/2026. Decisão técnica registrada na F0; implementação na F1/F2 mediante seus gates. Especificação dos contratos: [WAIA_2.0.0.md](../WAIA_2.0.0.md), seções 3, 5–8. Esta ADR registra a escolha e suas consequências, sem substituir a especificação.

## Contexto verificado

Inspeção da árvore funcional `497e511`, em `dev`, com documentação previamente modificada. As 20 migrações existentes são preservadas.

| Ponto | Evidência local | Consequência para a implementação |
|---|---|---|
| Entrada HTTP | `src/bootstrap/app-runtime.js` monta autenticação/admin sob `/api/admin` com `adminNetwork`; `auth/http.js` usa `waia_session` e SameSite Strict | Portal exige superfície e sessão próprias; manter o perímetro administrativo |
| Identidade | Migração 001: `usuarios.email` citext único; papel global `nenhum/administrador`; vínculos com papel `administrador/operador` | Reutilizar IDs e hashes; não transformar papel de empresa em papel global |
| Sessões | `auth_sessions` não possui audience nem versão de segurança; `AuthService.authenticate` relê usuário/vínculos | Acrescentar audience e versão; preservar releitura e rejeitar sessão de outra superfície |
| Permissões HTTP | `auth/permissions.js` usa catálogo fixo por papel; `auth/http.js` exporta `authorize`; busca em `src` não encontrou rota chamando esse middleware | O catálogo isolado não representa a autorização efetivamente usada pelo admin |
| Permissões de serviço | `admin/admin-service.js` chama `normalizedAdminAuth`, `requirePlatformAdmin` e `requireTenantAccess`; decisões por recurso vêm também de `admin/resources.js` | Caracterizar o comportamento antes de unificar; não substituir permissões apenas por nome |
| Permissões explícitas | `requireTenantAccess` suporta exceção por `permission`, mas o caminho `AdminService.#tenant` não passa esse argumento | Não presumir que o array do vínculo concede acesso em todas as operações atuais |
| Banco | Migração 003 força RLS; `infra/postgres/transaction.js` define contexto local e encerra em commit/rollback | RLS depende do contexto confiável estabelecido pelo servidor; não aceitar contexto administrativo do payload |
| Autenticação global | `auth/repositories.js` executa suas operações via `withPlatformTransaction` | Não expor esse repositório irrestritamente ao portal; encapsular bootstrap mínimo |
| Provisionamento | `AdminService.createTenant` exige plataforma e usa `withAuditedMutation`; não cria proprietário cliente | Criar serviço de cliente separado, com identidade validada, idempotência e vínculo/propriedade atômicos |
| Entrega | Dockerfile inclui panel/public e Node 22; CI usa Node 22 e não liga integrações opt-in | Incluir portal quando existir; teste local em Node 24 não comprova a imagem de release |

## Decisões

1. Manter monólito modular e portal HTML/CSS/JS em `portal/`, servido no mesmo origin das APIs `/api/account/v1` e `/api/app/v1`. Manter painel e API administrativa separados. Reutilização ocorre por serviços internos com DTOs, nunca abrindo `/api/admin` ao público ou chamando suas rotas por HTTP.
2. Expandir identidade de modo aditivo: verificação inicialmente ausente para contas antigas, versão de segurança e audience `admin/customer`. Sessões preexistentes recebem audience administrativa; nenhum vínculo ou proprietário legado é inferido. Não alterar as migrações 001–020.
3. Adotar um avaliador comum de autorização em `auth/permissions.js`, com adapters para a forma administrativa existente. O contrato considera audience, identidade ativa, vínculo atual, operação e propriedade. Somente audience administrativa pode usar poder global. F1 aplica a barreira de cliente; F2 fecha a unificação e matriz completa com testes de equivalência do admin. Nenhuma mudança de permissão nesta F0.
4. Para F1, usar repositório de contas com operações fechadas de bootstrap: consulta exata para autenticação, registro, consumo de token e provisionamento. Escolha: transações internas dedicadas e encapsuladas, permitidas pela seção 6.1, sem callback ou SQL fornecido por rota. O trecho privilegiado recebe somente parâmetros validados; não entrega client/transação ao controlador. Operações autenticadas comuns usam contexto de usuário sem flag administrativa e, para empresa, vínculo validado seguido de contexto tenant. Acrescentar helper de transação de identidade e políticas necessárias na F1. Testar com `waia_app`, incluindo pool reutilizado, falha de auditoria e proibição de leitura global durante bootstrap.
5. Provisionamento é uma transação com limite por usuário, chave idempotente e hash do pedido, empresa rascunho, vínculo administrador, proprietário, configuração mínima e auditoria. Serializar criação concorrente por identidade; mesma chave/payload retorna o resultado original, payload diferente retorna conflito. Não reutilizar CRUD global de usuários como API de cliente.
6. Tokens de verificação/reset têm digest, finalidade, geração, expiração e consumo único. Material de entrega cifrado e outbox são persistidos atomicamente. E-mail fake fica restrito a teste/desenvolvimento; F1 real depende de provedor/domínio. Migração não envia e-mail nem ativa tenant automaticamente.

## Alternativas e consequências

Expor o admin reutilizaria telas, mas também sua autoridade/perímetro; foi descartado. Duplicar usuários criaria duas identidades para o mesmo e-mail; foi descartado. Reescrever frontend/backend aumenta migração sem atender a um requisito desta fase; foi descartado.

Funções SQL restritas continuam alternativa se o caminho encapsulado não passar nos testes de privilégio. A escolha de transação interna mantém a fronteira de confiança no servidor, como na base existente; não torna a role compartilhada imune a SQL arbitrário. O gate exige testes reais, não apenas mocks de chamadas SQL. Mudança dessa escolha deve atualizar esta ADR antes da exposição pública.

Contratos de senha do cliente não devem reduzir silenciosamente a compatibilidade do hash/login legado (o serviço atual aceita até 256 caracteres; o plano propõe 128 para novas senhas do portal). Testar ambos explicitamente na F1.

## Dependências e custo/capacidade

Responsável pelas decisões externas: titular do WAIA; responsável técnico registra evidências da fase. A lista única de fornecedores, propriedade legada e aceites permanece na seção 20 do plano; nada foi contratado ou aprovado nesta F0.

Estimativa paramétrica: custo mensal = infraestrutura + backup/storage + e-mail transacional + IA por tokens + WhatsApp/conector + taxas de cobrança + suporte/impostos. Dimensionar volume de clientes, mensagens, tokens de entrada/saída, anexos, retenção e reenvios antes de aplicar tarifas verificadas. Sem fornecedor, volume e medição do host não há estimativa monetária defensável nesta fase. Os cenários de carga da seção 14 são metas de ensaio, não capacidade comprovada.

## Gate e validação

Baseline local: 424 testes, 412 aprovados, 0 falhas, 12 skips de integrações opt-in. Node v24.18.0/npm 11.16.0; execução com ambas as flags de integração em `false`. Na retomada, a mesma suíte passou em Node v22.23.2 usando container temporário, checkout somente leitura e rede desabilitada.

Docker `waia-test` confirmado: API/worker/PostgreSQL/Redis saudáveis, 20 migrações aplicadas, role `waia_app` sem superuser/BYPASSRLS, RLS forçada nas quatro tabelas de identidade/empresa, Redis PONG e readiness 200. Sonda SQL somente leitura confirmou visibilidade zero para identidade/tenant desconhecidos e contexto limpo após rollback/reutilização da conexão.

F0 concluída. A imagem dos serviços permanece v1.9.1, distinta do código atual; o teste Node 22 montou o checkout atual e não substituiu serviços. Isso não comprova migração/integração completa do código atual, nem os cenários de cadastro da futura F1. Evidências de imagem/volumes e limites estão em `RELATORIO.md`. Não houve migração, alteração de runtime, acesso à VPS ou efeito externo.
