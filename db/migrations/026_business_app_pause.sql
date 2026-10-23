-- Barrier against delayed phone-app echoes after an explicit bot resume.
ALTER TABLE conversas ADD COLUMN business_app_resumed_at timestamptz;
