-- Additive observation only. Historical rows remain unknown; quotas are unchanged.
ALTER TABLE uso_ia
  ADD COLUMN cached_input_tokens integer,
  ADD COLUMN cache_write_input_tokens integer,
  ADD COLUMN cache_adjusted_cost numeric(16, 8),
  ADD CONSTRAINT uso_ia_cached_input_bounds CHECK (cached_input_tokens BETWEEN 0 AND input_tokens),
  ADD CONSTRAINT uso_ia_cache_write_bounds CHECK (cache_write_input_tokens BETWEEN 0 AND input_tokens),
  ADD CONSTRAINT uso_ia_cache_input_total CHECK (cached_input_tokens + cache_write_input_tokens <= input_tokens),
  ADD CONSTRAINT uso_ia_cache_cost_nonnegative CHECK (cache_adjusted_cost >= 0);
