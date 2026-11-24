# Publicação 1.28.5 — follow-up padrão para novos leads

Publicação autorizada pelo titular em 24/11/2026, concluída sobre a produção 1.28.4. Novos leads elegíveis entram com follow-up ativo conforme a política já configurada no painel. Escolhas individuais, horários e contadores existentes foram preservados.

## Artefato e base

- Checkout: `C:\Users\Samuel\Documents\Projetos\WAIA\.tmp\turim-prod-1.23.5`; branch `codex/onix-context-prod-v1.28.4`.
- Commit publicado: `2f97f2751883b9e18e1fafd91831bc18ad4ffa22`, versão `1.28.5`.
- Imagem: `waia:1.28.5-2f97f2751883`, ID `sha256:64138889fac759d95725f06c9daa6509c132bf980057a495d3b56e98d9827d38`.
- Exportação: SHA-256 `0b8cd164360cd370d0380618996eb0235046a51344f5414d84b354fd3b08536a`; mesmos bytes carregados na VPS, sem rebuild.
- Fonte e 250 arquivos de runtime conferidos no artefato. Instalação pelo lockfile com zero vulnerabilidades reportadas. Nenhuma dependência ou migração nova.
- `/opt/waia/current` aponta para `/opt/waia/releases/v1.28.5`; 32 migrações mantidas. A release 1.28.4 e sua imagem permanecem disponíveis para retorno compatível, sem restore executado.

## Validações e preservação

- Código local: 752 testes aprovados/31 condicionais ignorados. Imagem exata em Node 22: 750 aprovados/31 condicionais, zero falhas.
- PostgreSQL da imagem: 20 casos aprovados. Banco isolado existente reutilizado, 140 tabelas preservadas por contagem/hash e serviço devolvido ao estado parado. Sem mensagens WhatsApp ou fichas reais geradas pelos testes.
- Backup consistente: `/opt/waia/backups/waia-backup-20261124T093835Z`, dump/mídia/manifesto e checksums verificados. Cópia cifrada em `waia-drive-crypt:production` aprovada por `cryptcheck`, sem diferenças.
- Configurações publicadas e política de follow-up comparadas iguais antes/depois. Ciclos e ações completos comparados iguais com os escritores parados, após recriar os containers e antes de iniciá-los. Assim, novos leads e conclusões naturais após a retomada não são confundidos com alterações do deploy.
- Leitura final: Turim ativa na revisão 34; uma empresa com follow-up habilitado; política personalizada v9, períodos `[10,31,56,88]` horas e fechamento em 96 horas; nove ciclos ativos. Contagem de mensagens de follow-up permaneceu em três na conferência, sem envio provocado pelo deploy.
- API/worker saudáveis e notificador conectado, lease atual e sem erro; três processos na imagem aprovada, sem reinícios após a troca. PostgreSQL, Redis, monitor e painel tiveram identidade/estado preservados. Mídia do notificador continua somente para leitura.
- HTTPS do painel e readiness 200, sessão administrativa anônima 401; hashes dos seis assets conferidos. Acesso direto e cabeçalhos de IP forjados continuam bloqueados; rotas privadas/não distribuídas retornam 404. Proxy restrito ao peer existente preservado.

## Evidências e limites

Manifesto em `.tmp/releases/1.28.5-2f97f2751883/manifest.json`; testes e metadados em `.tmp/follow-up-default/`; operação em `.tmp/follow-up-default/deploy/{preflight,backup,upload,stage,promote,verify,public-check}.log` e `public-check.json`.

Sem push, promoção de main ou alteração da branch `new`/2.0. Não foi necessário salvar a política no painel, modificar configuração de cliente por SQL, marcar contatos retroativamente ou reabrir chats. O padrão passa a valer para as novas conversas reais recebidas pela versão publicada; a entrega de uma nova mensagem proativa a cliente não foi provocada para teste.

Este registro é posterior ao build e documenta a operação da mesma entrega 1.28.5. A imagem publicada conserva o commit de runtime acima.
