# WAIA 2.0.0 — especificação de implementação do SaaS

Data: 16/09/2026. Estado: F0 concluída; funcionalidades novas ainda não implementadas. F1 aguarda autorização.
Baseline funcional: `dev` em `497e511`, v1.10.6. `main` recebeu a mesma árvore pelo merge `707a46d`.
A revisão documental inicial foi v1.10.7; baseline e ADR iniciados em v1.10.8; fechamento da F0 prepara v1.10.9. O número 2.0.0 identifica a entrega futura, não a produção atual.

## 1. Objetivo, escopo e autoridade

Entregar um SaaS no qual o cliente cria sua conta, verifica o e-mail, cria sua empresa, escolhe e contrata um plano, configura o atendimento, conecta o WhatsApp e acompanha conversas pelo portal. O cliente deve conseguir assumir o atendimento e desligar/ligar a automação sem intervenção do operador WAIA.

Este documento é a fonte única dos detalhes da atualização. `PLAN.md` contém somente sequência e gates; `RELATORIO.md`, estado comprovado e pendências; `docs/OPERACAO_RELEASE.md`, procedimentos operacionais. O pedido de início de 16/09/2026 iniciou a F0. Implementação, contratação externa, teste real, commit/push e deploy obedecem às autorizações da sessão e ao `AGENTS.md`.

O escopo precisa ser entregue incrementalmente na base atual, em `dev`, sem reescrever o produto nem criar outro projeto. A primeira fase funcional será cadastro e acesso independente de clientes. A implementação das demais fases não fica autorizada automaticamente pela existência deste plano.

### 1.1 Critérios do produto mínimo 2.0.0

- Site público com proposta, recursos realmente disponíveis, planos, entrar, criar conta, suporte e páginas legais.
- Conta individual, verificação de e-mail, recuperação, sessões revogáveis, MFA e equipe por convite.
- Empresa criada pelo próprio cliente, propriedade definida, isolamento e edição do atendimento pelo portal.
- Uma assinatura por empresa no primeiro lançamento; usuário pode participar de várias empresas, selecionando uma por vez. Limite comercial de empresas criadas por usuário é configurável.
- Planos versionados, checkout hospedado, cobrança recorrente, consumo visível e aplicação de limites no servidor.
- Questionário de atendimento, FAQ, prévia segura, publicação versionada e base de conhecimento com texto, PDF textual e páginas públicas.
- WhatsApp oficial com conexão guiada; coexistência com QR para contas elegíveis deve ser validada antes de anunciar essa experiência. A decisão de conector da seção 11 é gate do lançamento.
- Caixa de entrada própria: texto, imagens/documentos recebidos e envio humano suportado pelo conector, status, busca, responsável e atualização em tempo real.
- Controle de automação por número e conversa, incluindo barreira de envio para trabalhos pendentes.
- Retenção, exportação, exclusão, observabilidade, backup/restore, suporte e lançamento gradual comprovados.

### 1.2 Fora da primeira versão

Instagram/Messenger, campanhas em massa, CRM de vendas completo, marketplace, aplicativo móvel nativo, voz em tempo real, chamadas, grupos/status do WhatsApp, OCR de PDF escaneado, importação de ZIP/Word/planilhas como conhecimento, white label, domínio por cliente, SSO empresarial e cobrança consolidada de vários tenants. Não oferecer esses recursos comercialmente na 2.0.0.

Agendas, pedidos, PIX e Google Sheets existentes serão preservados e terão regressão. Não serão obrigatórios no cadastro de um novo cliente. PIX de pedidos de uma empresa não é a cobrança da assinatura WAIA.

## 2. Estado encontrado e reaproveitamento

| Área | Evidência no código | Trabalho da 2.0.0 |
|---|---|---|
| Identidade | `src/modules/auth/*`; `usuarios`, `usuarios_empresas`, `auth_sessions` | Cadastro público, verificação, recuperação, MFA, convites e sessão do portal |
| Autorização | `auth/permissions.js` e `admin/authorization.js` | Unificar decisão efetiva e aplicar matriz do portal sem abrir poder global |
| Empresas | `admin/admin-service.js`, criação restrita à plataforma | Serviço específico de criação pelo cliente com vínculo atômico |
| PostgreSQL | `db/migrations/001` a `020`, RLS, FKs por tenant | Migrações aditivas, políticas para identidade e novas entidades |
| Configuração | `configuration/*`, `onboarding/*`, `panel/onboarding.js` | Formulário simples que compila para o contrato já existente |
| Conversas | `conversations/*`, `admin/router.js`, `panel/app.js` | Inbox própria, eventos e controle por número; preservar handoff |
| IA | `ai/*`, Responses API, quotas, pricing, cofre | Modelo administrado, conhecimento, créditos de plano e avaliações |
| WhatsApp | `meta/*`, `whatsapp/*`, número e webhook por tenant | Embedded Signup, coexistência, estado de conexão e capacidades |
| Operação | Outbox, BullMQ, monitor, backups, Docker | Filas de e-mail/ingestão/cobrança, isolamento de carga e recuperação |
| Assinaturas | Ausentes na inspeção | Domínio novo, sem reaproveitar pedidos/PIX dos tenants |
| Site/portal público | Painel atual administrativo | Entrada pública e UX de autoatendimento |

O painel atual já oferece assumir conversa, pausar bot, retomar bot e envio humano. A API já tem usuários por empresa. Não declarar essas capacidades inexistentes nem implementar duplicatas sem avaliar extensão.

O login e a API atuais estão sob `/api/admin`, sujeitos à allowlist no Express e no Traefik. Liberar esse prefixo inteiro para a internet não é a solução. A simples ocultação de menus também não estabelece isolamento.

As duas camadas atuais de autorização têm formas diferentes de representar permissões. Antes de expor recursos públicos, inventariar todos os chamadores, escolher um serviço de autorização comum e garantir equivalência do comportamento administrativo existente por testes.

## 3. Decisões de arquitetura propostas

1. Preservar Node.js/ES Modules, Express, PostgreSQL, Redis/BullMQ e o monólito modular. API, worker e monitor continuam processos separados.
2. Portal em `portal/`, inicialmente HTML/CSS/JavaScript modular, reaproveitando padrões acessíveis e cliente HTTP. Preservar `panel/` administrativo. Não impor migração para outro framework neste ciclo.
3. Site institucional em assets públicos, com links para o portal. Rotas do portal e API de cliente no mesmo origin para simplificar cookies, CORS e SSE.
4. API pública autenticada sob `/api/app/v1`; autenticação de cliente sob `/api/account/v1`. Administração em `/api/admin` com perímetro próprio.
5. PostgreSQL como verdade para identidade, mensagens, assinatura, consumo e jobs; Redis como transporte, cache, rate limit e exclusão mútua auxiliar.
6. Isolamento lógico por `empresa_id`, RLS forçada e autorização antes do acesso. Não criar banco, container, `.env` ou deploy por cliente.
7. OpenAI continua provedor inicial; modelo e precificação são política da plataforma. Adapter mantém futura troca possível, sem implementar vários provedores agora.
8. Plano por empresa; propriedade é atributo/vínculo explícito, distinto de administração da plataforma.
9. Flags de rollout persistidas e geridas pela plataforma. Estados de acesso, faturamento, conexão e automação permanecem separados.
10. Preservar o contrato `TenantRuntimeConfigV2` onde possível. A versão comercial 2.0.0 não obriga renomear o schema nem quebrar integrações antigas.

Fluxo de confiança:

