// Existing stable installations use an explicit platform-authorized pilot,
// without importing the candidate's product-policy, portal or central AI stack.
export async function readChannelExecutionGate(client,{empresaId,numberId}) {
  const result=await client.query(`SELECT 1 FROM numeros_whatsapp n JOIN empresas e ON e.id=n.empresa_id
    WHERE n.empresa_id=$1 AND n.id=$2 AND n.status='ativo' AND n.deleted_at IS NULL AND e.status='ativa' AND e.deleted_at IS NULL`,[empresaId,numberId]);
  return {managed:false,allowed:result.rowCount>0};
}
