# Operação de release candidate

Este runbook descreve o caminho manual reproduzível até a homologação. Ele não autoriza produção, credenciais reais, DNS, tráfego público ou restore fora de ambiente isolado.

## Gates humanos antes do piloto

- responsável técnico, janela e rollback definidos;
- RPO e RTO aprovados;
- textos legais, razão/nome da operadora, contato e papéis aprovados pelo responsável jurídico;
- `ADMIN_NETWORK_ALLOWLIST` apontando somente para VPN ou redes administrativas autorizadas;
- destino HTTPS de alertas e responsável de plantão definidos;
- snapshot OpenAI avaliado e catálogo de preços revisado;
- cópia cifrada fora da VPS para banco e mídia, além de custódia independente de todas as versões necessárias do `MASTER_KEYRING`.

## Identificação e build

1. Confirmar branch, árvore limpa, commit e versão: `git status --short --branch`, `git rev-parse HEAD` e `node -p "require('./package.json').version"`.
2. Executar `npm ci`, `npm audit --omit=dev`, `npm test` e as integrações opt-in somente contra infraestrutura sintética.
3. Validar `docker compose config --quiet` com segredos sintéticos.
4. Construir sem cache: `docker build --no-cache --tag waia:<versao>-<sha> .`.
5. Registrar `docker image inspect waia:<versao>-<sha> --format '{{.Id}}'`, commit, versão, horário UTC e resultado dos testes. A Fase 12 deverá promover exatamente esse artefato ou um digest publicado, sem reconstrução.

Defina `WAIA_IMAGE=waia:<versao>-<sha>` ao subir homologação e produção com `docker compose up --no-build`. API, worker, migrador e monitor referenciam essa mesma imagem; não reconstrua nenhum serviço durante a promoção.

O workflow da branch `dev` exporta `waia-image.tar.gz`, seu checksum SHA-256 e `image-metadata.txt` no artefato `waia-image-<commit>`. Depois de baixar o artefato no alvo autorizado, execute `sha256sum --check waia-image.tar.gz.sha256`, `gzip -dc waia-image.tar.gz | docker load` e confira o image ID carregado contra `IMAGE_ID` antes de definir `WAIA_IMAGE`. Isso transporta a imagem aprovada sem reconstruí-la.

## Homologação limpa

1. Use um nome Compose exclusivo e temporário, diferente de `waia-test`, e volumes vazios.
2. Gere senhas, `SESSION_PEPPER`, token de métricas e `MASTER_KEYRING` exclusivos; não copie `.env` de outro ambiente.
3. Suba PostgreSQL, Redis, `db-init`, `media-init`, migrador, API, worker, painel e Caddy com `WAIA_IMAGE` e `--no-build`.
4. Confirme as 20 migrações e crie o primeiro administrador no contêiner já ativo com `docker compose exec api npm run admin:create`; informe a senha somente pela entrada padrão, nunca por argumento ou arquivo. Evite `docker compose run` em uma stack existente, pois ele também avalia dependências e pode recriá-las após mudanças na versão do Compose.
5. Cadastre as duas empresas sintéticas pelas rotas consumidas pelo painel, sem SQL, seed ou alteração de configuração por tenant.
6. Execute E2E, reinicie API e worker, suspenda uma empresa e confirme que a outra permanece isolada.
7. Gere backup completo e restaure-o em outro alvo descartável usando os gates de confirmação documentados abaixo.
8. Registre commit, versão, image ID/digest, horários, testes e resultado do restore. Remova o ambiente temporário somente depois de preservar o relatório sem segredos.

## Backup completo

Definir explicitamente `WAIA_COMPOSE_PROJECT`, `KEYRING_CUSTODY_REFERENCE` e o diretório de backup. A referência de custódia identifica o segredo no cofre externo; nunca contém o keyring.

```sh
WAIA_COMPOSE_PROJECT=waia-test \
KEYRING_CUSTODY_REFERENCE='vault://waia/keyring/<versao>' \
BACKUP_DIR=./backups \
sh scripts/backup-postgres.sh
```

