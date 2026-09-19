ALTER TABLE notification_deliveries ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

-- No application query filters deliveries by status. These indexes amplified
-- every provider callback without helping either history or alert sending.
DROP INDEX IF EXISTS idx_notification_deliveries_channel_status;
DROP INDEX IF EXISTS idx_notification_deliveries_provider_status;
DROP INDEX IF EXISTS idx_notification_deliveries_provider;
CREATE INDEX idx_notification_deliveries_provider
  ON notification_deliveries(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX idx_notification_deliveries_destination_channel
  ON notification_deliveries(destination_hash, channel) WHERE destination_hash IS NOT NULL;

DROP INDEX IF EXISTS idx_notification_signups_status;
CREATE INDEX idx_notification_signups_status ON notification_signups(status, id);
CREATE INDEX idx_notification_signups_admin_order ON notification_signups(
  CASE status WHEN 'active' THEN 0 WHEN 'pending_checkout' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END,
  updated_at DESC, id ASC
);
CREATE INDEX idx_notification_signups_searchable ON notification_signups(id)
  WHERE email_cipher IS NOT NULL OR account_email_cipher IS NOT NULL OR phone_cipher IS NOT NULL;
DROP INDEX IF EXISTS idx_notification_alerts_kind_created;
CREATE INDEX idx_notification_alerts_created ON notification_alerts(created_at DESC);

-- One durable campaign at a time. Completed campaigns remain in notification_alerts.
CREATE TABLE notification_alert_jobs (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  alert_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  dispatch_after INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

-- After a sender finalizes an alert, maintain counts only if their contribution
-- actually changes. sent -> delivered and duplicate callbacks write no counters.
CREATE TRIGGER notification_delivery_count_change
AFTER UPDATE OF status ON notification_deliveries
WHEN OLD.status != NEW.status AND (
  (OLD.status IN ('sent','delivered')) != (NEW.status IN ('sent','delivered')) OR
  (OLD.status IN ('failed','undelivered','unknown','unconfirmed')) !=
    (NEW.status IN ('failed','undelivered','unknown','unconfirmed'))
)
BEGIN
  UPDATE notification_alerts SET
    email_sent_count = email_sent_count + (NEW.channel = 'email') *
      ((NEW.status IN ('sent','delivered')) - (OLD.status IN ('sent','delivered'))),
    sms_sent_count = sms_sent_count + (NEW.channel = 'sms') *
      ((NEW.status IN ('sent','delivered')) - (OLD.status IN ('sent','delivered'))),
    error_count = MAX(0, error_count +
      (NEW.status IN ('failed','undelivered','unknown','unconfirmed')) -
      (OLD.status IN ('failed','undelivered','unknown','unconfirmed'))),
    status = CASE WHEN NEW.status IN ('failed','undelivered','unknown','unconfirmed')
      THEN 'completed_with_errors'
      WHEN error_count + (NEW.status IN ('failed','undelivered','unknown','unconfirmed'))
        - (OLD.status IN ('failed','undelivered','unknown','unconfirmed')) <= 0
        AND status = 'completed_with_errors' THEN 'sent' ELSE status END,
    updated_at = NEW.updated_at
  WHERE id = NEW.alert_id AND status NOT IN ('created','sending','queued');
END;