```text
Navegador → sessão de cliente → autorização de vínculo → serviço de aplicação
          → transação com contexto de usuário/empresa → PostgreSQL + auditoria/outbox
Outbox → worker → política atual + quota + conector → WhatsApp/OpenAI/e-mail/cobrança
Webhook assinado → identificação de recurso conhecido → evento durável → processamento
Evento de conversa → feed autorizado → inbox da empresa no navegador
```

## 4. Jornadas e estados de interface

### 4.1 Novo cliente

Site → criar conta → confirmar e-mail → criar empresa → escolher plano → checkout → confirmação pendente ou assinatura ativa → questionário → conectar WhatsApp → testar → revisar → publicar → ativar automação.

Salvar progresso após cada etapa. Permitir voltar e continuar em outro login. Antes de pagar, permitir preencher dados e usar simulador determinístico; teste com IA real só mediante orçamento de trial explicitamente configurado. Se não houver trial aprovado, não fazer chamadas pagas nessa etapa.

Nunca ativar pelo retorno do navegador do checkout. Mostrar “confirmando pagamento” enquanto a confirmação do servidor estiver pendente. Nunca ativar apenas porque existe QR: exigir vínculo do número, saúde do conector, configuração publicada e entitlement válido.

### 4.2 Cliente existente e equipe

Login → seleção de empresa somente quando houver mais de uma → inbox ou próxima etapa incompleta. Convite aceito vincula a conta existente sem criar uma identidade duplicada. Operador vê atendimento; proprietário vê cobrança, equipe e controles sensíveis.

Cliente sem vínculo vê criar empresa/aceitar convite, não lista global. Ao trocar empresa, cancelar requests/streams antigos, limpar estado e caches de tela e descartar respostas atrasadas do contexto anterior.

### 4.3 Telas obrigatórias

Site/planos; cadastro; verificação/reenvio; login/MFA; esqueci senha; redefinição; empresa inicial; seleção de empresa; onboarding; prévia; inbox; conhecimento; equipe; conexões; plano/uso/faturas; perfil/sessões; exportação/exclusão; erro 403/404; manutenção.

Cada tela deve tratar vazio, carregando, erro recuperável, conexão perdida, permissão insuficiente e sessão expirada. Não exibir stack trace, tokens, IDs de banco ou termos internos como etapa obrigatória para o cliente. Layout responsivo, foco visível, teclado, labels, contraste e mensagens de validação junto ao campo.

## 5. Identidade, cadastro e recuperação

### 5.1 Modelo e provisionamento

Reutilizar `usuarios` global por e-mail normalizado. Acrescentar estado de verificação e versão de segurança, sem tratar e-mail antigo como verificado automaticamente. Estado de usuário ativo/bloqueado continua separado da confirmação de e-mail.

`register` valida nome/e-mail/senha/aceites; nunca aceita `platformRole`, `empresa_id`, limite de plano ou status privilegiado. E-mail duplicado tem resposta pública neutra e caminho de login/recuperação. Não alterar senha ou vínculos de conta existente durante cadastro repetido.

Gerar token criptográfico; armazenar apenas digest para validação, finalidade, usuário, expiração, consumo e geração. Proposta inicial: confirmação 24h, reset 30min, convite 72h; valores configuráveis e cobertos por teste. Um GET de scanner de e-mail não consome o token: confirmação deve exigir POST/interação explícita.

Persistir solicitação e outbox na mesma transação; envio ocorre fora da transação. Para entregar o link, armazenar o material de entrega cifrado em registro privado de curta duração, referenciado pela outbox; não colocar token puro no Redis/log. Apagar o material após entrega/expiração; reenvio gera nova geração e invalida as anteriores conforme política.

### 5.2 Sessões e proteção

- Preservar hash de senha scrypt e migrar parâmetros somente com benchmark e compatibilidade. Proposta: mínimo 12 caracteres, máximo 128, permitir gerenciador/colar e não impor troca periódica arbitrária.
- Cookie de cliente próprio, host-only, `HttpOnly`, `Secure` em produção, `Path=/`; não aceitar cookie administrativo como sessão de cliente sem verificar seu propósito.
- Persistir `audience` da sessão: `admin` ou `customer`, timestamps, expiração e versão de segurança. Rotacionar no login; logout revoga no servidor.
- Preferir `SameSite=Lax` no portal para retornos externos, sempre com CSRF/validação de origem nas mutações; manter política administrativa atual e testar callbacks sem enfraquecê-la.
- Token de sessão não vai para localStorage. Não registrar query de token, header Authorization, cookie nem senha. Páginas de recuperação sem analytics e com política de referrer restritiva.
- Rate limit compartilhado por IP e identidade, com proteção de rajadas/limite global e orçamento de e-mails. Evitar bloqueio permanente acionável por atacante. Configurar trust proxy explicitamente e testar IP forjado.
- Reset consome token atomicamente, muda hash e revoga todas as sessões; exige novo login e notifica o titular. Reset não remove MFA.
- Alteração de e-mail exige reautenticação, confirmação do novo endereço, aviso ao antigo e verificação de unicidade sob concorrência.
- Revogar sessão ou vínculo deve surtir efeito na próxima operação protegida e encerrar streams. Não confiar indefinidamente no snapshot de permissões do login.

Defaults propostos: sessão de cliente com 12h absolutas e 60min de inatividade; reautenticação sensível válida por 10min. Confirmar impacto na jornada com testes de relógio. Login: limite inicial de 5 falhas/15min por combinação de IP e identidade, com limite adicional por IP para ataques a várias contas; cadastro/reset/reenvio: 3 solicitações/15min por identidade e teto por IP. Esses parâmetros devem ser configuráveis, observáveis e ajustados após homologação, sem revelar se o e-mail existe.

Recuperação e tokens seguem a referência [OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html); os prazos e contratos acima são propostas específicas do WAIA.

### 5.3 MFA

Entregar TOTP e códigos de recuperação antes da abertura pública. Segredo TOTP cifrado no cofre; códigos aleatórios armazenados por hash, de uso único; confirmação inicial antes de ativar. Challenge com expiração, limite de tentativas e proteção de replay do contador.

Obrigatório para administrador da plataforma; disponível ao cliente e exigido do proprietário para operações críticas na política proposta. Reautenticar para transferir propriedade, desativar MFA, alterar credenciais, excluir empresa ou abrir gestão financeira. Definir procedimento manual auditado para perda simultânea de e-mail/MFA, sem desativação por pedido não comprovado. A mitigação do piloto antigo não substitui MFA da oferta pública.

## 6. Empresas, propriedade e autorização

### 6.1 Criação atômica pelo cliente

Usuário autenticado e verificado → conferir limite e idempotência → criar empresa rascunho → criar vínculo administrador → registrar proprietário → inicializar configuração mínima e estado comercial pendente → auditar → commit. Falha em qualquer parte reverte tudo.

Não simplesmente remover `requirePlatformAdmin` de `AdminService.createTenant`. Criar `CustomerProvisioningService` com payload restrito e idempotência vinculada ao usuário. Operações globais de identidade/provisionamento necessitam caminho privilegiado mínimo: revisar RLS atual, encapsular em transação interna dedicada ou função SQL restrita com `search_path` fixo, permissões explícitas e entradas limitadas. Nunca entregar flag `is_platform_admin` ao cliente nem executar toda rota pública como administrador.

Os testes precisam provar que o usuário não consegue obter leitura global durante esse bootstrap. Usar a role real `waia_app`, sem owner/superusuário, e validar pool reutilizado sem herdar contexto.

