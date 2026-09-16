# Aceites operacionais e jurídicos da Fase 11

Registro consolidado em 7 de setembro de 2026. Este documento não contém segredos, tokens nem URLs privadas.

## Aceites confirmados pelo responsável

- RPO de produção: 24 horas.
- RTO de produção: 4 horas.
- Responsável por incidentes: Samuel Felipe.
- Contato operacional e de privacidade informado: `samuelfelipeleao@gmail.com`.
- Destino de cópia externa: Google Drive, sempre por remote `crypt` dedicado do rclone.
- Canal de alertas: Discord, por webhook HTTPS dedicado sem menções automáticas.
- Operador informado: Samuel Felipe Leão de Barros, pessoa física.

## Texto jurídico aprovado

Valores aprovados para as páginas públicas:

- `LEGAL_PLATFORM_NAME=WAIA`
- `LEGAL_PRIVACY_EMAIL=samuelfelipeleao@gmail.com`
- `LEGAL_CONTROLLER_NOTICE=A WAIA é operada por Samuel Felipe Leão de Barros, pessoa física. Para o atendimento de cada empresa cliente, essa empresa define as finalidades e atua, em regra, como controladora; a WAIA trata os dados como operadora segundo suas instruções. Quando Samuel Felipe Leão de Barros determinar finalidades próprias da plataforma, atuará como controlador desse tratamento específico.`

Samuel Felipe confirmou em 7 de setembro de 2026 que assume a revisão jurídica e aprovou expressamente o texto integral de `public/privacy.html`, `public/data-deletion.html` e a redação deste aviso. A aprovação registrada aqui é a decisão operacional do responsável pelo projeto e não substitui aconselhamento jurídico profissional.

## Evidências concluídas

- Google Drive: concluído. A conta `samuelfelipeleao@gmail.com` é o único usuário de teste do app `WAIA Backup`; o cliente OAuth próprio do projeto `waia-production` está instalado, a cópia cifrada e o `rclone cryptcheck --one-way` foram repetidos com sucesso, e o timer externo está habilitado.
- Discord: endpoint instalado somente no servidor. O teste sintético do monitor implantado enviou as transições `queue_backlog_high` e `recovered`; o monitor permaneceu ativo e sem falhas de entrega registradas.
- Custódia: concluída na estação do operador. `MASTER_KEYRING`, chave SSH operacional, configuração cifrada do rclone e cliente OAuth próprio possuem cópia local ignorada pelo Git, ACL restrita ao usuário Samuel e inventário SHA-256. O arquivo temporário do webhook foi removido da estação após a instalação.
- Perímetro administrativo: painel, `/api/admin` e `/metrics` estão protegidos no Traefik por allowlist do IPv4 administrativo; `/metrics` também exige Bearer. O firewall da Hostinger restringe SSH e EasyPanel ao mesmo endereço.
- MFA e recuperação no piloto: mitigação formalizada por credencial administrativa individual, senha forte, troca autenticada de senha, revogação de sessões e allowlist. MFA, convite e recuperação automatizada permanecem requisitos posteriores ao piloto.