O bundle contém `postgres.dump`, `media.tar.gz`, manifesto e checksums. Redis não é fonte de verdade e não integra o restore. Copiar o bundle de forma cifrada para armazenamento externo e verificar os checksums nessa cópia.

## Restore isolado

Nunca testar restore sobre o ambiente corrente. Preparar previamente um Compose descartável e isolado, com volumes vazios e credenciais sintéticas. Confirmar o nome exato no token:

```sh
WAIA_COMPOSE_PROJECT=<projeto-isolado> \
RESTORE_ISOLATED=true \
RESTORE_CONFIRM='RESTORE:<projeto-isolado>:waia' \
sh scripts/restore-postgres.sh ./backups/waia-backup-<timestamp>
```

Depois, validar `/health/ready`, migrações, RLS, filas, contagem de registros e leitura de amostras sintéticas de mídia. O ambiente isolado só pode ser removido após registrar a evidência e confirmar os alvos.

## Recuperação do keyring

1. Recuperar o `MASTER_KEYRING` por canal seguro e independente do backup de dados.
2. Conferir versões esperadas sem imprimir chaves.
3. Iniciar apenas o ambiente isolado e ler uma credencial sintética já cifrada em cada versão ainda usada.
4. Rotacionar para uma nova versão ativa mantendo as versões antigas durante a recriptografia.
5. Remover versão antiga somente depois de comprovar que nenhum envelope a referencia e de renovar a custódia externa.

Perder qualquer versão ainda referenciada torna as respectivas credenciais irrecuperáveis; restore do banco não corrige essa perda.

## Implantação e rollback

Antes da implantação, registrar imagem/digest anterior e novo, backup completo, migrações aditivas, responsáveis e critérios de aborto. Subir o artefato aprovado, executar migrações uma única vez, verificar health, métricas, monitor, fila e webhook inválido. Não executar seed de demonstração.

Rollback de aplicação promove o digest anterior e revalida compatibilidade das migrações. Restore de dados é último recurso: exige alvo confirmado, autorização específica, estimativa de perda após o ponto de recuperação e restauração prévia em ambiente isolado.

## Alertas e métricas

`/metrics` é publicado pelo Caddy, mas continua protegido pelo Bearer de pelo menos 32 caracteres. O serviço `monitor` usa essa rota pela rede interna e envia transições sanitizadas ao webhook HTTPS:

```sh
docker compose --profile operations up -d monitor
```

Antes do piloto, provocar e recuperar alertas de health, heartbeat, job falho e fila; confirmar recebimento no canal real e registrar o responsável. Alertas de quota da IA usam o mesmo destino.

## Preparação privada na Hostinger com EasyPanel existente

Inspeção de 5/6 de setembro de 2026: a VPS usa Ubuntu 24.04, Docker 29.3.0 e Compose 5.1.0, com 1 CPU, 4 GB de RAM e 50 GB de disco. EasyPanel/Traefik e dois n8n já estão ativos. As portas 80/443 pertencem ao Traefik; não iniciar o Caddy do Compose padrão nem reiniciar serviços existentes sem considerar seu impacto.

O hostname fornecido pela Hostinger, `srv1513113.hstgr.cloud`, resolve para a VPS em IPv4 e IPv6 e é a alternativa gratuita ao domínio próprio. Em 6 de setembro de 2026, o ingresso foi publicado no Traefik existente e recebeu certificado válido da Let's Encrypt para esse hostname.

`infra/hostinger/compose.staging.yml` complementa o Compose existente para a instalação na Hostinger. Ele remove builds, exige imagem homologada, desabilita as portas do Caddy e mantém API/painel em loopback (`13001`/`18080`) além da rede usada pelo Traefik. PostgreSQL e Redis permanecem privados. Os limites iniciais de memória/CPU e a concorrência de um job precisam ser avaliados em carga na VPS; não representam garantia de capacidade. Redis usa `noeviction` para não remover jobs ao atingir o limite.

Usar `COMPOSE_FILE=docker-compose.yml:infra/hostinger/compose.staging.yml` no ambiente Linux dedicado, com `COMPOSE_PROJECT_NAME=waia-prod` e segredos novos fora do Git. Os scripts de backup precisam receber o mesmo `COMPOSE_FILE` e `WAIA_COMPOSE_PROJECT=waia-prod`. Não usar os valores de validação sintéticos em uma implantação real.