### 6.2 Matriz de acesso proposta

| Operação | Plataforma | Proprietário | Administrador empresa | Operador |
|---|---|---|---|---|
| Configurar atendimento/publicar | Auditada | Sim | Sim | Não |
| Assumir/responder conversa | Auditada | Sim | Sim | Sim, no escopo permitido |
| Credenciais/conexões | Auditada | Sim, reautenticação | Permissão explícita | Não |
| Equipe | Auditada | Sim | Operadores; sem elevar além do próprio poder | Não |
| Cobrança, exclusão, transferência | Exceção auditada | Sim, reautenticação | Não por padrão | Não |
| Ver outras empresas | Acesso interno autorizado | Só seus vínculos | Só seus vínculos | Só seus vínculos |
| Alterar plano/limite manualmente | Sim, motivo/validade | Não | Não | Não |

Proprietário permanece administrador da empresa, mas tem autorização explícita para ações reservadas. Impedir remoção/suspensão do último proprietário. Transferência exige aceite do destinatário já verificado, mantém ao menos um administrador e é transacional. Suspender funcionário revoga o vínculo e acesso correspondente, sem bloquear a identidade em outras empresas.

Convites por e-mail exato, sem busca pública de usuários globais. Papel definido pelo servidor dentro do poder do autor; aceite exige identidade dona do e-mail convidado. Desduplicar convite pendente; revogação e expiração devem ser verificadas no aceite, não só na tela.

Gerenciar equipe não concede permissão para redefinir senha/e-mail/MFA de outra identidade global. Essas operações pertencem ao titular ou a recuperação administrativa separada e auditada. Não expor o CRUD genérico de `usuarios` no portal. Uma conta com papel de plataforma usando sessão `customer` também não ganha bypass global: acesso excepcional ocorre apenas pela superfície administrativa protegida.

### 6.3 Isolamento obrigatório

Toda operação tenant-scoped valida vínculo e depois estabelece `SET LOCAL` na transação; filtros por `empresa_id` continuam explícitos. FKs compostas, índices tenant-first, paginação limitada, DTOs permitidos e checagem de mídia/exportação. Cache, jobs, locks, SSE, credenciais e buscas de conhecimento incluem tenant. Não usar apenas telefone ou ID fornecido pelo navegador como identidade do tenant.

Acesso de suporte exige finalidade/motivo e registro. Não incluir impersonação silenciosa na 2.0.0. Orientação complementar: [OWASP Multi Tenant Security](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html).

## 7. Contratos de API propostos

Todos os nomes abaixo são novos contratos planejados. Validar com Zod e testes HTTP. Coleções usam cursor opaco e limite máximo; erro `{code,message,fieldErrors?,correlationId}` sem detalhes sensíveis. 401 sem sessão, 403 sem permissão, 404 para recurso não visível, 409 conflito, 422 validação, 429 excesso com `Retry-After`, 503 indisponibilidade. Não revelar existência de outro tenant.

| Prefixo | Rotas e responsabilidade |
|---|---|
| `/api/account/v1` | `POST /register`, `/email/verify`, `/email/resend`, `/login`, `/logout`, `/password/forgot`, `/password/reset`; `GET /session`; `PATCH /profile`; `POST /password/change`, `/email/change` |
| `/api/account/v1` | `GET /sessions`; `DELETE /sessions/:id`; `POST /mfa/setup`, `/mfa/confirm`, `/mfa/challenge`, `/mfa/disable`, `/mfa/recovery-codes` |
| `/api/app/v1/companies` | `GET`, `POST`; `GET/PATCH /:empresaId`; criação por idempotência, dados permitidos |
| `.../:empresaId/team` | membros, convites, revogação, mudança de papel e transferência de propriedade |
| `.../:empresaId/onboarding` | progresso, questionário, draft com versão, validate, preview, publish e activate |
| `.../:empresaId/billing` | plano/uso/faturas, checkout, portal de cobrança; somente proprietário |
| `.../:empresaId/connections` | lista, início de autorização, status, reconexão, desligamento; sem retorno de segredo |
| `.../:empresaId/automation` | estado efetivo por número e `PATCH` com versão/motivo |
| `.../:empresaId/conversations` | listagem, mensagens paginadas, assumir, pausar, retomar e envio idempotente |
| `.../:empresaId/events` | feed SSE autenticado e retomável, apenas eventos da empresa |
| `.../:empresaId/knowledge` | fontes, upload, URL, status, reprocessar, publicar/remover e versões |
| `.../:empresaId/privacy` | exportar, consultar exportação, solicitar/cancelar exclusão conforme prazo |
| `/webhook/billing/:provider` | evento assinado com corpo bruto e persistência antes de ACK |
| `/api/app/v1/connections/meta/callback` | conclusão de autorização vinculada a tentativa/usuário/empresa; proteção contra replay |

Login público, cadastro e callbacks têm proteções próprias; não exigir CSRF de sessão inexistente. Mutações autenticadas exigem CSRF. OAuth usa state/nonce de uso único e validação de origem. Nenhum endpoint GET muda atendimento, assinatura ou credenciais.

Para create-company, checkout, mensagem e publicação usar `Idempotency-Key`: persistir hash do pedido, usuário/tenant/operação, resultado e expiração; mesma chave com payload distinto retorna 409. Nunca retornar resposta idempotente de outro usuário ou empresa.

## 8. Banco e migrações

Não editar migrações 001–020. Reservar números somente na implementação, consultando o último número existente. A sequência abaixo indica grupos lógicos, não nomes já criados.

| Grupo | Estruturas planejadas | Restrições essenciais |
|---|---|---|
| Identidade | campos de verificação/versão de segurança; tokens de conta; challenges; recuperação MFA; outbox de e-mail | digest único, finalidade, expiração, consumo atômico; acesso apenas ao titular/serviço |
| Propriedade | proprietário por empresa; convites; idempotência de provisionamento | um proprietário vigente, FK para vínculo válido, unicidade de convites e slug |
| Comercial | catálogo de planos/preços versionados; assinatura da empresa; customer externo; eventos de cobrança; overrides | IDs externos únicos por provider/ambiente; uma assinatura vigente por tenant |
| Consumo | ledger de créditos, reservas e concessões | chave de origem única; valores inteiros, saldo/reserva sem concorrência excedente |
| Conexão | tentativa de autorização, conexão/capacidades, vínculo com número existente | provider + conta/número únicos; uma conexão ativa para um número; segredos no cofre |
| Automação | estado por número, versão/epoch, motivo, ator; referência no trabalho gerado | atualização otimista; defaults legados preservados |
| Conhecimento | fontes, revisões, jobs, chunks/índice ou mapping de vector store | empresa em toda relação; revisão publicada; tamanho/contagem/custos limitados |
| Feed e privacidade | sequência de eventos, exportações, exclusões/tombstones, consentimentos | retomada por cursor; TTL; objetos privados; exclusão idempotente |

Planos globais são catálogo de leitura pública sanitizada, escrita só da plataforma. Identidade global usa política por usuário, não RLS tenant fictícia. Dados de assinatura, fontes e conexões pertencem à empresa. Tabelas de bootstrap/serviço devem ter grants mínimos explicitamente testados.

Usar timestamps UTC, moeda ISO e valores monetários inteiros em menor unidade; nunca float para cobrança/créditos. Separar ID interno de ID externo e ambiente sandbox/live. Payloads externos necessários a auditoria devem ser mínimos, privados, com retenção e sem credenciais.

