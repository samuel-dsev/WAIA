# Implementações finais — produção e testes com empresas reais

Atualizado em 4 de setembro de 2026 a partir da versão `1.8.3`, commit `739ed4d`, após revisão do `PLAN.md`, `RELATORIO.md`, código, migrações, testes, Docker Compose, documentação operacional e contratos das integrações.

## 1. Objetivo deste plano

Conduzir o WAIA do estado atual, validado com dados sintéticos, até uma operação real e controlada com empresas reais, preservando:

- isolamento estrito entre empresas;
- onboarding e operação pelo painel;
- segredos fora do código, logs, Redis e configurações publicadas;
- PIX, pedidos, comprovantes e demais transações em fluxos determinísticos;
- possibilidade de suspensão imediata de uma empresa sem interromper as demais;
- rollback verificável e recuperação dos dados;
- autorizações separadas para infraestrutura, credenciais, ativação de empresas, tráfego real, merge em `main` e implantação.

Este documento é um plano. Ele não autoriza por si só deploy, alteração de DNS, uso de credenciais reais, cadastro de empresa real, ativação de número, envio de mensagens, movimentação financeira ou mudança na branch `main`.

## 2. Parecer executivo sobre o estado atual

### Resultado

O sistema está de acordo com o objetivo funcional definido para as Fases 0 a 10: uma empresa pode ser criada, configurada, simulada, publicada, ativada, operada e suspensa pelo painel sem código, SQL, seed, `.env`, reinício ou deploy por tenant.

O isolamento arquitetural também está no formato esperado: PostgreSQL como fonte de verdade, Redis para fila/locks/limites, worker assíncrono, outbox, RLS forçada, configuração versionada, cofre cifrado e resolução de Meta/OpenAI/Google por tenant.

Entretanto, o sistema ainda não deve receber tráfego público de clientes reais. O que foi provado até agora é a prontidão funcional e técnica em ambiente controlado. A prontidão operacional de produção depende das correções e dos ensaios deste plano.

Decisão atual recomendada:

- **GO** para correções finais, homologação limpa e piloto controlado;
- **NO-GO** para abertura pública imediata ou migração de todas as empresas;
- **NO-GO** para testes com dados sensíveis, pagamentos reais ou clientes não informados antes dos gates jurídicos, operacionais e de recuperação.

### Evidência atual

- `npm test`, executado nesta revisão: 405 testes, 393 aprovados, 0 falhas e 12 integrações opt-in ignoradas sem as variáveis de infraestrutura.
- A Fase 10 já executou PostgreSQL e Redis reais, Docker Compose, build, RLS, inspeção de segredos, carga sintética, E2E persistente e navegação visual.
- O fluxo sintético multiempresa comprovou que Capitão Mor e Empresa Beta não cruzam configuração, mensagens, segredos, IDs, fila ou estado.
- `HEAD` e `origin/dev` estavam sincronizados em `739ed4d` no início desta análise; `main` não contém a atualização de onboarding.
- `npm audit --omit=dev` encontrou uma vulnerabilidade moderada transitiva em `qs@6.15.3`, com correção disponível.
- Nenhuma chamada externa real à Meta, OpenAI ou Google fez parte do aceite anterior.

## 3. O que já está pronto

