# M2 — administração geral de acessos

24/10/2026, America/Sao_Paulo. Branch `new`. M1 commitada localmente em
**88f7b21 / 1.24.0** após validar o snapshot selecionado (49 arquivos,
600 pass/22 skips e 28 integrações). M2 autorizada e concluída como **1.25.0**;
commit local no fechamento, conforme padrão registrado em AGENTS. Sem push,
promoção ou deploy. M3 depende de nova autorização.

## Entrega

- Área **Acessos** global e **Usuários com acesso** por empresa, com busca,
  filtro, paginação e detalhe. Identidade, ativação, vínculo e entrega têm estados
  separados. Resumo e confirmação antecedem as mudanças críticas.
- Criar/reutilizar identidade com zero, uma ou várias empresas. E-mail existente
  preserva nome, senha e MFA; não atribui papel global nem owner. Novos vínculos
  usam papel interno operador e capacidades explícitas do catálogo core.
  Atualizações preservam permissões técnicas legadas ocultas e papel existente.
- Suspensão global, suspensão/remoção de vínculo, ativação/reenvio, recuperação
  assistida e revogação de sessões. Proprietário legado não pode ter seu vínculo
  suspenso/removido por esse fluxo: 409 exige resolução administrativa explícita.
  Identidade/empresa/histórico não são excluídos ao remover um vínculo.
- API `/api/admin/access-users` com DTO estrito, sessão admin global e MFA,
  perímetro administrativo existente e CSRF. Mutações exigem reautenticação
  recente (10 minutos), idempotência e versão. O servidor revalida o ator no banco.
  Reautenticação por `/api/admin/auth/reauthenticate` exige senha/fator, origem
  exata e CSRF; a UI repete a mesma intenção/chave após confirmar.
- Transações serializam operações administrativas antes de adquirir locks de
  identidade/vínculo; auditoria e ledger de idempotência entram na mesma transação.
  Falha de auditoria reverte identidade, vínculos, token/outbox e pedido. Conflito
  de versão gera 409; replay da mesma chave não duplica acesso, vínculo ou e-mail.
- CRUD legado de escrita de users/memberships fechado no HTTP e serviço. Leituras
  administrativas existentes permanecem; não há rota de exclusão física da
  identidade ou concessão de administrador global por esse cadastro.

`version` cobre estado administrativo/vínculos/ativação. `security_version`
continua responsável por senha, MFA, reset e invalidação de sessões. O DTO não
expõe hash, MFA envelope, token, digest, URL de ativação ou referência de cofre.

## Ativação e entrega

Migração aditiva **028_administrative_access_provisioning.sql**, sem editar
001–027: `activation_required`, `access_version`, propósito de token `activate`,
ledger administrativo com RLS forçada e guard de sessão não ativada.

Usuário novo recebe hash aleatório desconhecido e flag de ativação. Login,
sessão e reset público não contornam essa flag. Bloquear e reativar uma conta
pendente não a ativa. POST `/api/account/v1/activate` consome somente token do
propósito correto, único e não expirado, define senha/verificação e remove a flag
atomicamente; não cria vínculo, empresa ou papel. GET de scanner não o consome.

Reenvio invalida tokens e outbox anteriores. Material de entrega fica cifrado;
digest no banco. Recuperação administrativa exige confirmação explícita de
titularidade pelo operador, reautenticação e auditoria; a caixa de confirmação
registra essa declaração, não é uma verificação automática de identidade. MFA
não é removido por recuperação. Reenvios e tentativas têm limites.

`sent` é projetado como **accepted**, sem afirmar recebimento/leitura. O preview
usa somente transporte fake e destinatários reservados `.example`/`.invalid`.
Não houve e-mail real. Provedor/domínio e entrega real continuam gates de M9.
A tela de ativação do cliente pertence à M3; a API de ativação foi testada aqui.

## Evidências

- Node 22.23.2: **630 testes, 607 aprovados, 23 skips opt-in, zero falhas**.
- Snapshot exato selecionado para o commit: **43 arquivos**, revalidado com os
  mesmos 607 pass/23 skips e 59 integrações. Sintaxe de **302 arquivos** aprovada;
  auditoria final sem vulnerabilidades. Build de runtime conferido, com painel,
  API e schema presentes e testes/segredos ausentes. Imagem local:
  `sha256:825c27b8373dbb7cebbcfee427c399f16d5f4b0df278111fd4c4f0d9c1898781`.
  Mensagem de commit: `v1.25.0 - adiciona administração geral de acessos na M2`.
