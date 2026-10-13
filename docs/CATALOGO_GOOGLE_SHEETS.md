# Catálogo de produtos por Google Sheets — candidata v1.15.0

## Correção do vínculo lógico — candidata v1.15.1

A v1.15.0 foi commitada e publicada com autorização (`4c9e8ad`). Google Sheets e preflight real passaram, e o roteiro/vínculo da ALFATECH foram publicados como configVersion 7. A conferência do runtime revelou que o editor cria IDs lógicos a partir do nome (incluindo UUIDs com sublinhados), enquanto o loader novo aceitava somente UUID/referência física. Assim, o catálogo sincronizado não chegava ao contexto da IA.

A v1.15.1 preparada localmente mantém referências físicas exatas e acrescenta a resolução por tipo para um único vínculo lógico publicado, somente quando há uma única conexão Google Sheets ativa dentro da própria empresa. Conexões ambíguas e UUIDs concretos de outra integração não recebem fallback. A agenda existente continua preservada. Não modifica credenciais, esquema, produtos ou o formato da planilha.

Validação: teste de referência lógica comum e ID gerado pelo editor; referência concreta correta/incorreta; ambiguidade; isolamento dos filtros por empresa; regressão de agenda. Candidata isolada em Node 22: 482 casos, 464 aprovados, 18 skips opt-in, zero falhas. Consulta da correção exercitada em PostgreSQL de produção em transação somente leitura, com saída restrita a status/contagem; não substitui a publicação da correção nem comprova resposta WhatsApp com um produto.

Arquivos da correção: `src/tenants/postgres-config-loader.js`, `test/google-sheets-products.test.js`, `test/versioned-config-loader.test.js`, `package.json`, `package-lock.json`, `PLAN.md`, `RELATORIO.md` e este documento. Mensagem aprovada: `fix: v1.15.1 resolve vínculo lógico do catálogo Google Sheets`. Commit, push de dev e deploy explicitamente autorizados em 13/10/2026; execução em andamento.

Também foi observado que a ALFATECH está **suspensa**, portanto seu ciclo automático de sincronização não roda enquanto permanecer assim. O JSON e o acesso Leitor estão cadastrados e a sincronização manual funciona. O usuário decidiu manter a empresa suspensa após esta correção. Evidência operacional da v1.15.0 em `.tmp/DEPLOY_V1.15.0_20261013.md`; resultado final da correção será registrado em `.tmp/DEPLOY_V1.15.1_20261013.md`.

Pedido específico de 13/10/2026: manter os produtos na planilha da empresa e disponibilizar suas fichas ao atendimento. Preparado no checkout `dev`, sobre v1.14.2, sem publicar código em produção. Não conclui a F7 do plano SaaS.

## Comportamento

- O formulário Google Sheets passa a oferecer os perfis **Agenda de eventos** e **Catálogo de produtos**. O perfil de agenda continua sendo o padrão e mantém os contratos anteriores.
- Produtos usam `Produtos!A2:L1000`; o cabeçalho permanece na linha 1. Não importam eventos/configurações nem exportam pedidos. O perfil fica em `integracoes.configuracao`, sem migração.
- A conta de serviço deve ter acesso **Leitor somente à planilha do catálogo**. Seu JSON é cadastrado no cofre pelo painel. O login do operador no Google Sheets não autentica o servidor.
- O worker mantém o agendamento existente, com intervalo padrão de dois minutos entre ciclos. O atendimento carrega o snapshot atual por empresa em cada mensagem; atualizar produtos não exige republicar o roteiro.
- Em uma empresa versionada, o módulo `catalog` e o vínculo exato `integration:<UUID>` do Google Sheets precisam estar habilitados na revisão publicada. Configurar o recurso físico não substitui publicar esse vínculo.
- O catálogo da planilha substitui o catálogo estático do atendimento quando esse perfil está habilitado. Não espelha linhas em `produtos_servicos`; a planilha é a fonte de edição. A tabela administrativa de produtos locais permanece separada.
- A integração existente opera com uma conexão Google Sheets por empresa. Esta entrega não amplia para vários conectores simultâneos.

## Contrato A:L

| Coluna | Campo | Preenchimento |
| --- | --- | --- |
| A | Código | Obrigatório e único nos produtos ativos; texto estável, até 100 caracteres. |
| B | Modelo | Obrigatório; nome comercial, até 160 caracteres. |
| C | Categoria | Opcional, até 100 caracteres. |
| D | Marca | Opcional, até 100 caracteres. |
| E | Potência (W) | Número não negativo ou vazio. |
| F | Autonomia (km) | Número não negativo ou vazio; condições na descrição. |
| G | Preço (R$) | Número em reais ou vazio para preço sob consulta. |
| H | Disponibilidade | `Disponível`, `Sob consulta` ou `Indisponível`. Obrigatório no produto ativo. |
| I | Unidades | Lista separada por ponto e vírgula ou `Todas`; não representa estoque confirmado. |
| J | Foto (URL) | Opcional. URL HTTPS pública, sem usuário/senha; não aceita endereço local. |
| K | Descrição | Opcional, até 500 caracteres; características confirmadas. |
| L | Status | `Ativo` ou `Inativo`; vazio é rascunho e não entra no atendimento. |

