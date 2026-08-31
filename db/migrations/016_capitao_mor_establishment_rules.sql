WITH updated_config AS (
  UPDATE configuracoes_empresa AS config
  SET regras_estabelecimento = E'Vestimenta: não é permitida a entrada usando boné, regata, corrente de prata ou camisa de time de futebol.\n\nAniversariante: o aniversariante do mês tem entrada VIP. Se levar até 10 convidados, também terá direito a um acompanhante VIP. Caso contrário, somente o aniversariante terá entrada VIP.',
      regra_aniversariante = 'O aniversariante do mês tem entrada VIP. Se levar até 10 convidados, também terá direito a um acompanhante VIP. Caso contrário, somente o aniversariante terá entrada VIP.',
      updated_at = now()
  FROM empresas AS company
  WHERE company.id = config.empresa_id
    AND company.slug = 'capitao-mor'
    AND config.regras_estabelecimento = ''
  RETURNING config.empresa_id
)
UPDATE empresas AS company
SET versao_configuracao = versao_configuracao + 1,
    updated_at = now()
WHERE company.id IN (SELECT empresa_id FROM updated_config);
