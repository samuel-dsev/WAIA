# M9 — candidata e recuperação local

25/10/2026, checkout principal `new`, base `be548d5` / 1.30.1, candidata **2.0.0-rc.1**. O usuário autorizou a M9 e o ensaio em containers temporários com tmpfs, sem usar ou limpar bancos/volumes existentes. Escolheu **preparar localmente e manter domínio/e-mail pendentes**. A fase tem preparação local; seu gate externo permanece aberto. Sem push, registry, publicação, alteração de DNS/VPS/Hostinger ou autorização da M10.

## Artefato e contrato

`scripts/release-candidate.mjs <commit>` aceita uma RC commitada, extrai apenas esse commit e fixa a base Node22 pelo RepoDigest já verificado localmente. Desabilita conversão CRLF na exportação Git. Alterações de trabalho, `.tmp`, `.secrets` e arquivos não rastreados não entram no snapshot. O contrato M1–M8 permanece; os opcionais da M7 continuam fechados.

A build usa o target `release`, sem testes, com labels de versão/revisão. O runner compara SHA256 de **todos** os arquivos copiados de `src/scripts/db/panel/public/portal` e package/lock contra o snapshot do commit, dentro da própria imagem. Dockerfile é registrado como entrada de build. Exporta `waia-image.tar`, checksum SHA256 e `manifest.json`; recarrega o archive e confere o mesmo Image ID. Não promove tags de instalação nem refaz build na promoção.