Na produção, execute o Compose somente após `cd /opt/waia/current` em um shell com acesso ao diretório. Os caminhos absolutos em `COMPOSE_FILE` não fazem o Compose carregar automaticamente o `.env` da release quando o diretório corrente é outro. Para alterações operacionais, use um script com `set -eu`, valide o `cd` antes de qualquer comando e recrie somente o serviço necessário.

Antes de iniciar: validar checksum da imagem transportada, conferir seu image ID contra `sha256:861616212b498b2cdd3e0bbcbebf988646895e830e8d67aabfd32e99324098ad`, carregar sem rebuild e usar os arquivos de painel/infra da tag `v1.9.1-rc.1`. O overlay é uma alteração de infraestrutura posterior à candidata e ainda exige smoke tests reais.

Esta etapa bloqueia administração com um endereço reservado para documentação. Não liberar o painel mudando a allowlist para rede Docker: o Nginx intermediário altera o IP observado pelo Express. A publicação definitiva precisa preservar corretamente o IP do cliente ou aplicar o perímetro no proxy de entrada, com testes de cabeçalhos forjados nos caminhos direto e via painel.

A instalação privada foi realizada em 6 de setembro de 2026 no projeto `waia-prod`, diretório `/opt/waia/releases/v1.9.1-rc.1`. Segredos foram gerados no servidor com `.env` em modo 600, sem credenciais reais de provedores e sem seed. A identidade da imagem foi conferida após o transporte.

Na extração dos arquivos de release com umask 077, garantir modo 755 na árvore `panel/`, que contém somente assets públicos montados como somente leitura; não aplicar esse modo ao `.env`, backups ou segredos. O overlay conecta o painel também à rede egress porque uma rede exclusivamente internal impede a publicação da porta Docker, inclusive em loopback.

Smoke privado aprovado: API/worker/PostgreSQL/Redis saudáveis; health e assets 200; administração 403; métricas sem token e webhook sem assinatura 401. Foram aplicadas 20 migrações, com zero empresas/usuários e 48 tabelas com RLS forçada. Reinício de API/worker recuperou readiness. O backup local inicial possui checksums válidos.

O restore desse bundle foi aprovado no projeto descartável `waia-restore-drill`: readiness recuperada, 20 migrações, zero tenants, 48 tabelas com RLS forçada e três entradas de mídia restauradas. O alvo não publicou portas nem recebeu rota e foi removido com seus volumes ao final. A produção permaneceu saudável.

Evidências sanitizadas na release: `private-smoke.json`, `release-evidence.json`, `infra-images.json`, `public-smoke.json`, `restore-drill.json` e `post-reboot.json`. Usar os digests registrados para reprodução das imagens auxiliares. A imagem WAIA não foi reconstruída.

O administrador inicial foi criado por entrada interativa em 7 de setembro, diretamente no contêiner da API e sem registrar credenciais em arquivo ou argumento. O primeiro login autenticado carregou a visão global da plataforma, e o logout emitido pelo painel com o CSRF da sessão foi confirmado como sucesso no log de auditoria. A cópia externa cifrada do bundle está ativa e validada. O keyring, a chave SSH e a configuração rclone possuem cópia na estação do operador, fora da VPS e com ACL restrita. O destino Discord respondeu HTTP 204 ao teste direto; a instalação no monitor depende da promoção da versão 1.10.0. A Hostinger mantém backup semanal separado da VPS e foi criado um snapshot pós-publicação com expiração em 7 de setembro.

Em 7 de setembro, foram aprovados RPO de 24 horas e RTO de 4 horas, com Samuel Felipe (`samuelfelipeleao@gmail.com`) como responsável por incidentes. Google Drive foi escolhido para cópia externa cifrada e Discord para alertas. Os valores e o texto legal foram aprovados expressamente e estão registrados em `docs/ACEITES_FASE_11.md`.