Até **100 produtos Ativo**, incluindo os indicados como indisponíveis. Esse limite evita truncar o catálogo no contexto protegido da IA. Linhas vazias/inativas são ignoradas; um catálogo vazio é uma sincronização válida. Código duplicado, preço inválido e outros erros impedem a substituição do snapshot e retornam código sanitizado, sem conteúdo de células em logs.

Valores numéricos usam `UNFORMATTED_VALUE`, evitando interpretar separadores visuais como parte do preço/potência. A leitura da agenda mantém o formato anterior. Referência: [Google Sheets API — spreadsheets.values.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get).

## Contexto e falhas

A IA recebe SKU, nome, categoria, marca, potência, autonomia, preço, unidades, disponibilidade, descrição e URL da foto. Produtos indisponíveis permanecem explicitados no contexto, com `active: false`, e não aparecem como disponíveis nas listas determinísticas.

O snapshot é escopado por empresa e integração. Só entra no atendimento com versão compatível, status saudável e última sincronização há no máximo dez minutos. Em falha ou expiração, o cache anterior é preservado para recuperação, mas suas fichas não são oferecidas à IA; ela recebe `catalog.source.status: unavailable` e deve pedir confirmação da equipe. As condições gerais do roteiro não se transformam em preços de modelos não confirmados.

Fotos são fornecidas como **links**. Esta entrega não adiciona envio de anexos nem leitura automática do catálogo do WhatsApp Business. Não altera o envio pendente ao grupo interno.

## Configuração da ALFATECH

Planilha preparada: [ALFATECH — Catálogo de produtos](https://docs.google.com/spreadsheets/d/1sj5EGFzhN0LriMqSPWTZ0RoWFh6-a6c7llad4cebz0M/edit#gid=461463990).

Abas `Produtos` e `Instruções`, filtro A:L, preços em reais, primeira linha e primeiras duas colunas fixadas, listas para disponibilidade/status. Nenhum modelo fictício foi cadastrado. O roteiro da ALFATECH recebeu o bloco de uso do catálogo e foi salvo **no rascunho**, com as condições comerciais anteriores preservadas.

O usuário liberou o Google Cloud e indicou `samuelfelipeleao@gmail.com` como a conta do Cloud/Sheets. O projeto existente `waia-production` está disponível; a conta de serviço dedicada ainda será criada, sem papéis de projeto. Depois: habilitar Sheets API, gerar o JSON por ação do usuário, compartilhar somente esta planilha como Leitor, cadastrar o JSON diretamente no cofre e sincronizar. Commit, push de dev e deploy da v1.15.0 foram explicitamente autorizados em 13/10/2026, após revisão; execução em andamento. Após publicação, configurar e publicar o vínculo pelo onboarding. Ainda não há importação real nem teste de resposta WhatsApp usando produtos desta planilha.

## Validação e revisão

- Dez testes específicos: dados pt-BR e valores numéricos nativos; fichas no contexto protegido; vazio/inativo/indisponível; erros sanitizados; duplicatas; limite; IDs estáveis; agenda preservada; cache e falha de leitura; vínculo publicado por empresa.
- Formulário conferido no navegador com API sintética: seleção do perfil, criação desabilitada, campos de produtos, JSON sintético, salvamento/sincronização e recarga sem revelar a credencial. Não houve chamada Google/OpenAI real nessa validação.
- Verificação da planilha exportada e inspeção visual das duas abas confirmaram cabeçalhos, formato de moeda, filtro, congelamento e validações. Arquivo exportado é apoio de QA; o entregável é a planilha Google.
- Suíte completa e candidata isolada em Node 22: resultados finais registrados em `RELATORIO.md`. PostgreSQL/Redis opt-in e integração real Google/WhatsApp continuam pendentes.

Arquivos propostos para o commit:

- `panel/app.js` (somente os novos trechos Google Sheets e callback do formulário; preservar os trechos anteriores de F2).
- `src/google-sheets.js`, `src/integrations/google-sheets/{google-sheets-integration,postgres-adapters,products-snapshot}.js`.
- `src/tenants/postgres-config-loader.js`, `src/modules/runtime/tenant-runtime-config.js`, `src/modules/ai/guardrails.js`, `src/modules/admin/admin-service.js`.
- `test/google-sheets-products.test.js`, `test/panel-static.test.js`.
- `package.json`, `package-lock.json`, `PLAN.md`, `RELATORIO.md` e este documento.

Versão candidata: **1.15.0**. Mensagem proposta: `feat: v1.15.0 catálogo de produtos por Google Sheets`.

Alterações anteriores de equipe/MFA foram preservadas no checkout e excluídas da candidata. Commit, push de dev e deploy autorizados em 13/10/2026; execução em andamento. Não há nova dependência ou migração. Main permanece fora dessa autorização.
