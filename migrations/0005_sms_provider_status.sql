ALTER TABLE notification_deliveries ADD COLUMN provider_status TEXT;

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_channel_status
  ON notification_deliveries (channel, status);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_provider_status
  ON notification_deliveries (provider_status);