Índices para empresa/status/updated_at, mensagens por conversa + sequência, deduplicação de webhook, jobs por estado/data e tokens por digest. Rever volume e tempo de criação de índices; backfills em lotes retomáveis, com contagem e checksum sanitizados. Alterações NOT NULL/checks entram após backfill validado.

### 8.1 Migração de clientes atuais

- Preservar usuários, IDs, vínculos, mensagens, credenciais, revisão ativa, módulos e conexões.
- Não confirmar e-mails existentes por suposição. Sessões administrativas antigas permanecem administrativas; habilitação do portal exige verificação apropriada.
- Definir proprietário dos tenants antigos com seleção explícita do operador; não escolher o primeiro usuário arbitrariamente.
- Criar entitlement legado/manual auditado para não bloquear o Capitão Mor por ausência de checkout. Identificar prazo/revisão e evitar override ilimitado silencioso.
- Novas flags públicas desligadas por padrão. Automação antiga preserva comportamento até migração deliberada.
- Migração não envia e-mails, cobra, troca números ou republica configuração automaticamente.

## 9. Planos, cobrança e consumo

### 9.1 Política comercial

Primeira versão com cobrança mensal e checkout hospedado de um único provedor, escolhido pelo responsável antes da fase comercial. Não implementar cartão no WAIA. Anual, proporcional de upgrade e adicionais ficam fora até contratos/testes próprios; upgrade/downgrade inicialmente no próximo ciclo, claramente informado.

Catálogo versionado: nome, preço/moeda, vigência, usuários, números, respostas/créditos, armazenamento, fontes e capacidades. Preço exibido vem do servidor; o client envia apenas identificador conhecido. Proibir plano livre, valor arbitrário ou referência de outra empresa. Preços e margens ainda não aprovados; não copiar preços do concorrente.

Estados normalizados: `pending`, `trialing`, `active`, `past_due`, `suspended`, `canceled`. Manter período pago, cancelamento agendado e causa separados. Cancelamento ao fim do ciclo mantém recursos até a data paga; exclusão de empresa é outra operação.

Proposta de inadimplência: desabilitar automação e novos gastos após janela de tolerância configurada; permitir login, cobrança e exportação. Escopo de envio humano após inadimplência depende de custos e decisão comercial explícita. Nunca apagar dados imediatamente por falha de cartão.

### 9.2 Adapter e webhooks

`BillingProvider`: `createCheckout`, `getSubscription`, `createPortalSession`, `scheduleCancellation`, `verifyWebhook`, `normalizeEvent`. Segredos por ambiente na infraestrutura/cofre da plataforma, sem exposição a tenants. Escolher provedor considerando disponibilidade para o operador, recorrência, reembolso, impostos/documentos fiscais, webhooks, sandbox e custos totais.

Checkout criado pelo backend sob autorização e idempotência. URL de retorno allowlisted. Processar assinatura do webhook sobre bytes brutos; persistir evento validado com unicidade provider/eventId antes do ACK. Worker reconcilia estado externo e ignora repetição/ordem antiga. Não confiar em metadata enviada pelo navegador para escolher tenant.

