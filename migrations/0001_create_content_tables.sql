CREATE TABLE content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type IN ('product', 'collection', 'article')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  image_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  CHECK (slug = lower(slug)),
  CHECK (slug NOT GLOB '-*' AND slug NOT GLOB '*-' AND slug NOT GLOB '*--*' AND slug NOT GLOB '*[^a-z0-9-]*')
);

CREATE INDEX idx_content_type_status ON content(content_type, status);

CREATE TABLE collections (
  content_id INTEGER PRIMARY KEY REFERENCES content(id) ON DELETE CASCADE,
  tagline TEXT,
  introduction TEXT NOT NULL DEFAULT '',
  ideas_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ideas_json)),
  closing TEXT NOT NULL DEFAULT ''
);

CREATE TABLE products (
  content_id INTEGER PRIMARY KEY REFERENCES content(id) ON DELETE CASCADE,
  collection_id INTEGER REFERENCES collections(content_id) ON DELETE SET NULL,
  product_type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  book_format TEXT NOT NULL DEFAULT '',
  page_count INTEGER CHECK (page_count IS NULL OR page_count > 0),
  cover_text TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options_json)),
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1))
);

CREATE INDEX idx_products_collection ON products(collection_id);
CREATE INDEX idx_products_featured ON products(featured);

CREATE TRIGGER collections_require_collection_content
BEFORE INSERT ON collections
WHEN (SELECT content_type FROM content WHERE id = NEW.content_id) != 'collection'
BEGIN
  SELECT RAISE(ABORT, 'content row must have type collection');
END;

CREATE TRIGGER products_require_product_content
BEFORE INSERT ON products
WHEN (SELECT content_type FROM content WHERE id = NEW.content_id) != 'product'
BEGIN
  SELECT RAISE(ABORT, 'content row must have type product');
END;
