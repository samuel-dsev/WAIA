# M3 — login e navegação por empresa

24/10/2026, America/Sao_Paulo. Branch `new`, base **c59a905 / 1.25.0**.
M3 autorizada pelo titular e entregue em **1.26.0**, com commit local no
fechamento conforme AGENTS. Sem push, promoção, deploy ou avanço para M4.

## Entrega e uso

A raiz abre `/portal/` quando contas estão habilitadas. O cliente entra com o
acesso criado pela administração. A lista **Minhas empresas** é obrigatória
mesmo com um único vínculo; sem vínculos, orienta solicitar liberação à WAIA.
Cada cartão abre a visão geral com nome, estado e permissões de atendimento.
O nome permanece no cabeçalho; **Voltar às empresas**, **Perfil**, **Segurança
e sessões** e **Sair** permitem continuar a jornada. Este workspace apresenta
o resumo existente; o editor, o salvamento e a publicação pertencem a M4/M5.

Cadastro público, criação de empresa, equipe, convites e propriedade saíram
do portal. Seus bloqueios no servidor continuam sendo os da M1. Login por
cookie, ativação/definição de senha, recuperação, MFA/códigos e segurança
pessoal reutilizam as APIs existentes. Nenhuma rota administrativa é chamada
pelo portal. Conteúdo de empresa e usuário é renderizado com `textContent`.

O link `/portal/#/companies/<uuid>` aceita somente a rota interna reconhecida.
Sem sessão, mostra login sem nome da empresa e retoma o destino após autenticar.
O servidor revalida sessão, vínculo, estado e `attendance.read`; empresa alheia
produz 404 neutro. Links de ativação/reset/verificação são retirados da URL assim
que lidos e permanecem somente na memória da página até uso/saída.

Trocar contexto limpa dados e cancela requisições. A geração da navegação é
conferida após cabeçalhos, corpo e falhas de rede: uma resposta ou 401 antigo
não substitui a empresa/sessão atual. Logout e expiração apagam lista, workspace,
perfil e segredos. Assets e APIs usam `no-store`; sessão não usa Web Storage.
Restaurar a página ou voltar de outra aba revalida o acesso. Troca de identidade
ou cookie descarta o estado da sessão anterior. Perfil não salvo exige decisão
antes de navegar e é preservado ao alternar abas. Desafio MFA e códigos ainda
não confirmados sobrevivem à alternância para o autenticador/gerenciador.

## Dataset e ambiente

No alvo v2 já isolado de `waia-test`, o roteiro de browser usa o **painel** para
cadastrar/reutilizar:

| Empresa/identidade | Cenário |
|---|---|
| Aurora Serviços Demo | Ana e Bia; Ana consulta/edita, Bia somente consulta |
| Horizonte Comércio Demo | Segundo vínculo de Ana |
| Vale Atendimento Demo | Somente Caio |
| semempresa.demo@waia.example | Acesso ativo sem vínculo |
| suspenso.demo@waia.example | Suspensão global pelo painel após abrir sessão |

Dataset anterior da M2 preservado; nenhuma importação, seed ou migração nova.
As senhas são definidas pela **tela de ativação**, com material sintético
guardado em `.secrets/` ignorado. Clientes não são configurados por SQL, código,
variáveis de ambiente ou reinício. O bootstrap é somente o administrador global
preexistente do ambiente de desenvolvimento.

Portal: **http://127.0.0.1:5035/portal/**.
Painel: **http://127.0.0.1:5035/panel/**.
API apenas na rede interna v2; proxy publica loopback. PostgreSQL/role, Redis e
mídia dedicados, egress bloqueado e nenhum worker de atendimento. O ambiente
anterior, seus volumes e a VPS permanecem preservados.