O rclone deve usar `/etc/waia/rclone.conf` em modo 600, com um remote `crypt` dedicado sobre a pasta `WAIA Backups`. `/etc/waia/offsite-backup.env` deve conter apenas `WAIA_OFFSITE_REMOTE=waia-drive-crypt:production`. A unidade `waia-backup-offsite.service` executa a cópia após um backup local e exige `cryptcheck --one-way`; o timer agenda a rotina às 03:45 UTC com atraso aleatório de até dez minutos. O arquivo de configuração do rclone é material de recuperação e precisa de custódia fora da VPS.

A conta `samuelfelipeleao@gmail.com` é o único usuário de teste do app `WAIA Backup` no projeto `waia-production`. O cliente OAuth próprio foi criado após a ativação da verificação em duas etapas, autorizado e instalado sem alterar o remote cifrado. O primeiro upload e uma repetição após a troca do cliente terminaram com `cryptcheck --one-way` aprovado. `waia-backup-offsite.timer` está habilitado e agenda a rotina às 03:45 UTC com atraso aleatório de até dez minutos.

Para `srv1513113.hstgr.cloud`, `infra/hostinger/traefik-waia.yaml` separa o tráfego: `/webhook*`, `/health*`, `/privacy*` e `/data-deletion*` seguem para a API; `/api/admin*`, a rota exata `/metrics` e o painel exigem allowlist do IP administrativo. A API ainda exige o Bearer próprio em `/metrics`. O Compose conecta apenas API/painel à rede externa attachable do EasyPanel e mantém banco/Redis nas redes privadas. Substituir `__ADMIN_SOURCE_RANGE__` somente no servidor, nunca versionar o IP do operador.

Smoke HTTPS aprovado: certificado e SAN da Let's Encrypt válidos; health 200; sessão administrativa sem login 401; métricas sem Bearer 401 a partir do IP autorizado e 403 fora dele; painel 403 fora da allowlist; páginas legais 503 enquanto os textos aprovados estão ausentes. PostgreSQL, Redis e as portas de loopback da aplicação não são alcançáveis externamente.

O firewall Hostinger `WAIA producao` está ativo com 80/443 públicas, 22/3000 limitadas ao IPv4 administrativo e recusa final para qualquer outra entrada. O usuário `waiaops` usa chave Ed25519 dedicada, sudo e grupo Docker. SSH por senha e teclado interativo estão desativados; root não possui chave autorizada. A chave operacional local fica em `.secrets/hostinger-waiaops`, fora do Git, e precisa de uma cópia segura sob custódia do responsável.

As unidades `waia-backup.service` e `waia-backup.timer` executam backup local diário às 03:15 UTC, com atraso aleatório de até 15 minutos e retenção de sete dias. A execução inicial criou `waia-backup-20260906T215620Z`; o primeiro disparo realmente automático criou `waia-backup-20260907T031736Z` e terminou com status `success`. Dump, mídia e manifesto passaram nos checksums em ambos. `/etc/waia/backup.env` tem modo 600 e continua registrando custódia externa pendente até a referência real ser fornecida.

Após snapshot, 45 pacotes foram atualizados; Docker ficou em 29.8.0 e Compose em 5.5.1. O reboot recuperou volumes e os cinco contêineres WAIA. Os dois n8n foram reativados e tiveram a política Swarm corrigida de `on-failure` para `any`, pois encerramentos limpos durante atualização os deixavam em estado concluído. EasyPanel, Traefik e ambos os n8n terminaram em `1/1`. O provedor mantém cloud-init e kernel em hold; esse hold não foi removido.

Ao iniciar o cadastro administrativo, `docker compose run` avaliou novamente as dependências com o Compose 5.5.1 e recriou PostgreSQL e Redis. O processo foi interrompido antes de receber dados, os volumes persistentes foram preservados e a verificação posterior confirmou 20 migrações, zero tenants, zero usuários, 48 tabelas com RLS forçada e todos os serviços saudáveis. O cadastro foi então executado com `docker exec` no contêiner ativo; a verificação final confirmou um usuário, zero tenants e readiness HTTP 200.

Referências de configuração: [merge de arquivos Compose](https://docs.docker.com/reference/compose-file/merge/) e [perfis Compose](https://docs.docker.com/compose/how-tos/profiles/).
