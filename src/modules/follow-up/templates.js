import { createHash } from 'node:crypto';

export function approvedFollowUpTemplate(data, { name, language }, wabaId) {
  if (!data || data.status !== 'APPROVED' || data.name !== name || data.language !== language
    || data.category !== 'MARKETING' || data.wabaId && String(data.wabaId) !== String(wabaId)) return null;
  const components = data.components;
  if (!Array.isArray(components) || components.some(c => !['BODY','FOOTER'].includes(c.type))) return null;
  const body = components.find(c => c.type === 'BODY')?.text, footer = components.find(c => c.type === 'FOOTER')?.text || '';
  if (typeof body !== 'string' || body.length > 2000 || footer.includes('{{') || (body.match(/\{\{\s*1\s*\}\}/gu) || []).length !== 1
    || body.replace(/\{\{\s*1\s*\}\}/gu, '').includes('{{')) return null;
  const template = { name, language, wabaId: String(wabaId), body, footer };
  return { ...template, fingerprint: createHash('sha256').update(JSON.stringify(template)).digest('hex') };
}
export function templatePayload(template, text) {
  return { name: template.name, language: { code: template.language }, components: [{ type: 'body', parameters: [{ type: 'text', text }] }] };
}
