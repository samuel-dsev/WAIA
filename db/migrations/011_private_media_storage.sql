ALTER TABLE mensagens
  ADD COLUMN media_mime_type text,
  ADD COLUMN media_size_bytes bigint,
  ADD COLUMN media_sha256 text,
  ADD COLUMN media_stored_at timestamptz;

ALTER TABLE mensagens
  ADD CONSTRAINT mensagens_media_metadata_check CHECK (
    (media_storage_key IS NULL
      AND media_mime_type IS NULL
      AND media_size_bytes IS NULL
      AND media_sha256 IS NULL
      AND media_stored_at IS NULL)
    OR
    (media_storage_key IS NOT NULL
      AND media_mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
      AND media_size_bytes BETWEEN 1 AND 10485760
      AND media_sha256 ~ '^[a-f0-9]{64}$'
      AND media_stored_at IS NOT NULL)
  ) NOT VALID;

CREATE INDEX mensagens_media_retention_idx
  ON mensagens (empresa_id, expires_at, id)
  WHERE media_storage_key IS NOT NULL AND redacted_at IS NULL;