| Área | Estado | Evidência principal |
|---|---|---|
| Onboarding multiempresa | Pronto em ambiente controlado | Wizard de dez etapas, draft, retomada, readiness, preflight, publicação e ativação |
| Configuração sem deploy por tenant | Pronto | Revisões imutáveis e runtime versionado |
| Isolamento por tenant | Pronto e testado | Filtros redundantes, FKs compostas, `ENABLE/FORCE RLS` e testes multiempresa |
| Segredos | Pronto no núcleo | Cofre AES-256-GCM, AAD por tenant/credencial/finalidade, máscaras e rotação |
| Webhooks Meta | Pronto no núcleo | Assinatura nos bytes brutos, callback dinâmico por aplicativo e endpoint legado preservado |
| Processamento assíncrono | Pronto | Outbox PostgreSQL, BullMQ, locks, retries, dead-letter e shutdown gracioso |
| Atendimento humano | Pronto | Assunção de conversa, idempotência, outbox e auditoria transacional |
| IA por tenant | Pronto no núcleo | Responses API, `store: false`, quotas, custo, fallback e contexto allowlisted |
| Google Sheets | Pronto no núcleo | Configuração por tenant, importação, exportação idempotente e último snapshot válido |
| Mídia privada | Pronto no núcleo | MIME/tamanho/host controlados, SHA-256, volume privado e retenção |
| Operação no painel | Pronto funcionalmente | Empresas, equipe, conversas, falhas, métricas administrativas e auditoria |
| Produção real | Ainda não comprovada | Faltam provedores reais, infraestrutura definitiva, alertas e recuperação ensaiada |

## 4. Lacunas e bloqueadores encontrados

### P0 — bloquear abertura pública até resolver

1. **Páginas legais ainda são específicas do Capitão Mor.**
   - `public/privacy.html` e `public/data-deletion.html` usam nome e contato do Capitão Mor.
   - Para uma plataforma multiempresa, é necessário definir controlador, operador, contato de privacidade, subprocessadores, retenções, atendimento aos titulares e responsabilidades contratuais.
   - A redação final precisa ser validada pelo responsável jurídico; o código não substitui essa análise.

2. **Recuperação de desastre não está completa nem ensaiada.**
   - Há scripts para PostgreSQL, mas não há evidência de restauração periódica em ambiente isolado.
   - Os scripts usam `POSTGRES_USER=waia` como default, enquanto o Compose usa `waia_owner`.
   - O plano atual não cobre backup externo cifrado do volume de mídias nem custódia independente do `MASTER_KEYRING`.
   - Perder banco, mídias ou todas as versões do keyring pode tornar dados ou credenciais irrecuperáveis.

3. **Observabilidade externa e alertas não estão fechados.**
   - A API implementa `/metrics`, mas o Caddy do domínio da API não encaminha essa rota, apesar de o README documentar a URL pública.
   - É necessário escolher entre coletor interno na rede Docker ou rota externa protegida; a implementação e a documentação devem refletir a mesma decisão.
   - Não foi localizado um destino real para alertas operacionais ou de quota; o `alertSink` de IA é opcional e não está ligado a um canal de produção.

4. **Ciclo de vida de acesso administrativo é insuficiente para vários clientes reais.**
   - Existem login, logout, sessões, CSRF, rate limit e scrypt.
   - Não foi localizada jornada de convite, troca voluntária de senha, recuperação de senha ou MFA ativa. A migração possui colunas de MFA, mas o recurso não está operacional.
   - Para o piloto, o mínimo aceitável é credencial única por pessoa, senha forte entregue por canal seguro e painel restrito por VPN ou allowlist. Antes de expansão, implementar convite/definição de senha e MFA para administradores.

5. **Dependência transitiva com correção disponível.**
   - O audit atual aponta `qs@6.15.3`, trazido por `express@5.2.1`/`body-parser@2.3.0`, com severidade moderada e correção disponível.
   - Atualizar o lockfile de forma controlada e repetir toda a matriz antes da release candidate.

6. **Entrega de produção ainda não é imutável nem automatizada.**
   - Não há workflow de CI versionado.
   - O Compose constrói API e worker diretamente do checkout; não há imagem publicada por digest, assinatura, SBOM ou promoção explícita do mesmo artefato entre homologação e produção.
   - Para um primeiro piloto é possível fazer deploy manual controlado, mas o commit, a imagem, o backup, os comandos e a reversão precisam ser registrados.

