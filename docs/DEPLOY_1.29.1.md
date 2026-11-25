# Publicação 1.29.1 — 24/11/2026

Publicação autorizada pelo titular após a implementação e validação das correções de atendimento. Checkout principal `WAIA`, branch **dev**, sobre a produção 1.29.0. Processo e cenários em [Ajustes de triagem contextual](AJUSTES_TRIAGEM_CONTEXTUAL.md).

## Artefato publicado

| Campo | Valor |
| --- | --- |
| Versão | `1.29.1` |
| Commit de runtime | `aea40aafaa98bb95c39736ebbace50eccd8294a4` |
| Imagem | `waia:1.29.1-aea40aafaa98` |
| Image ID | `sha256:afd7d760f5de9ad182bee9bfb1aba3932a58e3807c0523303ab914976639d7f6` |
| SHA-256 da exportação | `2266fb9b8b06c960812d50b6ab6a4b535ba38ac41470e9784d816fa3a081cca1` |
| Base | `node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32` |
| Release ativa | `/opt/waia/releases/v1.29.1` |

Imagem criada dos arquivos comitados, com instalação por `npm ci --omit=dev`; a construção reportou 200 pacotes auditados e zero vulnerabilidades. A árvore de dependências do lockfile foi comparada igual à 1.29.0, exceto a versão do projeto. Os 254 arquivos de runtime foram conferidos contra a fonte; a imagem foi exportada, recarregada e validada pelo mesmo identificador. Sem reconstrução na VPS, publicação em registry, push ou promoção de main.

A conexão inicial ao construtor local expirou. A construção foi concluída com o contexto Docker `default` selecionado por comando, preservando ambientes existentes. O cliente atingiu seu limite de espera durante a finalização; a imagem já exportada foi conferida integralmente antes dos testes e do envio. O registro documental posterior mantém o runtime e a versão publicados.

## Validação da imagem exata

- Node 22: **782 testes aprovados**, 33 condicionais ignorados, zero falhas/cancelamentos, em contêiner temporário sem rede externa e com runtime somente leitura.
- PostgreSQL real: **38 verificações aprovadas**, zero falhas/skips, incluindo filtros persistidos, prazo, ficha, fotos, follow-up e nome pendente. Banco isolado existente `waia_v2_upgrade` de `waia-test`; hashes/contagens das **140 tabelas anteriores preservados**. Contêiner devolvido ao estado parado; sem reset, migração ou remoção de volumes.
- Scripts de staging, backup, ativação e verificação aprovados por `sh -n` no shell da VPS antes da execução.

Manifesto e evidências locais: `.tmp/releases/1.29.1-aea40aafaa98/manifest.json` e `.tmp/triage-release/`, incluindo `image.tap`, `image-postgres.tap` e os logs de operação em `deploy/`.

## Backup e autorização do envio externo

Backup local completo `/opt/waia/backups/waia-backup-20261125T021054Z`: dump PostgreSQL, mídias, manifesto e checksums verificados. O nome do diretório usa UTC; a operação ocorreu em 24/11 no horário de São Paulo. Serviços retomados e conferidos saudáveis ainda na 1.29.0 após a captura.

A revisão automática rejeitou inicialmente o comando com envio do banco/mídias ao destino externo por exigir autorização explícita para esse conteúdo e destino. O backup local foi executado separadamente. O titular então autorizou expressamente a cópia cifrada, incluindo dados dos clientes, para o Google Drive existente `waia-drive-crypt:production`.

Cópia executada somente após essa confirmação e verificada antes da ativação: **quatro arquivos correspondentes, zero diferenças**, no destino `waia-drive-crypt:production/waia-backup-20261125T021054Z`. Segredos e chaves não foram impressos nem incluídos no código.

## Ativação e verificações

- `/opt/waia/current` aponta para a 1.29.1. API, worker e notificador usam o Image ID aprovado; contêineres conferidos em execução e com zero reinícios na leitura final.
- Configurações publicadas e políticas de follow-up comparadas iguais. Ciclos e ações existentes comparados iguais no intervalo com os serviços parados, antes de iniciar o código novo. Sem reinício do calendário por resposta do cliente. Novos eventos de negócio podem atualizar contagens normalmente.
- Mantidas as **32 migrações**, sem aplicação nova. Turim permaneceu ativa na revisão 34. Painel, monitor, PostgreSQL e Redis preservaram identidade e estado.
- API e notificador verificados antes de iniciar o worker. Notificador conectado, erro nulo e lease vigente; volume de mídia do notificador permanece somente leitura e compartilha a identidade do volume existente.
- HTTPS/TLS/IPv4: painel 200, sessão administrativa anônima 401, readiness 200/pronto e hashes dos seis assets correspondentes. CSP e `nosniff` conferidos. Acesso administrativo direto e com cabeçalhos forjados retorna 403; arquivos/rotas privados testados retornam 404.
- `TRUST_PROXY` preservado no peer exato do Traefik. Variáveis globais comparadas iguais, exceto `WAIA_IMAGE`; sem alteração de cadastro, roteiro ou configuração por empresa.

## Retorno e limites

A release `/opt/waia/releases/v1.29.0` e a imagem anterior `sha256:c73f8aa9dd72ea6f9140ac71eeb57ac528500c9d5f29e61e6eaecabf336804a7` foram preservadas. Não houve rollback.

Os novos checkpoints de busca contêm modelos/anos; o leitor da 1.29.0 aceita somente os três filtros antigos. O script desta ativação protege o retorno automático: se houver `catalogBrowse.filters.models` persistido, mantém a versão nova para recuperação por correção à frente, em vez de iniciar o leitor antigo. Após uso do novo formato, retorno exige tratar essa compatibilidade; restauração de dados é uma operação separada, com autorização própria.

Testes usam respostas de IA e transporte fictícios. O status real do notificador foi conferido, mas a automação não enviou conversa/ficha de teste nem comprovou recebimento externo dos novos cenários. Não houve reabertura ou reenvio manual dos atendimentos analisados. A candidata WAIA 2.0 e a branch `new` permaneceram fora desta publicação.
