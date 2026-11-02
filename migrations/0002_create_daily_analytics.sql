CREATE TABLE analytics_daily (
  event_date TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('page_view', 'whatsapp_click')),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  PRIMARY KEY (event_date, event_type)
);

CREATE INDEX idx_analytics_daily_date ON analytics_daily(event_date);