7. **Contratos externos reais ainda não foram validados.**
   - `WHATSAPP_API_VERSION` está configurada como `v26.0`; a versão aceita deve ser confirmada no painel e na documentação da Meta no dia do provisionamento.
   - O modelo padrão da OpenAI está em alias (`gpt-4.1-mini`); a OpenAI recomenda snapshots para comportamento estável em produção.
   - Token Meta permanente, permissões, WABA, inscrição de webhook, limites de conta OpenAI e conta de serviço Google ainda não foram exercitados pelo runtime real.

### P1 — resolver antes de ampliar além do piloto

1. Atualizar README e relatório, que ainda contêm números históricos e uma referência antiga do `origin/dev`.
2. Criar testes automatizados dos scripts de backup/restore e do roteamento escolhido para métricas.
3. Registrar `x-request-id` da OpenAI e enviar um `X-Client-Request-Id` correlacionado, sem registrar conteúdo ou segredo.
4. Fixar o snapshot do modelo após avaliação e manter catálogo de preços revisável sem deploy por tenant.
5. Centralizar logs e criar alertas para API/worker indisponíveis, fila crescente, dead-letter, falha de backup, erro de webhook e aproximação de quota.
6. Definir limites de CPU, memória, PIDs e disco; testar pressão de volume e rotação de logs na VPS real.
7. Remover ou mover para tooling o proxy temporário versionado em `.tmp/whatsapp-test`.
8. Definir a retirada futura do endpoint legado `/webhook` após migrar o Capitão Mor para callback dinâmico.
9. Generalizar a documentação de integrações, hoje centrada no Capitão Mor, para o procedimento de qualquer empresa.

## 5. Princípios para testes reais

1. **Produção real não significa risco irrestrito.** O primeiro teste usa infraestrutura e credenciais reais, mas somente participantes informados, números autorizados e dados mínimos.
2. **Nenhum segredo será enviado em chat, issue, commit, log ou captura.** Segredos de infraestrutura entram diretamente no gerenciador seguro do servidor; segredos de tenant entram pelo cofre do painel.
3. **Uma empresa por vez.** A primeira empresa só é ativada após o ambiente passar nos gates. A segunda empresa comprova isolamento real antes da abertura geral.
4. **Sem pagamento real no primeiro canário.** PIX pode ser exibido e o comprovante pode usar artefato controlado. Qualquer transferência real exige autorização separada, valor mínimo acordado e procedimento de conciliação/estorno.
5. **IA não decide transações.** Compra, PIX, comprovante, pedido, agendamento crítico e ações administrativas continuam determinísticos.
6. **Rollback por camadas.** Primeiro suspender o tenant ou integração; depois reverter a aplicação; restaurar banco apenas quando necessário e após confirmar o alvo.
7. **Toda fase termina em gate.** Sem evidência registrada, a fase seguinte não começa.

## 6. Decisões e insumos que dependem do responsável pelo projeto

| Decisão ou insumo | Necessário antes de | Observação |
|---|---|---|
| VPS/provedor, região, sistema operacional e capacidade | Fase 13 | Definir também acesso administrativo e responsável por incidentes |
| Domínios definitivos de API e painel | Fase 13 | DNS deve apontar somente quando o ambiente estiver preparado |
| RPO e RTO | Fase 11 | Sugestão inicial para piloto: RPO de 24 h e RTO de 4 h, sujeitos a aceite |
| Primeiro negócio real e responsável | Fase 14 | Preferir operação de menor risco e equipe disponível durante o canário |
| Segundo negócio real | Fase 15 | Deve possuir número e configuração próprios para provar isolamento |
| Modelo de aplicativos Meta | Fase 12 | Aplicativo compartilhado da plataforma ou aplicativo próprio por empresa |
| WABA, número e token de usuário de sistema | Fase 14 | Provisionamento é externo ao WAIA |
| Chave OpenAI compartilhada ou por tenant | Fase 12 | Usar projeto de produção separado, orçamento e limites próprios |
| Google Sheets por empresa | Fase 14 | Usar conta de serviço e planilha com acessos mínimos |
| Textos legais e contato de privacidade | Fase 11 | Validar controlador/operador, subprocessadores, retenção e direitos |
| Canal de alertas | Fase 11 | E-mail, mensageria ou plataforma de incidentes com responsável definido |
| Janela de implantação e rollback | Fase 13 | Exigir presença de responsável técnico e da primeira empresa |