O manifesto em `.tmp/releases/<versão>-<commit>/manifest.json` é a identidade operacional: commit/tree, versão, base, Image ID, hashes individuais, SHA256 do archive e data UTC. **Image ID é digest local da configuração, distinto de RepoDigest de registry**. `registryDigest: null` é explícito porque não houve push. Para transportar a imagem, conferir o SHA256 antes de `docker load` e conferir o Image ID depois. A [documentação Docker](https://docs.docker.com/reference/cli/docker/image/save/) descreve o par save/load; publicação em registry requer aprovação e evidência próprias.

A CI usa o mesmo runner, exporta somente manifesto/archive/checksum e inclui `new`. Continua sem deploy automático. Execução remota da CI não foi feita nesta fase.

## Ingress preparado

Arquivos novos: `src/operations/v2-ingress.js`, `scripts/v2-ingress.mjs`, `infra/compose.v2-ingress.yml` e `infra/hostinger/traefik-waia-v2.yaml`. O proxy Hostinger legado e o preview loopback foram preservados. O Caddy genérico anterior não é o ingress aprovado para abertura pública da v2.

Duas superfícies usam **o mesmo Image ID RC** e upstream fixo, sem credenciais:

- Pública: raiz/login, assets explícitos do portal, `/api/account/v1`, `/api/app/v1`, páginas legais e somente `/panel/attendance-script.js`, módulo compartilhado importado pelo editor. `/panel/` e seus demais arquivos, admin, métricas, webhooks e health ficam negados nessa superfície.
- Administrativa: painel, `/api/admin`, métricas e health; requer peer real exato do socket. O Traefik aplica adicionalmente allowlist dos IPs do operador. Autenticação admin/MFA/CSRF e Bearer de métricas continuam no backend.

O gateway recusa Host/origem divergentes, mutações sem origem, targets absolutos, barras duplicadas, dot segments, percent-encoding no caminho, backslash, controles e fragmentos antes de encaminhar. Substitui headers de encaminhamento/reescrita; não usa cookie customer ou header forjado como autorização. Cookies recebidos do backend precisam ser host-only e Secure fora do teste local. A API não pode ter porta direta publicada.

`V2_INGRESS_TRUSTED_PROXY_PEERS`, opcional no módulo, aceita apenas IPs exatos. Somente para um socket confiável usa o **último** IP válido de XFF; ausência/formato inválido nega antes do upstream. O peer administrativo continua sendo validado pelo socket. O overlay exige o peer exato do Traefik para as duas superfícies. Antes de instalar, provar que esse Traefik acrescenta o peer real por último, não usa `forwardedHeaders.insecure` e não confia em proxies arbitrários. Sem confiança configurada, clientes compartilham o IP/limite do peer.

Configuração global a aprovar uma vez, nunca por cliente:

1. Domínios HTTPS distintos público/admin, certificados e origens exatas de `CUSTOMER_PORTAL_ORIGIN`, `PANEL_ORIGIN` e gateways; cookies Secure, sem Domain amplo.
2. IPs do operador no Traefik, peer exato do Traefik nos gateways e `TRUST_PROXY` da API limitado aos gateways exatos. `ADMIN_NETWORK_ALLOWLIST` da API deve representar o IP validado do operador; jamais toda a rede Docker.
3. Redes V2 dedicadas e sem caminho direto público à API, banco, Redis, mídia ou cofre. Nenhum serviço deve apontar à instalação anterior.
4. Provedor/remetente e destinatários autorizados de e-mail; testar ativação/recuperação até **recepção**, sem registrar links/tokens. Fake é somente local.

Os templates têm parâmetros obrigatórios/marcadores e não são uma configuração instalada. O `docker compose config --quiet` foi validado com valores sintéticos, sem criar os serviços. DNS/TLS/Traefik efetivo, origem/cookies no navegador público e distribuição de rate limit continuam gates externos.

## Recuperação reproduzível

O runner host `scripts/m9-recovery-check.mjs` exige dois Image IDs e `--authorize-tmpfs`. A autorização vale apenas para seus novos containers `waia-test-m9-source-<id>`, `...restore-<id>` e `...redis-<id>`, rotulados no projeto existente `waia-test`, na rede interna `waia-test_v2_internal`. Antes de restaurar/remover, confere nome, labels, única rede interna, tmpfs e ausência de volumes persistentes/portas. Não aceita um nome de banco/volume existente como alvo.

```powershell
rtk proxy node scripts/m9-recovery-check.mjs <RC_IMAGE_ID> <M8_IMAGE_ID> --authorize-tmpfs
```

Sequência do ensaio:

1. Banco novo vazio → 30 migrações, sem seed. Executa o **comando operacional `scripts/create-admin.js`** da própria RC, senha por stdin sem eco e sem reset de identidade. Verifica hash/senha restaurados; não é prova de matrícula/login MFA admin.
2. Fixture técnica separada cria uma empresa suspensa, um cliente fictício, uma credencial sintética cifrada, uma mídia e dois jobs noop (pendente/concluído). Não substitui os cadastros de produto pelo painel comprovados na M8.
3. Sem escritores/workers ativos, produz dump custom e archive de mídia/estado, gera e verifica SHA256. Keyring/peppers/senhas sintéticos ficam fora do bundle, em `.secrets/m9-<id>.env`, nunca no manifesto ou stdout. O dump contém dados sintéticos e não é versionado.
4. Confere destino vazio e restaura com `pg_restore --single-transaction --exit-on-error --no-owner --no-acl --role=waia_v2_owner`. A [documentação PostgreSQL16](https://www.postgresql.org/docs/16/app-pgrestore.html) descreve transação única e falha por erro. Não há DROP/reset de alvo existente. Dump é transferido como bytes, sem redirecionamento textual do PowerShell; Desktop não disponibilizou o arquivo tmpfs pelo mecanismo `docker cp`.
5. Compara contagem e hash das linhas de **todas** as tabelas, incluindo ledger e metadados; migração reaplicada zero. Verifica role app sem superuser/BYPASSRLS, RLS forçada, leitura sem contexto/vizinha negada, descriptografia com a chave em custódia e SHA256 da mídia.
6. Smoke da API real com PostgreSQL/Redis e assets na imagem; sem e-mail/worker de atendimento. Após rollback/retorno, gateway público atravessa login customer real, cookie Secure/HTTPOnly/SameSite/host-only, lista e negação admin/métricas/painel com headers forjados.
7. Registra `backupMs`, `restoreMs`, `restoreAndVerifyMs` e passos em `.tmp/m9/recovery-<id>/proof.json`; remove somente os três containers temporários após conferir propriedade. Mantém provas/bundle sintéticos e chave separada para inspeção. Nenhum RPO/RTO público é inferido desses tempos locais.

O bootstrap operacional foi acrescentado ao ensaio após revisão independente. O ensaio real usa `pg_restore` direto; **não comprova todo o shell legado de restauração em banco real**. O shell `scripts/restore-postgres.sh` recebeu correção para manter API/worker parados se stop, restore ou migração falhar. Quatro testes com Docker simulado, checksum e tar reais comprovam falhas sem `start`, e sucesso com um único `start` após migração.

## Rollback delimitado

Destino de retorno: **M8 `be548d5` / 1.30.1**, com schema30 e payloadVersion1. A imagem M8 foi construída de exportação desse commit com conversão CRLF desativada. O runner verifica os blobs de todos os arquivos de runtime/assets/package da imagem contra o commit Git, além da versão. Não basta atribuir a uma imagem a versão1.30.1.

No banco restaurado da RC, a imagem M8 verifica ledger/reaplicação0/dados/cofre/mídia/RLS e API, sem downgrades SQL. Repositórios reais de outbox/jobs rejeitam replay concluído, reconciliam o noop pendente, concluem uma vez e rejeitam repetição. A RC retorna, confirma os dois jobs concluídos e dispatch vazio, e repete smoke da API/gateway. Nenhum handler de atendimento, gateway externo ou efeito financeiro é executado.

Essa compatibilidade não autoriza rodar release anterior à023, restaurar produção, reenviar mensagens ou migrar empresas antigas. Redis é descartável no ensaio; fonte durável dos jobs é PostgreSQL. Recuperação real exige quiescência, reconciliação dos efeitos externos, backups completos/cifrados e autorização própria.

## Validações e limites

- Node22: **698 casos, 668 pass, 30 skips opt-in, zero falhas**; 11 casos novos de ingress HTTP real, quatro de falha segura no restore e um de confiança exata da raiz administrativa. O teste histórico de distribuição foi atualizado para o novo runner, sem retirar a verificação dos diretórios necessários. O runtime respeita `TRUST_PROXY` explícito também na raiz/admin; ausência mantém o default legado, por isso a configuração exata é obrigatória no novo alvo.
- Regressão ampliada: **23 arquivos, 132 integrações PostgreSQL/Redis pass, zero skips/falhas**, mesmas três exclusões justificadas da M8. As bases técnicas são verificadas novamente vazias ao final, preservando o dataset de produto.
- Sintaxe, Compose com valores sintéticos, build/npm ci/auditoria e recuperação real em tmpfs. O manifesto identifica a imagem final da RC; as primeiras rodadas de validação são preparatórias e não são candidatas de distribuição.
- Revisões independentes de release/dados e exposição; sem crítico/alto aberto conhecido. Corrigidos retorno automático após restore incompleto, extração de IP confiável, origem exata do rollback, exportação Git com CRLF e tipagem da fixture noop.
- Trabalho preexistente alheio preservado: `.env.example`, `docker-compose.yml`, `docs/PAUSA_WHATSAPP_BUSINESS.md`, `portal/styles.css`, `src/config.js`, `.tmp/` e `portal/security-team.js`.

**Pendências para fechar o gate completo da M9:** domínio/origem e perímetro efetivamente instalados/aprovados, TLS/cookies/cadeia de proxy/rate limit verificados no alvo, provedor/remetente/destinatário autorizado e recepção real dos e-mails. Não houve consulta ou mudança na VPS. Estável2.0.0, M10, push, promoção e deploy continuam dependentes de autorização e dos gates restantes.
