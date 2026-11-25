import { parseBuffer } from 'music-metadata';

export const AUDIO_MONTHLY_SECONDS = 1800;
export const AUDIO_MODEL = 'gpt-transcribe';
export const AUDIO_PRICE_PER_MINUTE_USD = 0.0045;
export const AUDIO_MAX_BYTES = 10 * 1024 * 1024;
export const AUDIO_MIME_EXTENSIONS = Object.freeze({
  'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/flac': 'flac',
});
export const AUDIO_MIME_TYPES = Object.freeze(Object.keys(AUDIO_MIME_EXTENSIONS));

export function audioError(code) {
  return Object.assign(new Error('Não foi possível processar este áudio.'), { code, retryable: false });
}

/** Measure the downloaded bytes, never a duration supplied by the sender. */
export async function inspectAudio(data, mimeType) {
  if (!Buffer.isBuffer(data) || data.length < 12 || data.length > AUDIO_MAX_BYTES) throw audioError('AUDIO_SIZE_INVALID');
  const extension = AUDIO_MIME_EXTENSIONS[mimeType];
  if (!extension) throw audioError('AUDIO_FORMAT_UNSUPPORTED');
  const magic = extension === 'ogg' ? data.subarray(0,4).toString() === 'OggS'
    : extension === 'wav' ? data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WAVE'
    : extension === 'm4a' ? data.subarray(4,8).toString() === 'ftyp'
    : extension === 'flac' ? data.subarray(0,4).toString() === 'fLaC'
    : extension === 'webm' ? data.readUInt32BE(0) === 0x1a45dfa3
    : data.subarray(0,3).toString() === 'ID3' || data.length > 1 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0;
  if (!magic) throw audioError('AUDIO_FORMAT_UNSUPPORTED');
  let metadata;
  try { metadata = await parseBuffer(data, { mimeType, size: data.length }, { duration: true, skipCovers: true }); }
  catch { throw audioError('AUDIO_DURATION_INVALID'); }
  const seconds = Math.ceil(metadata.format.duration);
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw audioError('AUDIO_DURATION_INVALID');
  if (seconds > AUDIO_MONTHLY_SECONDS) throw audioError('AUDIO_TOO_LONG');
  return { seconds, extension };
}

export function audioFallback(status) {
  if (status === 'quota_exceeded') return 'O limite mensal de áudio deste atendimento foi atingido. Pode enviar sua mensagem por texto para continuarmos?';
  if (status === 'unsupported') return 'Não consegui ler esse arquivo de áudio. Envie uma mensagem de voz ou escreva sua mensagem para continuarmos.';
  return 'Não consegui transcrever esse áudio com segurança. Pode enviar sua mensagem por texto para continuarmos?';
}