Timeout ou resposta ambígua não significa falha financeira definitiva. Reconciliar pelo provedor antes de gerar outra cobrança. Rotina periódica corrige eventos perdidos, assinatura órfã e divergência de período. Eventos sandbox nunca alteram assinatura live. Referência de comportamento de webhooks, sem escolha de fornecedor: [Stripe Webhooks](https://docs.stripe.com/webhooks).

Reembolso e contestação devem ter estados e trilha próprios, vinculados à fatura/transação. No MVP, solicitação de reembolso passa pelo suporte e é executada no portal do provedor por pessoa autorizada; o webhook reconcilia créditos/entitlements conforme política aprovada, sem apagar ledger. Testar reembolso parcial/total, contestação aberta/ganha/perdida e pagamento recuperado. Não suspender todas as empresas de um usuário por problema financeiro em uma delas. Guardar link de recibo/fatura emitido pelo provedor com autorização; emissão fiscal aplicável deve ser definida com o responsável antes de vender.

### 9.3 Créditos e limite de custo

Preservar limite mensal de custo/tokens da IA e acrescentar ledger comercial. Reservar crédito e teto de custo antes da chamada; finalizar uma vez por execução; reprocessamento do mesmo job não cobra duas vezes. Expirar/reconciliar reservas abandonadas após verificar o estado do trabalho.

Proposta de unidade comercial: uma resposta concluída de IA, com custo interno por tokens e modelo. Definir antes do lançamento se uma resposta gerada mas não entregue consome crédito; padrão proposto: não debitar crédito comercial, registrar custo técnico absorvido. Simulador determinístico não consome. Retry de entrega não gera nova IA nem débito.

Plano esgotado não deve bloquear recebimento de mensagens. Exibir aviso e oferecer atendimento humano conforme política. Aplicar limites também no worker, upload, convites, conexões e prévia; não apenas na interface. Reservas são transacionais para evitar duas chamadas gastarem o último crédito. Cache de entitlement curto, versionado e invalidado nas mudanças.

O preço final deve cobrir OpenAI, WhatsApp/provedor, armazenamento, e-mail, infraestrutura, taxas/impostos e suporte. Não prometer uso ilimitado sem teto e controle de custo.

## 10. Questionário, IA e conhecimento

### 10.1 Questionário

Dados: identidade/segmento, produtos/serviços, horário/fuso, localização/canais, regras e políticas, FAQ, tom/idioma, objetivo, dados que pode coletar e condições de transferência humana. Campos opcionais não podem gerar fatos inventados. Informar o que falta antes de publicar.

Implementar `QuestionnaireCompiler`: converte formulário amigável em `TenantRuntimeConfigV2`, usando módulos e referências existentes. Preservar rascunho, revisão otimista e publicação atômica. Perfil simples habilita FAQ/IA/humano; módulos de pedido/pagamento/agenda só com escolha explícita e dependências satisfeitas.

Não pedir chave OpenAI, nome técnico do modelo, payload de botão, WABA ou token manual ao cliente comum. Credenciais próprias e configuração avançada ficam em área específica, com permissões e metadados mascarados.

### 10.2 Runtime e modelo

Manter Responses API e `store:false` no caminho atual. Escolher modelo por avaliação de português, obediência à base, latência e custo; não trocar modelo do tenant legado implicitamente. Catálogo de modelos aprovado pela plataforma com fallback e preços versionados. Testar acesso real ao modelo no projeto antes de publicar; histórico já mostrou modelo listado e snapshot sem acesso.

Separar instruções da plataforma, regras da empresa, conteúdo recuperado e mensagem do visitante. Conteúdo/arquivo do cliente não pode conceder poderes, acessar outras empresas ou transformar texto em código/URL arbitrária. Ações operacionais passam por catálogo e validação determinística; IA não confirma pagamento nem inventa disponibilidade.

Sem informação suficiente, admitir limitação e encaminhar. Se provedor falhar, responder fallback uma única vez ou transferir conforme configuração; timeout/retry limitados. Nunca mandar PIX, tokens, bytes de comprovante ou dados de outra empresa ao modelo.

### 10.3 Base de conhecimento

Primeira entrega: texto/FAQ, PDF com texto e URL pública individual; sem crawler ilimitado. Pipeline: fonte privada → validação → fila → extração → revisão → indexação → teste → publicação. Cliente acompanha `pending/processing/ready/failed/deleting`, erro sanitizado e reprocessamento idempotente.

Proposta inicial: texto normalizado e metadados no PostgreSQL; busca textual para conteúdo pequeno e interface `KnowledgeRetriever`. Para recuperação semântica, escolher em gate técnico entre pgvector e File Search antes de implementar indexação; não manter dois índices de produção sem necessidade. Recomendação inicial é avaliar pgvector para reutilizar backup e isolamento existentes, com prova de qualidade/capacidade; File Search é alternativa gerenciada. [OpenAI File Search](https://developers.openai.com/api/docs/guides/tools-file-search).

Se usar serviço externo: vector store selecionado exclusivamente pelo backend após autorização, mapping por tenant, lifecycle de exclusão e retenção explícitos; `store:false` da resposta não apaga arquivos/índices. Se usar pgvector: extensão/imagem pinada, embeddings com modelo/dimensão/versionamento e consulta sempre tenant-scoped. Não criar índice incompatível sem plano de migração.

Arquivos: limite proposto de 10 MiB/PDF, 100 páginas e 50 fontes por empresa no plano inicial de teste; não são limites comerciais aprovados. Validar MIME por assinatura, sanitizar nome, limitar expansão/memória/tempo de parser, tratar arquivos malformados e rejeitar PDF sem texto com explicação. Storage privado, conteúdo sem execução, extração em worker limitado. Antivírus/quarentena conforme risco do download e exposição; nenhum arquivo recebido é servido como HTML ativo.

URLs: apenas HTTP(S) público, bloquear loopback, rede privada, metadata e destinos internos IPv4/IPv6, validar DNS e cada redirecionamento, limitar portas/tamanho/tempo; proteger contra DNS rebinding. Não acessar páginas autenticadas nem seguir instruções do conteúdo. Registrar origem/data e permitir remover/atualizar.

Chunks mantêm fonte, tenant, revisão, hash, ordem e limites de contexto. Publicar revisão nova só após processamento completo; manter anterior em falha. Exclusão retira imediatamente da busca e agenda remoção física. Reindexação/embedding não pode contaminar contexto durante troca de versão.

### 10.4 Avaliação obrigatória

Conjunto sintético por domínio com respostas esperadas: FAQ factual, ausência de dado, tentativa de acessar outra empresa, instrução maliciosa no PDF, pedido de segredo, cobrança, horário e handoff. Critérios propostos: zero vazamento, zero confirmação financeira inventada, 100% das ações privilegiadas bloqueadas sem autorização, pelo menos 90% de acerto nas FAQs de referência. Versão de prompt/modelo/fontes registrada; não usar conversas reais sem base e autorização apropriadas.

## 11. WhatsApp, QR code e conexão

### 11.1 Decisão obrigatória antes da implementação do conector

Preferência técnica: Cloud API existente + Embedded Signup e coexistência para números elegíveis. QR não identifica por si só integração oficial. O WAIA não embutirá a página do WhatsApp Web em iframe; exibirá uma inbox própria alimentada pelo conector.

O fluxo oficial exige habilitação/revisão do app e permissões aplicáveis ao papel de provedor. A documentação da Meta confirma Embedded Signup; a documentação da 360dialog mostra coexistência/QR, mas suas telas e condições são do serviço dela. Validar caminho direto Meta e disponibilidade da conta WAIA antes de prometer comportamento. Não presumir que todo WhatsApp pessoal pode usar coexistência.

Se o requisito comercial for “qualquer WhatsApp escaneia e funciona”, decidir explicitamente entre restringir elegibilidade do lançamento ou acrescentar conector não oficial. Não substituir o requisito por API manual sem informar a limitação.

Alternativa não oficial, somente após decisão: adapter Baileys ou provedor equivalente, avaliado por licença, política, estabilidade, segurança e manutenção. Exigiria processo de sessões, lease por conexão, credenciais cifradas, reconexão/backoff, monitoramento, revogação e recuperação. Esse trabalho não está implicitamente incluído na implementação da Cloud API. O projeto [Baileys](https://github.com/WhiskeySockets/Baileys) declara não ser autorizado/afiliado ao WhatsApp.

### 11.2 Conector oficial

Implementar `WhatsAppConnectionService` e adapter com operações de iniciar autorização, concluir, consultar saúde/capacidades, enviar, normalizar eventos e revogar. Preservar adapters Meta existentes de envio/mídia e seus testes.

Tentativa vinculada ao usuário, tenant, nonce/state, horário, expiração e origem permitida; conclusão exige mesma autorização vigente. Código/token trocado só no backend. Não confiar apenas no payload do popup: confirmar WABA/número e acesso pelo provedor, então persistir referência cifrada e assinar webhooks.

Um número já pertencente a outro tenant não pode ser vinculado por conhecimento do ID. Transferência exige procedimento explícito. App da plataforma compartilhado não implica WABA/token compartilhado livremente: resolver tenant pelo número autorizado e validar assinatura antes da ingestão. Reavaliar o modelo `aplicativos_meta` atual para app de plataforma, mantendo compatibilidade com apps próprios existentes; evitar duplicar App Secret global como credencial editável por cliente.

Estados: `disconnected`, `authorizing`, `pending_verification`, `connected`, `degraded`, `revoked`. Persistir última transição, diagnóstico redigido, validade e capacidades. Expiração de QR/tentativa dá opção de reiniciar, sem expor o segredo em log. Desconectar revoga acesso local imediatamente e tenta revogação remota por job; falha remota fica visível e gera retry.

### 11.3 Sincronização e limitações

Webhooks: verificar assinatura/corpo bruto, resolver vínculo conhecido, persistir evento único e outbox, ACK rápido. Confirmar eventos de coexistência, incluindo mensagens enviadas pelo aplicativo e histórico disponível. Eventos de histórico nunca disparam IA nem cobrança; eco de envio não é nova mensagem do visitante.

Deduplicar por conexão/provider/messageId; correlacionar ID de envio e estados fora de ordem sem regredir delivered/read. Sincronização interrompida retoma por checkpoint quando suportado. Não prometer histórico integral: registrar janela/capacidades/consentimento e mostrar alcance importado.

Regras de janela de atendimento, templates, tipos de mídia e custos devem ser consultadas na documentação do provedor durante a fase. API e UI devem bloquear envio incompatível antes de enfileirar. Para templates suportados, oferecer somente modelos aprovados já disponíveis; gerenciamento de campanhas não entra na versão.

Fontes: [Meta Embedded Signup](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup), [360dialog Coexistence](https://docs.360dialog.com/docs/hub/embedded-signup/coexistence-onboarding).

## 12. Inbox e controle da automação

Lista paginada com busca por contato autorizado, não lidas, responsável, modo e estado da conexão. Histórico paginado com ordenação determinística; texto seguro sem HTML executável, anexos privados, falha/envio/entrega/leitura distintos. Pesquisa não varre histórico global nem devolve conteúdo de outro tenant.

Envio humano mantém regra atual: conversa aberta, modo humano e responsável autenticado. Inserir mensagem/outbox/auditoria atomicamente; apresentar pending; somente confirmar enviado quando provedor responder. Retry não duplica mensagem nem ignora regras atuais.

Não prometer exactly-once de um efeito externo sem garantia do provedor. Se o envio pode ter sido aceito e houve timeout antes de persistir o ID, marcar resultado ambíguo e usar reconciliação/status quando disponíveis; não reenviar cegamente. Registrar a escolha de política por conector e permitir resolução auditada. Idempotência interna não resolve sozinha essa janela de falha.

Feed SSE inicial: autenticado por cookie, `Last-Event-ID`, heartbeat, cursor e limite de retenção. Sequência durável por empresa no banco, Redis apenas notificação. Se cursor expirou, cliente busca snapshot; sem replay de todo o histórico. Revalidar permissão/revogação, limitar conexões por usuário, controlar buffer/backpressure e limpar conexões ao trocar tenant/logout. Polling limitado como fallback. Não usar IDs privados em canal público.

### 12.1 Estado efetivo da IA

`pode_responder = empresa_operacional && assinatura_permite && conexao_ativa && numero_automacao_on && conversa_bot && configuracao_publicada && quota_disponivel`.

Uma chave global “IA desligada” significa pausar todas as respostas automáticas daquele número, inclusive menus/fallbacks; recebimento, histórico e uso humano continuam conforme política. Não confundir com “desabilitar somente módulo ai_freeform”. Mostrar motivo efetivo: desligada pelo usuário, atendimento humano, plano, crédito, conexão ou erro.

Persistir versão/epoch da automação. Ao pausar, incrementar sob lock e auditar. Trabalhos carregam versão e a revalidam antes de gastar IA e imediatamente antes do envio. Se houve pausa/assunção, descartar saída automática pendente e reconciliar reserva; não reproduzir fila antiga automaticamente ao religar.

O limite técnico deve ser explícito: mensagem já entregue ao provedor não pode ser recolhida com garantia. A confirmação de pausa informa isso; impedir novos despachos após a barreira de pausa, serializando a decisão de envio/controle e tratando chamadas em voo. Testar a corrida pause × generate × enqueue × send × human_assume.

## 13. Infraestrutura, segurança e privacidade

### 13.1 Serviços e distribuição

Continuar Docker Compose. Portal público entra na imagem/servidor de assets e nas regras de proxy; ajustar Dockerfile e CI para incluí-lo. Banco/Redis sem portas públicas. Workers lógicos para mensagens, e-mail, billing e conhecimento com concorrência/cotas separadas; começar no mesmo host, sem deixar extração de PDF bloquear atendimento.

Não usar estimativa antiga de 1 CPU/4 GB como capacidade garantida. Medir CPU/RAM/disco/latência e crescimento antes de liberar assinantes. Reservar espaço para banco, mídia, índices, backups e imagem anterior. Preservar EasyPanel, Traefik, n8n e ambientes Docker existentes.

Segredos globais necessários: projeto OpenAI, app Meta, provedor de e-mail, billing sandbox/live, keyring, pepper e métricas. Configuração de tenant pelo painel; nenhuma nova variável `.env` por assinante. Modo de testes nunca pode habilitar provedor simulado em produção.

### 13.2 E-mail e dependências externas

Selecionar provedor transacional e domínio/remetente; configurar autenticação de domínio conforme provedor e testar entrega, bounce e supressão. Templates: verificação, reset, convite, mudança de e-mail/senha, MFA, assinatura e exportação. E-mails estritamente transacionais, sem marketing implícito. Retries limitados, estado visível e alerta de fila/falha; não imprimir links secretos em produção.

Antes de iniciar recursos que dependem de fornecedor, registrar responsável, conta, plano/limites, custo e requisitos de aprovação. Desenvolvimento usa adapters fake e sandbox; abertura real exige integração comprovada.

### 13.3 Privacidade e exclusão

Inventário: identidade, mensagem, anexos, fontes, índices/embeddings, logs, cobrança e backups, com finalidade e prazo. Política comercial pública e termos precisam de nova revisão para autoatendimento, suboperadores, IA, cobrança, cancelamento e responsabilidade pelo conteúdo. O aceite de 2026-09-07 cobre o piloto, não autoriza automaticamente textos da nova oferta.

Exportação assíncrona tenant-scoped com formato documentado, arquivo privado, expiração e auditoria de download; não exportar credenciais. Dados financeiros pessoais e dados de usuários que participam de outras empresas exigem projeção mínima, não dump de banco.

Exclusão de conta não exclui automaticamente empresas: exigir transferência/encerramento se for último proprietário. Encerramento de empresa cancela renovação conforme política, desliga automação, revoga conexões e agenda remoção de mensagens/fontes/mídias/índices, respeitando retenções aprovadas. Tombstone impede restaurar silenciosamente contas excluídas após backup; aplicar registro de exclusões em recuperação.

Informar janela de retenção em backup e procedimento de purge; não prometer apagamento instantâneo de backup imutável. Guardar apenas registros de cobrança/auditoria necessários sob política aprovada. Revalidar obrigações com responsável jurídico antes de abertura pública.

### 13.4 Controles de aplicação

TLS, CSP ajustada somente para SDK/provedores necessários, CORS restrito, CSRF, sanitização de conteúdo, limites de corpo, uploads privados, SQL parametrizado, cookies seguros e dependências auditadas. Rate limiting distribuído e limites globais em cadastro/IA/e-mail/ingestão. Testar mass assignment, enumeração, IDOR, SSRF, replay e acesso por sessão revogada.

Logs sem conteúdo integral de conversa, tokens, QR, e-mail de reset ou segredo. Auditoria persistida com ator, tenant, ação, resultado, recurso e correlação; ações críticas falham se auditoria transacional falhar. Conteúdo de PDF/URL/WhatsApp é dado não confiável, inclusive quando sugere instruções técnicas.

## 14. Operação, métricas e recuperação

Métricas: duração de requisição, filas por tipo, idade do job mais antigo, falhas de envio/IA/e-mail, eventos billing pendentes, reconexões, latência até primeira resposta, quota negada, reservas vencidas, disco e backup. Não usar tenantId/telefone como label de alta cardinalidade; detalhes por empresa ficam no banco/diagnóstico autorizado.

Alertar por mudança acionável e recuperação: conexão degradada, webhook parado, backlog, erro de cobrança, e-mail indisponível, consumo anômalo, falha/idade de backup. Deduplicar e sanitizar; validar canal real antes do lançamento. Dashboard de suporte mostra estados e referências, não segredos.

Runbook de incidente deve definir triagem, responsável, pausa seletiva, preservação de evidência, rotação/revogação de credenciais, comunicação ao cliente e validação de recuperação. Em suspeita de exposição, identificar empresas e dados afetados sem copiar conteúdo para logs; prazos/notificações seguem política jurídica aprovada. Testar rota de suporte para perda de acesso, pagamento pendente, QR expirado e IA incorreta antes do piloto.

Targets propostos para homologação, ainda não SLA comercial: API interna p95 <500ms em leituras usuais; ACK webhook p95 <1s após gravação durável; evento na inbox p95 <2s; resposta IA p95 <15s em carga acordada, separando latência do provedor. Cenário inicial: 10 empresas sintéticas, 20 operadores, rajada de 5 mensagens/s por 10min e 1 mensagem/s por 60min. Ajustar capacidade/plano se não passar; não publicar promessa antes de medir.

RPO/RTO históricos: 24h/4h. Reaprovar adequação para SaaS público; proposta é começar sem SLA superior ao comprovado. Backups incluem banco, mídia e novo conhecimento; incluir recuperação de índices externos e credenciais necessárias. Teste de restore isolado mede tempo real e perda possível. Não confundir restart com restore.

Redis não é backup da aplicação; recuperar trabalho a partir de outbox persistida e idempotência. Após restore, impedir cobranças/mensagens duplicadas: reconciliar IDs externos e ledger antes de liberar workers. Outbox de e-mail/financeira também requer reconciliação.

## 15. Mapa de implementação por arquivos

| Área | Criar (proposto) | Alterar/reutilizar |
|---|---|---|
| Conta | `src/modules/accounts/{account-service,account-repository,http,email-token-service,mfa-service}.js` | `auth/*`, bootstrap, migrações, DTOs |
| Empresa cliente | `src/modules/customer/{provisioning-service,team-service,router,authorization}.js` | admin service/repository, RLS e transações |
| E-mail | `src/integrations/email/*`, worker transacional | outbox, jobs, monitor, config |
| Portal | `portal/index.html`, `portal/styles.css`, módulos por conta/inbox/onboarding/billing | Dockerfile, proxy, public, helpers seguros |
| Cobrança | `src/modules/billing/*`, `src/integrations/billing/*` | quotas, jobs, auditoria, admin |
| Conhecimento | `src/modules/knowledge/*`, extractor/retriever adapters | runtime IA, cofre/storage, retenção |
| Conexão | `src/modules/connections/*` | `meta/*`, `whatsapp/*`, webhook e cofre |
| Automação/feed | `src/modules/automation/*`, `src/modules/events/*` | conversations, jobs, outbox e inbox |
| Privacidade | `src/modules/privacy/*` | export/retention existentes, páginas legais |

Não criar arquivos placeholder sem funcionalidade. Confirmar nomes existentes antes de duplicar serviços. Serviços de aplicação compartilhados devem receber contexto autenticado e DTOs; rotas não chamam umas às outras por HTTP interno para reaproveitar lógica.

## 16. Fases de entrega e gates

Cada fase termina com evidência de código, migração, testes e riscos em `RELATORIO.md`. Antes de commit: apresentar arquivos, versão e mensagem; aguardar confirmação. Próxima fase exige autorização própria. Dependências externas podem ser investigadas enquanto a fase interna avança, sem cadastrar/contratar/publicar automaticamente.

### F0 — baseline e decisões técnicas

Execução local e escolhas registradas na [ADR 001](docs/ADR_001_PORTAL_IDENTIDADE.md). Gate concluído com verificação do ambiente Docker `waia-test`; evidências e limites em `RELATORIO.md`.

- Confirmar árvore/branch/versão, baseline dos testes e ambiente `waia-test` existente.
- Inventariar autorização, schemas, serviços e políticas; fechar ADR de API/portal e migração de identidade.
- Registrar decisões de fornecedor pendentes com responsável; estimar custo/capacidade sem inventar preços.
- Gate: baseline reproduzível e nenhum dado real afetado. Nenhum reset de volume implícito.

### F1 — contas e empresa própria (primeira implementação)

- Migrações de verificação/tokens/sessão cliente/proprietário; bootstrap privilegiado mínimo.
- Cadastro, confirmação, login/logout, recuperação/troca de senha e criação idempotente da empresa.
- Portal mínimo: entrada, perfil, empresa e estado de onboarding; manter rota admin protegida.
- Adapter de e-mail fake/teste e configuração do provedor real preparada; entrega real depende de domínio/conta.
- Gate: dois clientes criam e retomam empresas distintas; usuário comum nunca vira platform_admin; testes negativos por API e PostgreSQL real; reset e revogação comprovados.
- Não incluir cobrança ou nova conexão WhatsApp nesta fase. Versão minor compatível a definir ao fechar o escopo; não rotular como 2.0.0 entregue.

### F2 — equipe, MFA e autorização completa

- Convites/aceite/revogação, proprietário e transferência, matriz única, sessões e MFA.
- Corrigir qualquer permissão implícita incompatível sem regressão de administrador legado.
- Gate: usuário em duas empresas tem papéis independentes; operador não lê cobrança/segredos; perda de vínculo corta SSE/API; último proprietário protegido.

### F3 — onboarding e IA simplificados

- Questionário para V2, defaults seguros, revisão, simulador e prévia com orçamento.
- Catálogo de modelos controlado e testes de qualidade/fallback.
- Gate: cliente configura e publica FAQ/IA/humano sem IDs técnicos, `.env`, SQL ou deploy; rascunho não altera runtime ativo.

### F4 — planos, assinatura e quotas

- Catálogo/ledger/entitlements, checkout e portal do provedor escolhido, webhooks/reconciliação.
- Migrar tenant legado para acesso manual explícito sem cobrança.
- Gate: ciclo sandbox completo com duplicação/ordem inversa, cancelamento, falha, limite simultâneo e recuperação; zero liberação pelo redirect do navegador.

### F5 — conexão WhatsApp autônoma

- Gate externo: app/provedor/eligibilidade e decisão de QR fechados.
- Autorização, cofre, vínculo, webhook, estados, reconexão e revogação; coexistência/eco/histórico quando suportados.
- Gate: duas empresas/números de teste conectados pelo fluxo escolhido, sem copiar tokens manualmente; revogar um não afeta outro; histórico importado não dispara bot.

### F6 — inbox e automação

- UX de conversa, feed, mídias, envio humano e controle global por número.
- Barreira de pausa no worker e reconciliação de trabalhos pendentes.
- Gate: corrida entre humano/bot/pausa não gera novo despacho indevido; mensagem já em voo identificada; reconexão da tela não duplica mensagens.

### F7 — conhecimento

- Escolher retriever por prova técnica; implementar texto/PDF/URL, revisão, publicação e remoção.
- Limites/isolamento de processamento e avaliações de qualidade/ataques.
- Gate: falha de extração preserva versão ativa; exclusão retira da busca; nenhuma recuperação de fonte de outra empresa.

### F8 — site, privacidade e prontidão comercial

- Site e planos reais, onboarding retomável, ajuda, cobrança, exportação/exclusão, acessibilidade.
- Domínio/e-mail/termos/suporte/limites comerciais aprovados; capacidade e observabilidade verificadas.
- Gate: jornada de novo cliente completa e compreensível sem suporte manual; recursos anunciados correspondem aos habilitados.

### F9 — candidata, migração e piloto

- CI completa, imagem única, migração da cópia sintética/anonimizada autorizada, restore/rollback e smoke.
- Piloto com empresas reais somente após autorização, limite inicial e responsável definidos.
- Observar pelo menos 7 dias, registrando consumo, falhas e suporte; corrigir bloqueadores antes da expansão.
- Gate: todos os critérios da seção 19 aprovados, evidências reais e decisão explícita para release/merge/deploy.

Dependências: F1→F2→F3; F4 depende de F1/F2; F5 depende de F1/F2 e gate Meta; F6 depende de F5; F7 depende de F3; F8 integra F4/F6/F7; F9 fecha tudo. Não há autorização para agentes paralelos implícita nessa dependência.

## 17. Matriz de validação

| ID | Cenário obrigatório | Evidência de aceite |
|---|---|---|
| T01 | Cadastro repetido/concorrente, e-mail duplicado, falha de auditoria | Uma identidade/empresa esperada; rollback completo |
| T02 | Verificação/reset expirado, consumido, replay e scanner GET | Sem login/troca indevida; consumo único |
| T03 | MFA/recovery e reset de senha | Sem bypass MFA; códigos únicos; sessões revogadas |
| T04 | A acessa tenant B por URL/body/ID/cache/mídia/SSE/exportação | Zero dados cruzados, inclusive com role real do banco |
| T05 | Remover vínculo, operador e último proprietário | Acesso cortado e propriedade preservada |
| T06 | Falha de e-mail, retry, bounce e reenvio | Sem segredo em log, retentativa limitada e estado correto |
| T07 | Checkout duplicado, webhook inválido/fora de ordem/perdido | Ledger/assinatura única e reconciliação correta |
| T08 | Último crédito em concorrência, retry/timeout IA | Sem excedente não autorizado nem débito duplicado |
| T09 | OAuth/QR expirado, state trocado, número já vinculado | Conexão recusada sem afetar outro tenant |
| T10 | Webhook repetido, eco, histórico e reconexão | Sem loop/duplicação/resposta a histórico |
| T11 | Pausa durante geração/envio e assunção humana simultânea | Sem despacho novo após barreira; em voo documentado |
| T12 | Upload malformado, URL interna, prompt injection, revisão falha | Sem SSRF/execução/vazamento; versão anterior preservada |
| T13 | Exclusão/exportação/restore de dados | Escopo correto; tombstones respeitados; índices removidos |
| T14 | Migração v1.10.6, rollback e tenant legado | Histórico/configuração/PIX/Sheets preservados |
| T15 | API/worker reiniciados, Redis perdido, fornecedor indisponível | Outbox recuperável sem envio/cobrança duplicada |
| T16 | Navegação mobile/teclado, troca de empresa e sessão expirada | Sem dados antigos na tela; retomada e mensagens claras |
| T17 | Carga multitenant e tarefas de ingestão simultâneas | Targets medidos; atendimento não monopolizado por tenant |

Executar testes unitários de domínio, contratos HTTP, integrações reais PostgreSQL/Redis e E2E de navegador. `npm test` sozinho não comprova integrações: habilitar `RUN_POSTGRES_INTEGRATION=true` e `RUN_REDIS_INTEGRATION=true` contra ambiente sintético. A carga atual em memória não prova capacidade de VPS. Não executar suites destrutivas em produção.

Estender regressões existentes: `auth-service`, `postgres-auth-repository`, `admin-service`, `onboarding-*`, `ai-multitenant`, `meta-*`, `delivery-hardening`, `private-media`, `worker-*`, `phase11-hardening`, `capitao-mor-*`, `google-sheets-runtime` e `payment-resolver`. Testes novos devem verificar comportamento/ataques, não apenas repetir implementação.

Evidência por execução: commit, versão, image ID, ambiente, timestamps, resultado, skips com motivo e limitações. Não inserir tokens/dados reais em fixtures, snapshots ou relatório.

## 18. Release, compatibilidade e rollback

Atualização documental atual: patch 1.10.7. Incrementos funcionais compatíveis recebem minor/patch segundo impacto; quando o novo contrato público/RBAC e migração da oferta estiverem prontos para homologação, preparar `2.0.0-rc.N`. Não marcar 2.0.0 por apenas criar a tela de login. Alterações de contrato devem constar no changelog com procedimento de migração.

`main` é a referência estável; desenvolvimento em `dev`. A divergência atual é só de histórico do merge, não exige reset/force push. Sincronizar ancestrais posteriormente se necessário com merge normal e autorização. A CI atual dispara push de `dev` e PR; planejar validação de `main`/tags de release e scans também de `portal/`/`panel/`.

CI deve executar lockfile, auditoria de dependências, sintaxe, unitários, integração sintética, E2E, build e exportação de artefato. Mesma imagem para API/worker/migrador/monitor; assets do portal correspondem ao mesmo commit. Registrar digest e checksum, promover sem rebuild.

Rollout expand/backfill/activate: primeiro estruturas aditivas e flags off; depois migração de dados; depois tenants de teste e piloto; finalmente abertura gradual. Não remover rotas/migrações/credenciais antigas enquanto runtime anterior precisar delas.

Rollback exige matriz de compatibilidade de schema/configuração/job por versão. Flags off não bastam quando há efeitos externos: reconciliar assinatura, mensagens, reservas e autorizações. Só promover imagem antiga se ela compreender os registros/jobs ativos; caso contrário, hotfix compatível com automação pausada. Restore de dados requer aprovação específica e estimativa de perda; nunca restaurar banco às cegas após cobrança/envio real.

## 19. Definição de pronto da 2.0.0

- [ ] Cadastro/verificação/login/recuperação/MFA funcionam com e-mail real e sem assistência técnica.
- [ ] Cliente cria empresa, convida equipe e só acessa seus dados; T01–T05 aprovados em PostgreSQL real.
- [ ] Plano é contratado e reconhecido pelo servidor; quotas, cancelamento e reconciliação comprovados.
- [ ] Questionário gera configuração válida; prévia e publicação funcionam sem segredo/ID técnico.
- [ ] Conector escolhido entrega a jornada prometida; elegibilidade/limites de QR e histórico claramente exibidos.
- [ ] Inbox recebe/envia, mostra estados, assume atendimento e pausa automação com comportamento concorrente testado.
- [ ] Conhecimento de texto/PDF/URL funciona, isola fontes e permite atualizar/excluir.
- [ ] Tenant legado continua operando com configurações preservadas e entitlement explícito.
- [ ] Exportação/exclusão, textos, custos, suporte e responsabilidades aprovados.
- [ ] CI, carga acordada, restore, rollback e alertas passaram; credenciais reais protegidas.
- [ ] Piloto de pelo menos sete dias sem bloqueadores críticos; autorização para release e publicação registrada.

## 20. Decisões externas pendentes

Responsável por aprovar decisões comerciais e operacionais: titular do WAIA; não atribuir aceite a terceiros sem confirmação. Responsável técnico da fase registra alternativas, escolha, data, custo/limites e evidência. A lista abaixo pode ser fechada gradualmente; F1 local não espera a aprovação Meta nem a contratação da cobrança.

| Decisão | Proposta inicial | Gate que bloqueia |
|---|---|---|
| Provedor e domínio de e-mail | Um provedor transacional, integração por adapter | F1 real/F8 pública |
| Domínio do site/portal/admin | Portal same-origin com API; admin protegido | F8 |
| WhatsApp QR | Oficial/coexistência primeiro; validar conta e requisitos | F5 e promessa comercial |
| Meta direto ou parceiro | Comparar habilitação, operação e custo | F5 |
| Provedor de cobrança | Um, checkout hospedado e sandbox | F4 |
| Planos/preços/trial | Mensal por empresa, limites explícitos | F4/F8 |
| Modelo/índice de conhecimento | OpenAI mantida; retriever escolhido por prova | F3/F7 |
| Propriedade de empresas legadas | Operador identifica proprietário legítimo | Migração F1/F9 |
| Entitlement legado e prazo | Override auditado sem cobrar automaticamente | F4 |
| Retenção, termos e operador comercial | Revisão específica para SaaS público | F8 |
| Suporte, incidentes, RPO/RTO | Revalidar 24h/4h e capacidade do operador | F9 |

Decisão pendente não autoriza inventar credenciais, preço, elegibilidade ou aceite. Implementar contratos internos e testes que independam dela; manter bloqueada apenas a operação dependente.

## 21. Referências e manutenção do plano

Pesquisa de referência em 16/09/2026: [Atendente.AI](https://www.atendente.ai/) e [planos](https://www.atendente.ai/precos). Inspeção pública, sem conta criada e sem auditoria interna do concorrente. Seus recursos são referência de experiência, não especificação técnica do WAIA.

Fontes técnicas estão vinculadas nas seções correspondentes. Revalidar docs, permissões, preços, modelos, SDKs e políticas na fase de implementação; páginas e serviços mudam. A arquitetura, prazos de token, limites e targets deste documento são propostas do WAIA, não garantias de fornecedores.

Quando uma decisão mudar: atualizar a seção única responsável, registrar motivo/impacto no relatório e ajustar o gate. Não voltar a criar cronologias repetidas em múltiplos arquivos. Não remover runbooks de recuperação nem registros de aceite histórico durante limpeza documental.
