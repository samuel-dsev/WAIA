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