Credenciais e dados reais só serão solicitados quando a fase correspondente estiver autorizada. Eles não devem ser colados nesta documentação nem na conversa.

## 7. Roadmap de execução

### Fase 11 — fechar bloqueadores de produção

Objetivo: transformar a versão validada em uma release candidate segura para homologação.

Implementações:

- corrigir o roteamento ou a topologia de coleta de `/metrics` e alinhar README/infra;
- corrigir defaults e proteções dos scripts de backup/restore;
- incluir backup e restauração de `media_data` e procedimento de custódia/recuperação do keyring;
- tornar páginas de privacidade e exclusão adequadas à plataforma e parametrizáveis quando necessário;
- corrigir a vulnerabilidade de `qs` pelo caminho de dependência suportado;
- implementar, ou mitigar formalmente para o piloto, troca/recuperação de senha e MFA;
- ligar alertas operacionais e de quota a um destino real;
- adicionar correlação OpenAI por request ID, snapshot de modelo avaliado e revisão do catálogo de preços;
- atualizar documentação histórica e remover artefatos temporários do caminho de produção;
- definir o procedimento manual reproduzível de build, versionamento e rollback; preferencialmente adicionar CI para testes e imagem imutável.

Validações mínimas:

- suíte integral sem falhas;
- integrações PostgreSQL/Redis reais;
- `npm audit --omit=dev` sem vulnerabilidade corrigível aceita como bloqueadora;
- build limpo sem reutilizar `node_modules` externo;
- teste de métricas pela topologia definitiva;
- login, troca/recuperação de senha e MFA ou mitigação de perímetro comprovada;
- backup de banco e mídia seguido de restauração isolada;
- perda simulada da chave ativa recuperada pelo procedimento documentado;
- páginas legais revisadas e acessíveis por HTTPS.

Gate:

- todos os P0 resolvidos ou aceitos formalmente com mitigação, responsável e prazo;
- nenhuma credencial real usada;
- nova versão, arquivos e resultados apresentados antes do commit.

### Fase 12 — homologação limpa e release candidate

Objetivo: provar que a instalação nasce do zero e que o mesmo artefato pode ser promovido.

Execução:

- criar ambiente de homologação separado de `waia-test` e de produção;
- gerar segredos exclusivamente para homologação;
- instalar PostgreSQL, Redis, API, worker, painel e proxy em volumes vazios;
- executar `db-init`, 20 migrações e criação interativa do primeiro administrador;
- não executar seed de demonstração em produção;
- cadastrar duas empresas sintéticas somente pelo painel;
- executar E2E, reinício, suspensão, backup e restore;
- congelar commit, tag candidata e digest das imagens aprovadas;
- produzir runbook com comandos exatos e resultados esperados.

Gate:

- ambiente reproduzível do zero;
- restore comprovado em ambiente descartável;
- nenhuma alteração manual por tenant fora do painel;
- release candidate identificada de forma imutável;
- autorização explícita para preparar infraestrutura de produção.

### Fase 13 — infraestrutura de produção sem tráfego de clientes

Objetivo: instalar a plataforma definitiva ainda sem conectar números reais.

Status em 7 de setembro de 2026: concluída na versão implantada `1.10.1`/`18c0e14`. A produção permanece sem empresas e sem credenciais Meta, OpenAI ou Google Sheets de tenant. As evidências de imagem, migração, TLS, perímetro, monitor, Discord, backup local/externo, restore e rollback estão consolidadas em `RELATORIO.md` e `docs/OPERACAO_RELEASE.md`.

Execução:

- preparar VPS atualizada, usuário operacional não-root, SSH por chave, firewall e relógio sincronizado;
- publicar somente 80/443; PostgreSQL e Redis permanecem sem porta pública;
- configurar DNS, Caddy/TLS, domínios de API e painel;
- configurar volumes, espaço em disco, limites de recursos e rotação de logs;
- armazenar `.env`/segredos com permissão mínima e backup separado do `MASTER_KEYRING`;
- configurar backup automático cifrado e cópia fora da VPS;
- configurar monitoramento, alertas e checagem externa de disponibilidade;
- implantar exatamente o artefato aprovado da Fase 12;
- criar o administrador inicial por canal seguro;
- executar smoke tests sem tenants reais.

Smoke tests:

- TLS válido e renovação automática verificável;
- `/health/live` e `/health/ready` com HTTP 200;
- painel autenticado e CSRF funcionando;
- PostgreSQL/Redis inacessíveis externamente;
- `/metrics` acessível somente ao coletor autorizado;
- assinatura inválida de webhook rejeitada;
- reinício da VPS/stack preservando volumes e retomando API/worker;
- backup automático concluído e alerta de teste recebido.

Gate:

- ambiente saudável sem tráfego real;
- restore point criado;
- checklist e rollback assinados pelos responsáveis;
- autorização explícita antes de inserir qualquer credencial externa real.

### Fase 14 — integrações externas reais e primeiro canário

Objetivo: validar Meta, OpenAI e Google com credenciais reais, dados controlados e uma única empresa.

Status: não iniciada; depende de autorização explícita separada e dos dados reais enumerados abaixo.

Meta/WhatsApp:

- confirmar Business Portfolio, WABA, aplicativo, número e situação da verificação empresarial;
- confirmar a versão Graph suportada no momento e atualizar `WHATSAPP_API_VERSION` se necessário;
- usar token de usuário de sistema com permissões mínimas necessárias;
- cadastrar App Secret, verify token e access token nos locais corretos, sem expô-los em logs;
- configurar callback dinâmico do tenant e assinar o WABA para eventos de mensagens;
- executar preflight pelo painel;
- enviar mensagem a partir de número de teste autorizado;
- comprovar entrada, ACK, enfileiramento, resposta, status enviado/entregue/lido e deduplicação;
- repetir webhook e status para comprovar idempotência;
- validar mídia permitida e rejeições de MIME/tamanho/assinatura.

OpenAI:

- usar projeto/chave de produção dedicados com orçamento e limites configurados;
- confirmar modelo/snapshot e preço vigente;
- executar avaliação com perguntas públicas representativas e respostas esperadas;
- comprovar `store: false`, timeout, fallback, quota e ausência de PIX, comprovantes e segredos no contexto;
- registrar apenas IDs/códigos sanitizados necessários à operação.

Google Sheets:

- usar conta de serviço com acesso somente à planilha da empresa;
- validar ranges e cabeçalhos em cópia controlada;
- importar eventos e configurações públicas;
- exportar pedido sintético e repetir a operação para comprovar idempotência;
- revogar acesso temporariamente e comprovar preservação do último snapshot e recuperação.

Gate:

- todos os provedores reais saudáveis;
- nenhum dado sensível desnecessário usado;
- zero vazamento em logs, Redis, métricas, revisões e respostas administrativas;
- rollback da credencial e suspensão do tenant testados;
- autorização explícita para cadastrar a primeira empresa real.

### Fase 15 — primeira empresa real pelo painel

Objetivo: comprovar o onboarding completo de uma empresa real sem operação manual de backend.

Execução:

- formalizar responsável, finalidade, bases legais, retenções, horários e canais de suporte;
- cadastrar empresa, identidade, módulos, regras públicas, menu, fluxos, equipe e integrações somente pelo painel;
- inserir segredos diretamente no cofre;
- executar simulador antes de qualquer publicação;
- executar readiness e preflight reais;
- publicar e ativar inicialmente para uma lista controlada de participantes;
- registrar a revisão e o horário exato de ativação;
- acompanhar painel, logs, auditoria, filas, custos e respostas durante a janela acordada.

