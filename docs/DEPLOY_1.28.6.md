# Publicação 1.28.6 — triagem imobiliária e fotos da ficha

Publicação autorizada concluída em 24/11/2026, sobre 1.28.5. Runtime `bf6b2da8cd4814257ca3f361121fa5ab91198313`, branch `codex/onix-context-prod-v1.28.4`, checkout estável existente em `WAIA/.tmp/turim-prod-1.23.5`.

- Imagem `waia:1.28.6-bf6b2da8cd48`, ID `sha256:b330ab05e3505cad11f91bf99534c303fc4f5886a4f35228131b89272a378609`; exportação SHA-256 `0edf814d2f8aded38973b5534b0765bb3b1b0412ff2cd845aa3b9923b0142595`. Mesmos bytes aprovados carregados na VPS, sem rebuild. Fonte e 250 arquivos de execução conferidos.
- Imagem Node 22: 756 aprovados/32 condicionais; 105 dirigidos e 30 PostgreSQL aprovados, zero falhas. Banco isolado existente reutilizado com 140 tabelas preservadas por contagem/hash.
- Backup `/opt/waia/backups/waia-backup-20261124T195425Z`, dump/mídia/manifesto/checksums verificados; cópia cifrada em `waia-drive-crypt:production` com zero diferenças. Nenhum restore executado.
- `/opt/waia/current` em `/opt/waia/releases/v1.28.6`, API/worker saudáveis e notificador conectado, sem reinícios na conferência. 32 migrações mantidas, sem migração/seed/dependência novos.
- Configurações publicadas, política de follow-up e ciclos/ações existentes preservados durante a troca. Dez ciclos ativos na leitura final, Turim revisão 34 e política personalizada v9 preservadas. PostgreSQL, Redis e monitor tiveram identidade/estado preservados.
- Painel passou a montar assets/nginx da release 1.28.6. Endereço `10.11.0.79` preservado; mounts antigos e override de retorno guardados no servidor. A versão anterior do painel ainda montava assets de 1.28.0, por isso a atualização foi incluída nesta publicação. HTTPS e hashes dos seis assets aprovados; sessão anônima 401 e rotas privadas 404; confiança no proxy e bloqueio de IP forjado preservados.
- Retorno à 1.28.5 preparado, incluindo imagem e mounts exatos do painel anterior. Não foi executado.

## Pendência de ativação

Filaretti Imóveis permanece ativa na revisão 5, rascunho 51, fotos desativadas e avaliação automotiva desativada. Grupo FCI v3 habilitado e remetente conectado. A flag deve ser ligada pelo painel, mantendo critérios/roteiro atuais; a capacidade agora permite isso sem avaliação de veículos.

O controle informou `Local browser access is unavailable for this chat`; o inventário nativo retornou timeout sem apps acessíveis. Nenhum workaround de tenant por SQL, ambiente, seed ou código foi aplicado. Não houve chat reaberto, foto antiga reenviada ou mensagem de teste enviada externamente.

## Evidências

Manifesto `.tmp/releases/1.28.6-bf6b2da8cd48/manifest.json`; testes/metadados `.tmp/filaretti-images/`; operação `.tmp/filaretti-images/deploy/`, incluindo `preflight.log`, `backup.log`, `stage.log`, `promote.log`, `verify.log`, `public-check.json` e `filaretti-final.log`.

Sem push ou promoção de main; branch `new`/2.0 preservada. Este registro posterior documenta a mesma entrega 1.28.6 e não altera os bytes do runtime publicado.