O script de preview, exclusivo de desenvolvimento, grava a caixa fake em
`/tmp/waia-v2-fake-inbox.json` no container, modo `0600`, para o teste de browser
consumir links sem imprimi-los. Não existe endpoint de leitura. Transporte fake
recusa destinatários reais; a caixa é efêmera e some ao recriar o preview.
O entrypoint de produção não executa esse script. Nenhuma entrega real de
e-mail, WhatsApp/OpenAI ou publicação de atendimento foi comprovada nesta M3.

## Reproduzir

Após preparar a infraestrutura M0/M2 sem apagar volumes:

```powershell
rtk proxy docker build --target validation -t waia:v2-test-local .
rtk proxy node scripts/prepare-v2-preview.mjs
rtk proxy docker run --rm --network none waia:v2-test-local npm test
rtk proxy docker run --rm --network none waia:v2-test-local node scripts/check-syntax.mjs
rtk proxy docker compose --project-name waia-test --env-file .secrets/v2-test.env --file infra/compose.v2-test.yml run --rm --no-deps v2-check node scripts/validate-v2-environment.mjs --tests-only
```

Browser opt-in: **Playwright disponível no runtime de dependências do Codex**,
com Microsoft Edge instalado (`channel: msedge`). Nenhuma dependência nova do
produto. Se `playwright` estiver resolvível no Node:

```powershell
rtk proxy node scripts/m3-browser-check.mjs
```

Ou passar como primeiro argumento o caminho absoluto de `playwright/index.mjs`
fornecido por `load_workspace_dependencies`. O roteiro exige arquivos privados
de bootstrap/MFA do preview e preserva as senhas sintéticas em
`.secrets/v2-m3-users.json`; não remover esses arquivos para repetir o teste.
Gerencia somente as identidades/empresas fictícias acima, usando o painel para
as alterações. Repetições respeitam `Retry-After` do limitador, podendo aguardar
até quinze minutos; não desabilitam a proteção. Ao final, o usuário sintético
de suspensão fica bloqueado; nova rodada o reativa explicitamente pelo painel.

## Evidências e revisão

Snapshot selecionado: **16 arquivos**, Node 22 **639 casos, 616 aprovados,
23 skips opt-in e zero falhas**; **59 integrações PostgreSQL/Redis aprovadas**,
sem skips/falhas. Sintaxe de **306 arquivos**, auditoria sem vulnerabilidades,
64 links documentais e versão/package/lock conferidos. Schema continua em 28
migrações, sem mudança de banco nesta fase. Cenários de browser: 0/1/2 vínculos, ativação,
recuperação, MFA, deep link, acesso cruzado, duas respostas atrasadas (200/401),
revogação/suspensão, logout, confirmação de descarte, retomada de aba, foco no
título e viewport móvel/desktop. A alternância de visibilidade é reproduzida por
eventos controlados no browser; não é um ensaio em telefone físico/autenticador.

Build de runtime verificado sem testes, `.tmp`, `.secrets`, Git ou o módulo
anterior de equipe; imagem local
`sha256:e4fca62d43525320ce96087ab97e47ac240fdc2cf97f73eea2b915ef47ef0d32`.
Mensagem do commit: `v1.26.0 - adiciona login e navegação multiempresas na M3`.

Evidências locais sanitizadas em `.tmp/m3/`: `browser-proof.json`,
`browser-final.log` (11 grupos aprovados), `workspace.png`, `mobile.png`,
`selected-{baseline.tap,integrations.log,syntax.log,build.log}`, auditoria e
`runtime-proof.log`. O browser final usou o snapshot selecionado.
Não versionar `.tmp/`, links, códigos, senhas, caixas fake ou volumes.

Revisão independente de segurança e testes identificou e resolveu navegação
duplicada, perda de edição ao retornar à aba, preservação de MFA/códigos,
respostas/erros antigos, estados `ativa`/`suspensa`, confirmação de links e troca
de sessão entre abas. O principal inspecionou as capturas desktop/390px.
Sem bloqueador alto pendente. M4 e gates públicos/externos de M8–M10 dependem
das respectivas autorizações.
