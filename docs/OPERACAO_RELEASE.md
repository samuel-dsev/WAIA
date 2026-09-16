# Operação — build, backup, restore e release

Consolidado em 16/09/2026. Procedimentos não autorizam, por si, produção, exclusão de volumes ou tráfego externo. Estado histórico: [RELATORIO.md](../RELATORIO.md). Evolução: [WAIA_2.0.0.md](../WAIA_2.0.0.md).

## Preparação e artefato

1. Confirmar ambiente, branch, árvore, commit e versão. Preservar alterações existentes.
2. Rodar instalação pelo lockfile, auditoria, testes proporcionais e integrações PostgreSQL/Redis autorizadas. Validar Compose com segredos sintéticos, sem imprimir configuração secreta.
3. Construir imagem imutável identificada por versão/commit; registrar image ID/digest e resultados. Exportar uma vez, gerar/verificar checksum e carregar o mesmo artefato no alvo.
4. API, worker, migrador e monitor usam `WAIA_IMAGE` e `--no-build`; assets devem corresponder ao commit. Não reconstruir na promoção.
5. Verificar gatilhos reais da CI: na baseline, push em dev e pull request. Inclusão de main/tags e portal é trabalho planejado.

## Homologação

- Usar `waia-test` conforme instrução do projeto; preservar demais ambientes. Nunca presumir que seus volumes sejam descartáveis.
- Segredos sintéticos exclusivos, sem `.env` de produção. Não habilitar integrações reais inadvertidamente.
- Validar migrações, RLS com role de aplicação, duas empresas, fluxos, restart de API/worker e isolamento. Novos tenants são cadastrados pelo painel/API de aplicação.
- Criar administrador inicial via entrada padrão em container ativo (`docker compose exec api npm run admin:create`), sem senha em argumento ou log. Evitar `compose run`, que pode avaliar/recriar dependências.
- Restore necessita destino comprovadamente isolado e autorizado, distinto do ambiente a preservar. Não usar produção nem sobrescrever waia-test. Se um novo alvo temporário for necessário, defini-lo explicitamente com o usuário.

## Backup completo e custódia

Definir `WAIA_COMPOSE_PROJECT`, `COMPOSE_FILE` quando aplicável, `BACKUP_DIR` e `KEYRING_CUSTODY_REFERENCE`. A referência identifica a custódia; não contém a chave.

```sh
WAIA_COMPOSE_PROJECT=waia-test \
KEYRING_CUSTODY_REFERENCE='vault://waia/keyring/<versao>' \
BACKUP_DIR=./backups \
sh scripts/backup-postgres.sh
```

Bundle: `postgres.dump`, `media.tar.gz`, manifesto e checksums. Copiar cifrado para destino externo e verificar conteúdo; Redis não é fonte de verdade nem substitui backup. Na 2.0.0, incluir conhecimento e política de recuperação dos índices.

Todas as versões do keyring ainda referenciadas, chave SSH e configuração de recuperação do rclone exigem custódia fora da VPS. Recuperar segredo não significa imprimi-lo. Conferir versões e testar leitura de credencial sintética; recriptografar antes de remover versão antiga.

## Restore isolado

Confirmar destino absoluto, projeto, volumes e perda esperada antes de executar. O exemplo é um template, não um alvo pronto:

```sh
WAIA_COMPOSE_PROJECT=<alvo-isolado-autorizado> \
RESTORE_ISOLATED=true \
RESTORE_CONFIRM='RESTORE:<alvo-isolado-autorizado>:waia' \
sh scripts/restore-postgres.sh ./backups/waia-backup-<timestamp>
```

Validar checksums, migrações, RLS, contagens, integridade de mídia, cofre e readiness. Evitar envio externo no ambiente restaurado. Reconciliar outbox, IDs externos e efeitos financeiros antes de reabrir workers em recuperação real. Preservar evidência; limpeza de alvo/volumes exige autorização.

## Produção Hostinger — cuidados preservados

- Layout registrado: `waia-prod`, `/opt/waia/releases/<versao>`, symlink `/opt/waia/current`; hostname histórico `srv1513113.hstgr.cloud`. Conferir ao vivo antes de operar.
- Traefik usa 80/443; EasyPanel e dois n8n compartilham host. Não iniciar Caddy concorrente nem reiniciar serviços alheios.
- Overlay: `infra/hostinger/compose.staging.yml`; ingresso: `infra/hostinger/traefik-waia.yaml`. PostgreSQL/Redis privados; API/painel em portas locais e redes específicas.
- Em Linux, executar script `set -eu`, entrar na release correta e carregar seu ambiente antes de Compose. Caminho absoluto em COMPOSE_FILE não escolhe o `.env` automaticamente.
- Segredos e arquivos de recuperação com acesso restrito; assets públicos precisam ser legíveis pelo servidor, sem aplicar chmod amplo a `.env`/backups.
- Preservar IP real e confiança no proxy. Não liberar administração por allowlist da rede Docker. Testar cabeçalhos forjados e caminhos via painel/direto.
- Perímetro histórico: painel e `/api/admin` com allowlist; métricas com allowlist e Bearer. Firewall limita SSH/EasyPanel, SSH por chave. Não abrir o prefixo administrativo para criar portal público.
- Checksums SQL toleram somente equivalência LF/CRLF do mesmo conteúdo. Nunca editar migração aplicada para destravar deploy.

## Promoção e rollback

1. Obter autorização do alvo/janela; identificar versão antiga/nova, backup verificado, imagem disponível e responsável.
2. Validar compatibilidade de schema/configurações/jobs; aplicar migrações aditivas uma vez, sem seed de demonstração.
3. Promover imagem homologada, preservando volumes e dependências. Smoke: API/worker/monitor, health, páginas, autenticação, permissões, webhook inválido e filas.
4. Registrar versão/commit/image ID, migrações, testes, backup e caminho de retorno, sem segredos.
5. Em falha, voltar imagem apenas se compatível com o estado atual; restaurar dados é operação separada, com autorização e estimativa de perda. Não repetir envio/cobrança após rollback.

## Monitoramento e operação histórica

`/metrics` exige token dedicado; logs/alertas sanitizados e sem tenant IDs como labels. Monitor envia disparo/recuperação, não spam de estado invariável. Testar destino HTTPS real com evento sintético autorizado.

Aceites de 07/09/2026: RPO 24h/RTO 4h, backup externo cifrado no Google Drive, alertas Discord e custódia na estação do operador. Registro completo preservado em [ACEITES_FASE_11.md](ACEITES_FASE_11.md); revalidar para abertura pública.

Timers registrados: backup local 03:15 UTC (+até 15min), retenção de sete dias; externo 03:45 UTC (+até 10min), com `cryptcheck --one-way`. Configurações sensíveis ficam em `/etc/waia`, modo 600. Cliente OAuth próprio já substituiu o compartilhado; monitorar autorização/refresh e entrega, não assumir permanência por sucesso antigo.

Última release registrada: v1.10.6/497e511, não verificada ao vivo nesta revisão. Não reutilizar o image ID antigo da candidata v1.9.1 como requisito para novos deploys. Capacidade do host, snapshots temporários, versão do Docker e datas de backup precisam de leitura atual.
