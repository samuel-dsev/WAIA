import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) {
  let bits=0,value=0,result='';
  for(const byte of bytes) { value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;result+=alphabet[(value>>>bits)&31];} }
  if(bits) result+=alphabet[(value<<(5-bits))&31];
  return result;
}
export const newTotpSecret = () => randomBytes(20);
// RFC 6238 / RFC 4226: SHA-1, 30 segundos, seis digitos para autenticadores comuns.
export function totp(secret, counter, digits=6) {
  const moving=Buffer.alloc(8); moving.writeBigUInt64BE(BigInt(counter));
  const mac=createHmac('sha1',secret).update(moving).digest(), offset=mac[mac.length-1]&15;
  return String((mac.readUInt32BE(offset)&0x7fffffff) % (10**digits)).padStart(digits,'0');
}
export function verifyTotp(secret, code, now, lastCounter=-1) {
  if(typeof code!=='string'||!/^\d{6}$/.test(code)) return null;
  const counter=Math.floor(new Date(now).getTime()/30000);
  for(const step of [counter,counter-1,counter+1]) {
    if(step>=0 && step>Number(lastCounter??-1) && timingSafeEqual(Buffer.from(totp(secret,step)),Buffer.from(code))) return step;
  }
  return null;
}
