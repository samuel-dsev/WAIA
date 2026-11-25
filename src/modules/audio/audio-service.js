import OpenAI, { toFile } from 'openai';
import { normalizeAiConfig } from '../ai/contracts.js';
import { AUDIO_MAX_BYTES, AUDIO_MIME_TYPES, AUDIO_MIME_EXTENSIONS, AUDIO_MODEL, inspectAudio } from './audio-policy.js';

export class OpenAiAudioClient {
  async transcribe({ apiKey, data, extension, mimeType }) {
    // Retrying a timed-out POST could bill the same audio again. Recovery is
    // driven by the durable dispatch claim, never by SDK automatic retries.
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 90_000 });
    return client.audio.transcriptions.create({ model: AUDIO_MODEL,
      file: await toFile(data, `audio.${extension}`, { type: mimeType }), response_format: 'json' }, { maxRetries: 0 });
  }
}

export class AudioTranscriptionService {
  constructor({ repository, messageRepository, configResolver, secretResolver, metaGateway, mediaStore,
    client = new OpenAiAudioClient(), inspect = inspectAudio }) {
    Object.assign(this, { repository, messageRepository, configResolver, secretResolver, metaGateway, mediaStore, client, inspect });
  }

  async transcribe({ empresaId, message, canContinue = () => true }) {
    const config = normalizeAiConfig(await this.configResolver.getAiConfig({ empresaId }), empresaId);
    const input = { empresaId, messageId: message.id, configVersion: config.version };
    if (!config.enabled || !config.audioTranscriptionEnabled || config.provider !== 'openai' || !canContinue()
      || !await this.repository.eligible(input)) {
      await this.repository.cancelPending?.(input);
      return { blocked: true };
    }
    if (message.audioTranscriptionStatus && message.audioTranscriptionStatus !== 'processing') {
      return { status: message.audioTranscriptionStatus, text: message.audioTranscription || null };
    }
    let credential;
    try { credential = await this.secretResolver.resolve({ empresaId, provider: config.provider, keyType: config.keyType, credentialId: config.credentialId }); }
    catch { return this.repository.reject(input, 'failed'); }
    if (!credential?.apiKey) return this.repository.reject(input, 'failed');
    let data, mimeType, inspected;
    try {
      mimeType = message.mediaMimeType;
      if (message.mediaStorageKey) {
        data = await this.mediaStore.read({ empresaId, storageKey: message.mediaStorageKey, expectedSha256: message.mediaSha256 });
      } else {
        if (!message.mediaId) return this.repository.reject(input, 'unsupported');
        const download = await this.metaGateway.downloadMedia({ empresaId, numeroWhatsappId: message.numeroWhatsappId }, {
          mediaId: message.mediaId, ...(message.providerMedia ? { providerMedia: message.providerMedia } : {}),
          maxBytes: AUDIO_MAX_BYTES, allowedMimeTypes: AUDIO_MIME_TYPES,
        });
        data = download.data;
        mimeType = download.mimeType;
      }
      inspected = await this.inspect(data, mimeType);
    } catch (error) {
      const unsupported = /(?:FORMAT|MIME|SIZE|TOO_LARGE|TOO_LONG|DURATION)/u.test(error?.code || '');
      return this.repository.reject(input, unsupported ? 'unsupported' : 'failed');
    }
    if (!canContinue() || !await this.repository.eligible(input)) {
      await this.repository.cancelPending?.(input);
      return { blocked: true };
    }
    if (!message.mediaStorageKey) {
      const stored = await this.mediaStore.put({ empresaId, messageId: message.id, data, mimeType });
      try { await this.messageRepository.markMediaStored({ empresaId, messageId: message.id, mediaId: message.mediaId, stored }); }
      catch (error) { await this.mediaStore.delete({ empresaId, storageKey: stored.storageKey }).catch(() => {}); throw error; }
    }
    const reservation = await this.repository.reserve({ ...input, seconds: inspected.seconds });
    if (!reservation.allowed) return reservation;
    input.reservationId = reservation.reservationId;
    if (!canContinue()) { await this.repository.cancelPending?.(input); return { blocked: true }; }
    if (!await this.repository.start(input)) return this.repository.reserve({ ...input, seconds: inspected.seconds });
    if (!canContinue()) return this.repository.finish(input, { status: 'failed' });
    let result;
    try {
      result = await this.client.transcribe({ apiKey: credential.apiKey, data, mimeType,
        extension: inspected.extension || AUDIO_MIME_EXTENSIONS[mimeType] });
    } catch (error) {
      const definiteFailure = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && error.status !== 408;
      return this.repository.finish(input, { status: definiteFailure ? 'failed' : 'uncertain' });
    }
    const providerSeconds = result?.usage?.type === 'duration' && Number.isFinite(result.usage.seconds)
      && result.usage.seconds >= 0 && result.usage.seconds < 1_000_000 ? result.usage.seconds : null;
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    const status = !text ? 'empty' : text.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ? 'failed' : 'completed';
    // finish revalidates company configuration, privacy, and human ownership.
    return this.repository.finish(input, { status, text, providerSeconds });
  }
}