- PostgreSQL/Redis reais: **59 aprovados, zero skips/falhas**; inclui 30 subtestes
  M2 e seus pais, mais as regressões selecionadas de M1/Redis.
- Banco vazio **28 migrações** e upgrade histórico 25 → 023+027+028 equivalentes,
  checksums/ledger válidos, reaplicação zero, role restrita e pool sem resíduo.
  Snapshot: `80b5a3ea0b6602f7a2f1d2654d0dd83aea65c988a8706123b635b932e5b00916`.
- Browser local: login administrativo/MFA; cadastro de duas empresas fictícias
  pelo painel; acessos com zero/uma/duas empresas; reutilização sem sobrescrever
  nome/vínculos; edição de capacidades; filtro por empresa e entrega sanitizada.
  Reautenticação vencida pediu senha/fator e retomou o reenvio no mesmo diálogo.
  Evidência visual: `.tmp/m2-accessos.png`. Correção da transição assíncrona
  entre salvar/listar/detalhar retestada no navegador.
- Revisões independentes de backend, autorização, ativação e UI por subagentes;
  testes reais executados pelo principal. Sem bloqueador alto pendente. CI
  preparada, sem execução remota nesta rodada.

Evidências locais: `.tmp/m0/m2-{final-baseline.tap,final-integrations.log,fresh-proof.log,build.log}`.
Snapshot selecionado: `m2-commit-baseline.tap`, `m2-commit-integrations.log`,
`m2-commit-build.log` e `m2-runtime-build.log`, no mesmo diretório.
Não versionar `.tmp/`, credenciais ou volumes. As fixtures dos testes técnicos
são removidas por UUID; o dataset criado pelo painel é preservado no preview.

## Preview e continuidade

Após preparar a infraestrutura v2 da M0, use no checkout `new`:

```powershell
rtk proxy node scripts/prepare-v2-preview.mjs
```

O script reutiliza a imagem local `waia:v2-test-local`; construa o target
`validation` do Dockerfile após mudanças. Bootstrap único do administrador
sintético em `waia_v2_app`, sem importar identidades. Credenciais, pepper e chave
próprios permanecem em `.secrets/`, ignorados no Git/build. Não há configuração
por cliente nesses scripts; os cadastros são feitos pelo painel.

Painel: **http://127.0.0.1:5035/panel/**. API somente na rede interna v2, sem
egress; proxy sem credenciais, com upstream fixo, publica apenas loopback. A
allowlist administrativa aceita somente loopback e o IP interno desse proxy.
O proxy tem uma interface de ingresso e uma interna; a API não recebe essa
interface de ingresso. PostgreSQL/Redis/mídia dedicados preservados, sem worker
de atendimento. Há apenas bombeamento de e-mail fake. Readiness completo do
worker e integrações externas não são aceites deste preview.

O dataset de browser contém Ateliê M2 Demo, Oficina M2 Demo e três identidades
fictícias com 0/1/2 vínculos, todas ainda pendentes de ativação. Não é o dataset
completo nem o workspace cliente da M3. O administrador de bootstrap não possui
vínculos cliente automáticos. A sessão de demonstração foi deixada no painel.

Para repetir testes sem tocar no dataset do preview:

```powershell
rtk proxy docker compose --project-name waia-test --env-file .secrets/v2-test.env --file infra/compose.v2-test.yml run --rm --no-deps v2-check node scripts/validate-v2-environment.mjs --tests-only
```

Esse modo verifica somente bases técnicas, Redis/mídia/egress; não migra nem
apaga `waia_v2_app`. O modo padrão mantém a recusa de base de desenvolvimento
com dados, evitando apagar o dataset para satisfazer um alvo vazio. Não executar
seed/restore nem remover volumes. Para parar apenas o preview:

```powershell
rtk proxy docker stop waia-test-v2-preview-proxy waia-test-v2-preview
```

Último administrador protegido contra bloqueio/rebaixamento/soft delete. DELETE
físico de identidade não é oferecido nem pelo novo fluxo nem pelo CRUD legado.
Esse limite de operação do banco não equivale a autorizar exclusão por SQL.
M3–M10, mobile completo, e-mail real e produção permanecem nas fases respectivas.
