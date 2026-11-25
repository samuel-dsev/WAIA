ALTER TABLE mensagens
  ADD COLUMN audio_transcription text,
  ADD COLUMN audio_transcription_status text CHECK (audio_transcription_status IN
    ('processing','completed','failed','uncertain','empty','unsupported','quota_exceeded')),
  ADD COLUMN audio_duration_seconds integer CHECK (audio_duration_seconds BETWEEN 1 AND 1800),
  ADD CONSTRAINT mensagens_audio_transcription_check CHECK (
    audio_transcription IS NULL OR tipo = 'audio' AND direcao = 'entrada'
      AND audio_transcription_status = 'completed' AND length(audio_transcription) BETWEEN 1 AND 8000
  );

ALTER TABLE mensagens DROP CONSTRAINT mensagens_media_metadata_check;
ALTER TABLE mensagens ADD CONSTRAINT mensagens_media_metadata_check CHECK (
  (media_storage_key IS NULL AND media_mime_type IS NULL AND media_size_bytes IS NULL
    AND media_sha256 IS NULL AND media_stored_at IS NULL)
  OR (media_storage_key IS NOT NULL AND media_size_bytes BETWEEN 1 AND 10485760
    AND media_sha256 ~ '^[a-f0-9]{64}$' AND media_stored_at IS NOT NULL
    AND (media_mime_type IN ('image/jpeg','image/png','image/webp','application/pdf')
      OR tipo = 'audio' AND direcao = 'entrada' AND media_mime_type IN
        ('audio/ogg','audio/opus','audio/mpeg','audio/mp4','audio/x-m4a','audio/wav','audio/x-wav','audio/webm','audio/flac')))
) NOT VALID;

CREATE TABLE audio_quota_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  periodo date NOT NULL,
  seconds_used integer NOT NULL DEFAULT 0 CHECK (seconds_used >= 0),
  seconds_reserved integer NOT NULL DEFAULT 0 CHECK (seconds_reserved >= 0),
  monthly_limit_seconds integer NOT NULL DEFAULT 1800 CHECK (monthly_limit_seconds = 1800),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, periodo),
  CHECK (seconds_used + seconds_reserved <= monthly_limit_seconds)
);

CREATE TABLE audio_transcription_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  message_id uuid NOT NULL,
  periodo date NOT NULL,
  seconds integer NOT NULL CHECK (seconds BETWEEN 1 AND 1800),
  status text NOT NULL CHECK (status IN ('reserved','started','completed','failed','uncertain','empty','cancelled')),
  model text NOT NULL DEFAULT 'gpt-transcribe',
  estimated_cost_usd numeric(16,8) NOT NULL DEFAULT 0,
  provider_seconds numeric(12,3),
  pricing_version text NOT NULL DEFAULT 'openai-2026-11-25',
  config_version bigint NOT NULL,
  lease_until timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, message_id),
  FOREIGN KEY (empresa_id, message_id) REFERENCES mensagens(empresa_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, periodo) REFERENCES audio_quota_accounts(empresa_id,periodo) ON DELETE RESTRICT
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['audio_quota_accounts','audio_transcription_usage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation_policy ON %I USING (empresa_id = app_current_empresa_id() OR app_is_platform_admin()) WITH CHECK (empresa_id = app_current_empresa_id() OR app_is_platform_admin())', table_name);
  END LOOP;
END;
$$;
