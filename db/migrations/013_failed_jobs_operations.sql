ALTER TABLE jobs_falhos
  ADD COLUMN outbox_job_id uuid,
  ADD COLUMN resolved_by_usuario_id uuid,
  ADD COLUMN resolution_kind text,
  ADD COLUMN resolution_note text,
  ADD COLUMN retry_job_id uuid;

UPDATE jobs_falhos
   SET outbox_job_id = (payload_sanitized ->> 'jobId')::uuid
 WHERE payload_sanitized ->> 'jobId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE jobs_falhos
   SET resolution_kind = 'legado',
       resolution_note = 'Resolução anterior à gestão operacional.'
 WHERE resolved_at IS NOT NULL;

ALTER TABLE jobs_falhos
  ADD CONSTRAINT jobs_falhos_outbox_fkey
    FOREIGN KEY (empresa_id, outbox_job_id)
    REFERENCES outbox_jobs (empresa_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT jobs_falhos_resolved_by_fkey
    FOREIGN KEY (resolved_by_usuario_id)
    REFERENCES usuarios (id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT jobs_falhos_retry_job_fkey
    FOREIGN KEY (empresa_id, retry_job_id)
    REFERENCES outbox_jobs (empresa_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT jobs_falhos_resolution_check CHECK (
    (
      resolved_at IS NULL
      AND resolved_by_usuario_id IS NULL
      AND resolution_kind IS NULL
      AND resolution_note IS NULL
      AND retry_job_id IS NULL
    )
    OR (
      resolved_at IS NOT NULL
      AND resolution_kind = 'legado'
      AND resolved_by_usuario_id IS NULL
      AND resolution_note IS NOT NULL
      AND retry_job_id IS NULL
    )
    OR (
      resolved_at IS NOT NULL
      AND resolved_by_usuario_id IS NOT NULL
      AND resolution_kind = 'resolvido'
      AND resolution_note IS NOT NULL
      AND retry_job_id IS NULL
    )
    OR (
      resolved_at IS NOT NULL
      AND resolved_by_usuario_id IS NOT NULL
      AND resolution_kind = 'reenfileirado'
      AND resolution_note IS NOT NULL
      AND retry_job_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT jobs_falhos_resolution_note_check CHECK (
    resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 1000
  );

CREATE INDEX jobs_falhos_outbox_idx
  ON jobs_falhos (empresa_id, outbox_job_id);

CREATE INDEX jobs_falhos_resolvidos_idx
  ON jobs_falhos (empresa_id, resolved_at DESC, id)
  WHERE resolved_at IS NOT NULL;