Matriz funcional do canário:

- saudação e menu;
- texto, botão, lista e paginação;
- pergunta fora do escopo e fallback;
- IA somente para conteúdo público permitido;
- agendamento ou fluxo configurado pela empresa;
- handoff, assunção e resposta humana;
- imagem/PDF controlado, se o caso de uso exigir;
- queda temporária da OpenAI/Google simulada sem interromper funções determinísticas;
- reinício de API e worker com mensagem pendente;
- suspensão e reativação controladas;
- pedido/PIX apenas em modo controlado, sem confirmação automática de pagamento.

Gate:

- nenhuma mensagem perdida ou duplicada com efeito de negócio;
- nenhum cruzamento de tenant;
- equipe real consegue operar sem SQL, `.env`, código ou acesso ao servidor;
- suporte e rollback responderam dentro dos objetivos acordados;
- autorização explícita antes da segunda empresa.

### Fase 16 — segunda empresa real e isolamento em produção

Objetivo: provar o comportamento SaaS com duas empresas reais simultâneas.

Execução:

- repetir o onboarding exclusivamente pelo painel;
- preferir configuração, número, credenciais e responsáveis distintos;
- enviar mensagens simultâneas para as duas empresas;
- validar mesma pessoa/telefone em ambos os tenants, quando permitido e consentido;
- confirmar separação de menus, IA, regras, equipe, mídia, pedidos, agenda, auditoria e custos;
- suspender uma empresa durante o teste e confirmar continuidade da outra;
- rotacionar uma credencial e comprovar que a outra empresa não é afetada.

Gate:

- zero evidência de vazamento ou roteamento incorreto;
- nenhuma dependência de deploy por tenant;
- runbook de onboarding reproduzível por operador autorizado;
- autorização explícita para abertura gradual.

### Fase 17 — abertura gradual e estabilização

Objetivo: sair do canário para tráfego real de forma reversível.

Execução:

- abrir por empresa e por janela, nunca todas de uma vez;
- manter responsáveis técnico e operacional disponíveis;
- observar erros de webhook, ACK, fila, latência, dead-letter, uso de IA, falhas externas, disco e banco;
- revisar diariamente incidentes, mensagens sem resposta, auditoria e solicitações de titulares;
- executar backup e validar artefatos gerados;
- encerrar o período de estabilização somente após volume e duração representativos.

Gate final recomendado:

- pelo menos sete dias consecutivos de operação estável ou janela equivalente acordada;
- nenhum incidente P0/P1 aberto;
- nenhum vazamento, mensagem perdida ou efeito duplicado;
- backup recente e restore drill aprovado;
- custos e capacidade dentro dos limites;
- aceite formal de cada empresa piloto;
- autorização separada para merge em `main`, caso ainda não tenha ocorrido, e para expansão comercial.

## 8. Matriz de testes reais em produção

| Camada | Teste positivo | Teste negativo/falha | Evidência |
|---|---|---|---|
| TLS/DNS | API e painel com certificado válido | host incorreto e HTTP indevido não expõem serviço interno | relatório de smoke e cabeçalhos |
| Autenticação | login, sessão, CSRF e logout | senha inválida, brute force, sessão revogada e tenant adulterado | auditoria sanitizada |
| Webhook Meta | desafio GET e POST assinado | verify token incorreto, assinatura inválida, corpo alterado e número desconhecido | status HTTP e auditoria |
| Mensageria | texto, botão, lista, mídia e status | duplicata, ordem invertida, timeout e 429/5xx | IDs Meta e estados internos, sem conteúdo sensível |
| Worker/fila | processamento e ACK durável | Redis indisponível, restart e lease expirado | outbox, fila e dead-letter |
| Multiempresa | duas empresas simultâneas | IDs repetidos e tentativa de acesso cruzado | consultas e auditoria tenant-scoped |
| OpenAI | resposta pública útil | timeout, quota, prompt injection e chave inválida | uso, custo, request ID e fallback |
| Google Sheets | importação/exportação | permissão revogada, range inválido e duplicata | operação idempotente e snapshot preservado |
| Handoff | assumir e responder | operador errado, conversa fechada e repetição | mensagem/outbox/auditoria atômicas |
| Mídia | JPEG/PNG/WEBP/PDF válido | host, MIME, tamanho e hash divergentes | metadados e arquivo privado |
| Retenção/LGPD | anonimização e exclusão | tentativa fora do tenant ou antes do prazo | relatório e auditoria |
| Backup/restore | restauração de banco e mídia | arquivo corrompido, checksum inválido e alvo errado | restore isolado e tempo medido |
| Capacidade | carga representativa da VPS | fila crescente, disco cheio controlado e provedor lento | métricas e alertas |

