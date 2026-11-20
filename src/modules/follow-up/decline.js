import { declinesFollowUp, AVAILABILITY_MESSAGE } from './policy.js';

// Separate from the normal stable reply dispatcher. Only a reply to an accepted
// opt-in follow-up can mint this paused-conversation courtesy checkpoint.
export async function handleFollowUpDecline(repository,{empresaId,message,metaGateway,canContinue}) {
  const proof=await repository.tenant(empresaId,async client=>{
    const existing=(await client.query(`SELECT id,external_message_id,outbound_payload FROM mensagens WHERE empresa_id=$1 AND source_message_id=$2 AND direcao='saida'`,[empresaId,message.id])).rows[0];
    if(existing&&!existing.outbound_payload?.followUpDecline)return null;
    const cycle=existing?null:await repository.lastCycle(client,empresaId,message.conversationId);
    if(!existing&&(!cycle?.enabled||cycle.state!=='active'))return null;
    await client.query('SELECT id FROM empresas WHERE id=$1 FOR SHARE',[empresaId]);
    const c=await repository.conversation(client,empresaId,message.conversationId,true);
    if(!c)return null;
    if(existing)return{replyId:existing.id};
    const settings=await repository.settings(client,empresaId),config=await repository.activeConfiguration(client,empresaId);
    if(!settings.enabled||!config||c.modo_atendimento!=='bot'||c.bot_pausado||c.bloqueado)return null;
    const last=(await client.query(`SELECT m.corpo,a.cycle_id,a.state FROM mensagens m LEFT JOIN follow_up_actions a ON a.empresa_id=m.empresa_id AND a.message_id=m.id
      WHERE m.empresa_id=$1 AND m.conversa_id=$2 AND m.sequence<$3 AND m.redacted_at IS NULL AND m.direcao='saida'
        AND m.status IN ('enviada','entregue','lida') ORDER BY m.sequence DESC LIMIT 1`,[empresaId,c.id,message.sequence])).rows[0];
    if(!last||last.cycle_id!==cycle.id||last.state!=='accepted'||!declinesFollowUp(message.text,last.corpo))return null;
    if((await client.query(`SELECT 1 FROM mensagens WHERE empresa_id=$1 AND conversa_id=$2 AND direcao='entrada' AND sequence>$3 AND redacted_at IS NULL LIMIT 1`,[empresaId,c.id,message.sequence])).rowCount)return null;
    await repository.cancel(client,empresaId,cycle.id,'CUSTOMER_DECLINED','declined');
    const paused=(await client.query(`UPDATE conversas SET modo_atendimento='pausado',lock_version=lock_version+1,next_sequence=next_sequence+1,updated_at=now()
      WHERE empresa_id=$1 AND id=$2 AND modo_atendimento='bot' RETURNING lock_version,next_sequence-1 AS sequence`,[empresaId,c.id])).rows[0];
    const row=(await client.query(`INSERT INTO mensagens(empresa_id,conversa_id,contato_id,numero_whatsapp_id,direcao,tipo,corpo,status,origem_resposta,sequence,correlation_id,source_message_id,outbound_payload)
      VALUES($1,$2,$3,$4,'saida','texto',$5,'enfileirada','fluxo_deterministico',$6,$7,$8,$9::jsonb) RETURNING id`,
      [empresaId,c.id,c.contato_id,c.numero_whatsapp_id,AVAILABILITY_MESSAGE,paused.sequence,message.correlationId,message.id,
        JSON.stringify({followUpDecline:{pauseVersion:Number(paused.lock_version),sourceSequence:message.sequence,configVersion:Number(config.version),dispatchState:'pending'}})])).rows[0];
    await repository.audit(client,empresaId,null,'follow_up.declined',c.id);
    return{replyId:row.id};
  });
  if(!proof)return null;
  if(canContinue&&!canContinue())return{deferUntil:new Date(+repository.clock()+30000).toISOString()};
  const claim=await repository.tenant(empresaId,async client=>{
    await client.query('SELECT id FROM empresas WHERE id=$1 FOR SHARE',[empresaId]);
    const c=await repository.conversation(client,empresaId,message.conversationId,true);
    const m=(await client.query('SELECT * FROM mensagens WHERE empresa_id=$1 AND id=$2 FOR UPDATE',[empresaId,proof.replyId])).rows[0];
    if(m?.external_message_id)return{sent:true};
    const envelope=m?.outbound_payload?.followUpDecline;
    if(!envelope)return{blocked:true};
    if(['started','uncertain'].includes(envelope.dispatchState)){
      await client.query(`UPDATE mensagens SET outbound_payload=jsonb_set(outbound_payload,'{followUpDecline,dispatchState}','"uncertain"'),error_code='FOLLOW_UP_DECLINE_UNCERTAIN' WHERE empresa_id=$1 AND id=$2`,[empresaId,m.id]);return{uncertain:true};
    }
    const config=await repository.activeConfiguration(client,empresaId),settings=await repository.settings(client,empresaId);
    const source=(await client.query(`SELECT coalesce(provider_timestamp,created_at) AS time FROM mensagens WHERE empresa_id=$1 AND id=$2 AND redacted_at IS NULL AND (expires_at IS NULL OR expires_at>$3)
      AND NOT EXISTS(SELECT 1 FROM mensagens n WHERE n.empresa_id=$1 AND n.conversa_id=$4 AND n.direcao='entrada' AND n.sequence>$5 AND n.redacted_at IS NULL)`,[empresaId,message.id,repository.clock(),message.conversationId,envelope.sourceSequence])).rows[0];
    const available=c&&c.modo_atendimento==='pausado'&&!c.operador_usuario_id&&Number(c.lock_version)===envelope.pauseVersion&&c.status==='aberta'
      &&!c.bot_pausado&&!c.bloqueado&&c.consentimento_status!=='revogado'&&!c.exclusao_solicitada_at&&c.number_status==='ativo'&&!c.number_deleted
      &&settings.enabled&&Number(config?.version)===envelope.configVersion&&source&&new Date(source.time)<=repository.clock()&&+repository.clock()-+new Date(source.time)<86400000
      &&!m.redacted_at&&(!m.expires_at||new Date(m.expires_at)>repository.clock())&&m.status==='enfileirada';
    if(!available){await client.query("UPDATE mensagens SET status='ignorada_duplicidade' WHERE empresa_id=$1 AND id=$2",[empresaId,m.id]);return{blocked:true};}
    await client.query(`UPDATE mensagens SET outbound_payload=jsonb_set(outbound_payload,'{followUpDecline,dispatchState}','"started"'),status='processando',processing_at=now() WHERE empresa_id=$1 AND id=$2`,[empresaId,m.id]);
    return{allowed:true,to:c.phone,text:m.corpo,numberId:c.numero_whatsapp_id};
  });
  if(!claim.allowed)return{replied:claim.sent===true,skipped:!claim.sent,reconciliationRequired:claim.uncertain===true};
  let id=null;try{const sent=await metaGateway.sendReply({empresaId,numeroWhatsappId:claim.numberId},{to:claim.to,text:claim.text});id=sent?.messages?.[0]?.id||null;}catch{/* Never repeat a send with unknown external outcome. */}
  await repository.tenant(empresaId,client=>client.query(`UPDATE mensagens SET external_message_id=$3,status=$4,sent_at=CASE WHEN $3::text IS NOT NULL THEN now() ELSE sent_at END,
    outbound_payload=jsonb_set(outbound_payload,'{followUpDecline,dispatchState}',to_jsonb($5::text)),error_code=$6 WHERE empresa_id=$1 AND id=$2 AND external_message_id IS NULL`,
    [empresaId,proof.replyId,id,id?'enviada':'processando',id?'accepted':'uncertain',id?null:'FOLLOW_UP_DECLINE_UNCERTAIN']));
  return{replied:Boolean(id),reconciliationRequired:!id};
}
