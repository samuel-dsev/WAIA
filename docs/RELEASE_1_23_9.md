# Ficha completa de lead — 1.23.9

Correção autorizada sobre a produção `1.23.8`/`1280791`, portada da candidata `2.0.0-rc.39`. O fluxo de financiamento substituía resumo e qualificação validados por frases fixas de interesse, descartando dados coletados. A sobrescrita foi removida.

As instruções exigem a ficha interna completa com bloco **Dados coletados:** e os dados relevantes já fornecidos para a finalidade prevista no roteiro, incluindo campos de simulação quando autorizados. O formato externo da notificação e o encerramento ao cliente são preservados; dados internos não são repetidos no encerramento. Não há migração, dependência ou alteração de configuração de empresa.

602 testes locais aprovados, 24 skips opt-in e zero falhas. Três regressões PostgreSQL com o runtime portado e fixtures atuais aprovadas em `waia_v2_upgrade`, incluindo persistência integral, confirmação repetida sem duplicação e preservação das 135 tabelas. A nota não substitui a validação da imagem Linux e o teste com fornecedor real, registrados no relatório ativo da implantação.

Implantação deve reutilizar a imagem homologada e atualizar somente API/worker, preservando painel, banco, Redis, monitor e sessão do remetente de grupos, com backup verificado e rollback por imagem. Não altera nem reenvia fichas anteriores automaticamente.