## 9. Critérios quantitativos iniciais

Os valores finais devem ser confirmados conforme VPS, volume e horário das empresas. Para o piloto, usar inicialmente:

- ACK do webhook: p95 abaixo de 2 segundos;
- disponibilidade de API/painel no canário: pelo menos 99,5%;
- mensagens com efeito duplicado: zero;
- mensagens perdidas após ACK: zero;
- cruzamento de tenant ou segredo exposto: zero;
- dead-letter sem triagem dentro da janela operacional: zero;
- backup bem-sucedido: diário, com alerta em qualquer falha;
- restore dentro do RTO acordado;
- uso de disco com alerta antes de 70% e ação obrigatória antes de 85%;
- custos da OpenAI abaixo do limite mensal de cada tenant;
- nenhum bloqueador de readiness ignorado para ativar empresa.

## 10. Estratégia de rollback

### Nível 1 — tenant ou integração

- suspender a empresa no painel;
- desativar número/aplicativo ou revogar credencial comprometida;
- manter os demais tenants ativos;
- preservar auditoria e evidências.

### Nível 2 — aplicação

- interromper novas ativações;
- promover o digest/commit anterior validado;
- confirmar compatibilidade das migrações antes de iniciar;
- verificar health, fila e outbox após a reversão.

### Nível 3 — dados

- declarar incidente e congelar escritas quando necessário;
- confirmar banco, volumes e timestamp exatos do alvo;
- validar checksum e cópia do backup;
- restaurar primeiro em ambiente isolado;
- restaurar produção somente com autorização explícita;
- executar `db-init`, migrações compatíveis e verificações de RLS;
- reconciliar mensagens/outbox recebidas após o ponto restaurado.

Nunca usar restore como primeira resposta a uma falha de aplicação. Nunca restaurar sobre produção sem confirmar o alvo e o impacto de perda de dados após o backup.

## 11. Segurança, privacidade e governança

- mapear WAIA, cada empresa, Meta, OpenAI, Google e hospedagem como controlador, operador ou subprocessador conforme o caso;
- manter registro das atividades de tratamento, retenções e acessos;
- definir canal e responsável por solicitações de titulares;
- documentar resposta a incidentes e comunicação aplicável à ANPD e aos titulares;
- conservar registros de incidentes pelo prazo legal aplicável;
- revisar termos e políticas dos provedores antes do tráfego real;
- evitar dados sensíveis nos primeiros testes; quando inevitáveis, exigir avaliação jurídica e controles específicos;
- confirmar a política de retenção da OpenAI aplicável ao projeto. O WAIA já usa `store: false`, mas isso não substitui a avaliação dos controles de retenção da conta;
- nunca enviar comprovantes, PIX, credenciais ou snapshots privados à IA.

## 12. Sequência de autorizações

Cada item exige uma confirmação separada do usuário:

1. iniciar a Fase 11 e alterar código/documentação;
2. aceitar arquivos, validações, versão e mensagem de commit da Fase 11;
3. criar a homologação da Fase 12;
4. preparar a VPS, DNS e certificados da Fase 13;
5. inserir credenciais reais da Meta/OpenAI/Google;
6. vincular e testar um número WhatsApp real;
7. cadastrar a primeira empresa real;
8. publicar e ativar essa empresa;
9. cadastrar e ativar a segunda empresa real;
10. abrir tráfego ao público;
11. executar qualquer pagamento real;
12. fazer merge em `main` e/ou implantação definitiva.

