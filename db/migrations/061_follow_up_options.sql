-- Optional templates for reactivating old conversations outside the 24h window.
-- Approval is queried from the provider at dispatch time, never asserted here.
ALTER TABLE follow_up_settings ADD COLUMN templates jsonb NOT NULL DEFAULT '[null,null,null,null]'::jsonb
  CHECK(jsonb_typeof(templates)='array' AND jsonb_array_length(templates)<=20);
ALTER TABLE follow_up_settings ADD COLUMN periods_hours double precision[] NOT NULL DEFAULT '{2,24,48,72}'
  CHECK(cardinality(periods_hours)<=20 AND 0<ALL(periods_hours));
ALTER TABLE follow_up_settings ADD COLUMN close_after_hours double precision NOT NULL DEFAULT 96 CHECK(close_after_hours>0 AND close_after_hours<=8760);
ALTER TABLE follow_up_cycles ADD COLUMN periods_hours double precision[] NOT NULL DEFAULT '{2,24,48,72}';
ALTER TABLE follow_up_cycles ADD COLUMN close_after_hours double precision NOT NULL DEFAULT 96;
UPDATE follow_up_settings SET periods_hours=ARRAY[2.0/60,5.0/60,10.0/60,15.0/60],close_after_hours=20.0/60 WHERE profile='test';
UPDATE follow_up_cycles SET periods_hours=ARRAY[2.0/60,5.0/60,10.0/60,15.0/60],close_after_hours=20.0/60 WHERE profile='test';
ALTER TABLE follow_up_settings DROP CONSTRAINT follow_up_settings_profile_check;
ALTER TABLE follow_up_settings ADD CHECK(profile IN ('test','standard','custom'));
ALTER TABLE follow_up_cycles DROP CONSTRAINT follow_up_cycles_profile_check;
ALTER TABLE follow_up_cycles ADD CHECK(profile IN ('test','standard','custom'));
ALTER TABLE follow_up_actions DROP CONSTRAINT follow_up_actions_slot_check;
ALTER TABLE follow_up_actions ADD CHECK(slot BETWEEN 0 AND 20);
ALTER TABLE follow_up_actions ADD COLUMN is_closure boolean NOT NULL DEFAULT false;
UPDATE follow_up_actions SET is_closure=true WHERE slot=4;