## 13. Funcionalidades relevantes para incrementar depois do caminho crítico

Estas sugestões não devem atrasar o primeiro piloto, salvo quando forem escolhidas como mitigação de um P0:

1. **MFA, convite e recuperação de acesso completos.** Ativar o schema de MFA já existente, adicionar convite com token de uso único, troca obrigatória de senha inicial e recuperação auditada.
2. **Templates WhatsApp e janela de atendimento.** Não foi localizada implementação de mensagens template. Adicionar catálogo/aprovação de templates e bloqueio explícito de mensagens livres fora da janela permitida antes de campanhas ou notificações proativas.
3. **Embedded Signup ou onboarding Meta assistido.** Útil quando a quantidade de empresas tornar o provisionamento manual de WABA/número um gargalo.
4. **Central de alertas.** Notificar falha de backup, fila, dead-letter, integração, expiração/rotação de credencial, disco, quota e ausência de heartbeat.
5. **Direitos do titular pelo painel.** Busca, exportação, anonimização/exclusão e comprovante auditado por tenant.
6. **CI/CD e supply chain.** Testes automáticos, imagem por digest, SBOM, assinatura, scan e promoção do mesmo artefato entre ambientes.
7. **Limites comerciais e cobrança SaaS.** Quotas por plano, consumo por tenant, bloqueios graduais e relatórios de faturamento sem misturar dados operacionais.
8. **Alta disponibilidade.** Réplica/backup gerenciado, object storage para mídia e múltiplos workers quando volume e SLA justificarem.
9. **Painel operacional para templates, consentimento e opt-out.** Necessário antes de marketing ou mensagens iniciadas pela empresa.
10. **Testes de caos e capacidade recorrentes.** Redis indisponível, PostgreSQL lento, disco próximo do limite, reinício abrupto e degradação de provedores.

## 14. Referências externas a reconfirmar durante a execução

- [Meta — coleção oficial WhatsApp Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
- [OpenAI — visão geral da API, rate limits e request IDs](https://developers.openai.com/api/reference/overview)
- [OpenAI — controles e retenção de dados](https://developers.openai.com/api/docs/guides/your-data)
- [OpenAI — GPT-4.1 Mini, preços, snapshots e limites](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
- [ANPD — Regulamento de Comunicação de Incidente de Segurança](https://www.gov.br/anpd/pt-br/assuntos/noticias/anpd-aprova-o-regulamento-de-comunicacao-de-incidente-de-seguranca)
- [Planalto — Lei Geral de Proteção de Dados Pessoais](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm)

As exigências externas são temporais. Versões, permissões, limites, preços, políticas e termos devem ser verificados novamente no início das Fases 13 e 14.

## 15. Critério de conclusão deste plano

O WAIA poderá ser declarado operacional para empresas reais quando:

1. todos os bloqueadores P0 estiverem resolvidos ou formalmente mitigados;
2. instalação limpa, backup e restore estiverem comprovados;
3. infraestrutura de produção estiver monitorada, protegida e reproduzível;
4. Meta, OpenAI e Google tiverem sido testados com credenciais reais e dados controlados;
5. duas empresas reais operarem simultaneamente sem cruzamento;
6. operadores conseguirem atuar exclusivamente pelo painel;
7. nenhuma ação rotineira por tenant exigir `.env`, SQL, seed, código, reinício ou deploy;
8. logs, Redis, métricas, revisões e APIs permanecerem sem segredos;
9. requisitos jurídicos, privacidade, suporte e incidentes tiverem responsáveis definidos;
10. custos, capacidade, RPO, RTO e rollback atenderem aos valores aprovados;
11. cada empresa piloto fornecer aceite;
12. a abertura pública receber autorização explícita.
