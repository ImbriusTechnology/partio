-- Partio Inventory: initial schema.
-- Applied once by the app (src-tauri/src/db.rs) and by the tests (tests/lib/db.ts), recorded in _migrations.
-- Rules the code keeps:
--   * stock changes only by inserting into stock_txn; a trigger keeps `stock` in step
--   * PNs are always TEXT ('00042', never 42)
--   * costs are stored in the base currency (setting 'base_currency')
--   * rows loaded from the demo library carry source = 'demo' so they can be removed later

-- ---------- Reference data ----------
CREATE TABLE category (
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER REFERENCES category(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,          -- 'Passive > Resistor', maintained by the app
  ref_prefix  TEXT,                          -- default designator, e.g. 'R', 'C', 'U'
  sort_order  INTEGER NOT NULL DEFAULT 0,
  source      TEXT,                          -- 'demo' for demo rows, else NULL
  UNIQUE (parent_id, name)
);

-- Parametric fields defined per category; children inherit their ancestors' attributes
CREATE TABLE attribute_def (
  id           INTEGER PRIMARY KEY,
  category_id  INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,                -- 'power', 'voltage', 'dielectric'
  label        TEXT NOT NULL,                -- 'Power rating'
  kind         TEXT NOT NULL CHECK (kind IN ('number','text','enum','bool')),
  unit         TEXT,                         -- 'W', 'V', 'ppm/°C'
  enum_values  TEXT,                         -- JSON array when kind = 'enum'
  sort_order   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (category_id, key)
);

CREATE TABLE package (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- canonical, e.g. '0805', 'SOT-23-3'
  mount  TEXT CHECK (mount IN ('SMD','TH','other'))
);
CREATE TABLE package_alias (                     -- '2012M' -> '0805', 'SOT23' -> 'SOT-23-3'
  alias       TEXT PRIMARY KEY COLLATE NOCASE,
  package_id  INTEGER NOT NULL REFERENCES package(id) ON DELETE CASCADE,
  is_metric   INTEGER NOT NULL DEFAULT 0       -- 1 = the metric name, shown as '0805 (2012 metric)'
);

CREATE TABLE manufacturer (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  website  TEXT
);
CREATE TABLE manufacturer_alias (                -- 'Yageo Group' -> 'Yageo'
  alias            TEXT PRIMARY KEY COLLATE NOCASE,
  manufacturer_id  INTEGER NOT NULL REFERENCES manufacturer(id) ON DELETE CASCADE
);

CREATE TABLE vendor (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  website        TEXT,
  currency       TEXT NOT NULL DEFAULT 'USD',
  api_connector  TEXT CHECK (api_connector IN ('digikey','mouser','element14','lcsc')),
  cart_format    TEXT,                       -- export template for cart-upload CSV
  notes          TEXT,
  active         INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE vendor_alias (                      -- 'Digi-Key' -> 'DigiKey'
  alias      TEXT PRIMARY KEY COLLATE NOCASE,
  vendor_id  INTEGER NOT NULL REFERENCES vendor(id) ON DELETE CASCADE
);

-- ---------- Numbering ----------
-- One series to start: 5 digits, no prefix. The table allows more later.
CREATE TABLE pn_series (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL DEFAULT '',
  width       INTEGER NOT NULL,              -- digits after the prefix
  range_start INTEGER NOT NULL,
  range_end   INTEGER NOT NULL,
  next_value  INTEGER NOT NULL,
  retired     INTEGER NOT NULL DEFAULT 0,
  CHECK (range_start <= next_value AND next_value <= range_end + 1)
);
INSERT INTO pn_series (name, prefix, width, range_start, range_end, next_value)
VALUES ('Parts', '', 5, 1, 99999, 1);

-- ---------- Locations ----------
CREATE TABLE location (
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER REFERENCES location(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,                  -- 'Bin 01'
  path        TEXT NOT NULL UNIQUE,           -- 'Cabinet A > Drawer 1 > Bin 01', maintained by the app
  code        TEXT NOT NULL UNIQUE,           -- short barcode value, e.g. 'L0001'
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,     -- used locations are archived, not deleted
  source      TEXT,
  UNIQUE (parent_id, name)
);

-- ---------- Parts ----------
CREATE TABLE part (
  id                   INTEGER PRIMARY KEY,
  pn                   TEXT NOT NULL UNIQUE,  -- '00042'; always text
  series_id            INTEGER REFERENCES pn_series(id),
  kind                 TEXT NOT NULL DEFAULT 'component'
                         CHECK (kind IN ('component','pcb','assembly','mechanical','consumable')),
  category_id          INTEGER REFERENCES category(id),
  name                 TEXT,                  -- short name: the generic number (LM358) or a brief label
  description          TEXT NOT NULL DEFAULT '',
  value_text           TEXT,                  -- as typed: '4K7', '100n'
  value_num            REAL,                  -- SI base units: 4700, 1e-7
  value_unit           TEXT,                  -- 'Ω', 'F', 'H', 'Hz', 'V'
  tolerance_pct        REAL,                  -- 1, 0.1, 20
  package_id           INTEGER REFERENCES package(id),
  default_location_id  INTEGER REFERENCES location(id),
  preferred_vendor_id  INTEGER REFERENCES vendor(id),
  reorder_level        INTEGER,               -- reserved for reorder alerts
  unit                 TEXT NOT NULL DEFAULT 'each',
  standard_cost        REAL,                  -- per unit, in base currency
  notes                TEXT,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','obsolete','archived')),
  merged_into_id       INTEGER REFERENCES part(id),  -- set when this part was merged into another and archived
  source               TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (merged_into_id IS NULL OR status = 'archived')
);
CREATE INDEX part_category ON part(category_id);
CREATE INDEX part_param ON part(category_id, package_id, value_num, tolerance_pct);

CREATE TABLE part_attribute (
  part_id    INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  attr_id    INTEGER NOT NULL REFERENCES attribute_def(id) ON DELETE CASCADE,
  value_text TEXT,
  value_num  REAL,
  PRIMARY KEY (part_id, attr_id)
);
CREATE INDEX part_attribute_num ON part_attribute(attr_id, value_num);

CREATE TABLE mfr_part (
  id               INTEGER PRIMARY KEY,
  part_id          INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  manufacturer_id  INTEGER NOT NULL REFERENCES manufacturer(id),
  mpn              TEXT,                      -- NULL = not known yet (bought by vendor code)
  description      TEXT,
  datasheet_url    TEXT,
  lifecycle        TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','nrnd','obsolete','unknown')),
  preferred        INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  UNIQUE (manufacturer_id, mpn)
);
CREATE INDEX mfr_part_part ON mfr_part(part_id);
CREATE INDEX mfr_part_mpn ON mfr_part(mpn COLLATE NOCASE);
CREATE UNIQUE INDEX mfr_part_one_preferred ON mfr_part(part_id) WHERE preferred = 1;

CREATE TABLE vendor_part (
  id                INTEGER PRIMARY KEY,
  mfr_part_id       INTEGER NOT NULL REFERENCES mfr_part(id) ON DELETE CASCADE,
  vendor_id         INTEGER NOT NULL REFERENCES vendor(id),
  sku               TEXT NOT NULL,
  url               TEXT,
  packaging         TEXT,                     -- 'Cut Tape', 'Reel', 'Bag'
  moq               INTEGER,
  order_multiple    INTEGER,
  currency          TEXT,                     -- NULL = the vendor's currency
  preferred         INTEGER NOT NULL DEFAULT 0,
  prices_checked_at TEXT,
  notes             TEXT,
  UNIQUE (vendor_id, sku),
  CHECK (currency IS NULL OR currency GLOB '[A-Z][A-Z][A-Z]')
);
CREATE INDEX vendor_part_mfr ON vendor_part(mfr_part_id);

CREATE TABLE price_break (
  vendor_part_id  INTEGER NOT NULL REFERENCES vendor_part(id) ON DELETE CASCADE,
  qty             INTEGER NOT NULL,
  unit_price      REAL NOT NULL,             -- in the vendor part's currency
  PRIMARY KEY (vendor_part_id, qty)
);

-- ---------- Assemblies, BOMs, builds ----------
CREATE TABLE bom_rev (
  id           INTEGER PRIMARY KEY,
  part_id      INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,  -- the assembly or PCB
  rev          TEXT NOT NULL,                 -- 'A', 'B'
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','released','obsolete')),
  project_code TEXT,                          -- the user's own project reference, if any
  source_file  TEXT,                          -- name of the file it was imported from
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (part_id, rev)
);

CREATE TABLE bom_line (
  id             INTEGER PRIMARY KEY,
  bom_rev_id     INTEGER NOT NULL REFERENCES bom_rev(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL,
  part_id        INTEGER REFERENCES part(id),  -- NULL while unresolved
  pn_as_imported TEXT,                         -- what the file said, kept for matching later
  mpn_as_imported TEXT,
  qty            REAL NOT NULL,
  designators    TEXT,                         -- 'R1, R3, R9'
  dnp            INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  UNIQUE (bom_rev_id, line_no)
);
CREATE INDEX bom_line_part ON bom_line(part_id);

CREATE TABLE build (
  id                 INTEGER PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,    -- 'B0001'
  bom_rev_id         INTEGER NOT NULL REFERENCES bom_rev(id),
  qty                INTEGER NOT NULL CHECK (qty > 0),
  status             TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','picked','complete','cancelled')),
  output_location_id INTEGER REFERENCES location(id),
  planned_for        TEXT,
  completed_at       TEXT,
  notes              TEXT,
  source             TEXT
);

-- What was actually used, including substitutes; written when a build completes.
-- Keeps its own copy of what the BOM called for, so later BOM edits don't rewrite history.
CREATE TABLE build_line (
  id           INTEGER PRIMARY KEY,
  build_id     INTEGER NOT NULL REFERENCES build(id) ON DELETE CASCADE,
  bom_line_id  INTEGER REFERENCES bom_line(id) ON DELETE SET NULL,
  bom_part_id  INTEGER REFERENCES part(id),
  designators  TEXT,
  part_id      INTEGER NOT NULL REFERENCES part(id),
  location_id  INTEGER REFERENCES location(id),
  qty_used     REAL NOT NULL,
  unit_cost    REAL
);

-- ---------- Stock ----------
-- Current quantity per part per location; maintained only from stock_txn
CREATE TABLE stock (
  part_id      INTEGER NOT NULL REFERENCES part(id) ON DELETE RESTRICT,
  location_id  INTEGER NOT NULL REFERENCES location(id) ON DELETE RESTRICT,
  qty          REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (part_id, location_id)
);
CREATE INDEX stock_location ON stock(location_id);

-- Every change to stock. One logical action (a move) is two rows sharing a batch_id.
CREATE TABLE stock_txn (
  id              INTEGER PRIMARY KEY,
  batch_id        TEXT NOT NULL,
  at              TEXT NOT NULL DEFAULT (datetime('now')),
  kind            TEXT NOT NULL CHECK (kind IN ('opening','receive','move','consume','build_output','adjust','count')),
  part_id         INTEGER NOT NULL REFERENCES part(id),
  location_id     INTEGER NOT NULL REFERENCES location(id),
  qty_delta       REAL NOT NULL,              -- + in, - out
  unit_cost       REAL,                       -- base currency, receives only
  mfr_part_id     INTEGER REFERENCES mfr_part(id),    -- what was actually received
  vendor_id       INTEGER REFERENCES vendor(id),
  vendor_part_id  INTEGER REFERENCES vendor_part(id),
  build_id        INTEGER REFERENCES build(id),
  order_ref       TEXT,                       -- vendor order or PO number
  note            TEXT
);
CREATE INDEX stock_txn_part ON stock_txn(part_id, at);
CREATE INDEX stock_txn_build ON stock_txn(build_id);

CREATE TRIGGER stock_txn_apply AFTER INSERT ON stock_txn BEGIN
  INSERT INTO stock (part_id, location_id, qty) VALUES (NEW.part_id, NEW.location_id, NEW.qty_delta)
    ON CONFLICT (part_id, location_id) DO UPDATE SET qty = qty + excluded.qty;
  DELETE FROM stock WHERE part_id = NEW.part_id AND location_id = NEW.location_id AND qty = 0;
END;

-- The ledger is history: it is never edited or deleted.
CREATE TRIGGER stock_txn_no_update BEFORE UPDATE ON stock_txn BEGIN
  SELECT RAISE(ABORT, 'stock_txn rows cannot be changed; add a correcting row instead');
END;

CREATE VIEW part_stock AS
  SELECT p.id AS part_id, p.pn, COALESCE(SUM(s.qty), 0) AS on_hand
  FROM part p LEFT JOIN stock s ON s.part_id = p.id
  GROUP BY p.id;

-- ---------- Purchasing ----------
-- The shopping list can hold things that aren't stocked parts (description only).
CREATE TABLE shopping_item (
  id              INTEGER PRIMARY KEY,
  part_id         INTEGER REFERENCES part(id),          -- NULL for a non-inventory item
  description     TEXT,
  vendor_id       INTEGER REFERENCES vendor(id),
  vendor_part_id  INTEGER REFERENCES vendor_part(id),
  sku             TEXT,
  qty             REAL NOT NULL CHECK (qty > 0),
  unit_price      REAL,                                 -- in `currency`
  currency        TEXT,
  reason          TEXT,                                 -- 'B0003 short', 'manual'
  build_id        INTEGER REFERENCES build(id),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','ordered','received','cancelled')),
  order_ref       TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ordered_at      TEXT,
  received_at     TEXT,
  CHECK (part_id IS NOT NULL OR description IS NOT NULL)
);
CREATE INDEX shopping_item_status ON shopping_item (status, vendor_id);
CREATE INDEX shopping_item_part ON shopping_item (part_id);

-- ---------- Documents ----------
CREATE TABLE document (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  file_path   TEXT,                           -- relative to the library's files/ folder
  url         TEXT,
  kind        TEXT,                           -- 'datasheet', 'drawing', 'schematic', 'photo'
  added_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE document_link (
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  part_id     INTEGER REFERENCES part(id) ON DELETE CASCADE,
  mfr_part_id INTEGER REFERENCES mfr_part(id) ON DELETE CASCADE,
  bom_rev_id  INTEGER REFERENCES bom_rev(id) ON DELETE CASCADE,
  CHECK ((part_id IS NOT NULL) + (mfr_part_id IS NOT NULL) + (bom_rev_id IS NOT NULL) = 1)
);

-- ---------- Search ----------
-- One row per part; rebuilt for a part whenever it or its manufacturer/vendor parts change.
CREATE VIRTUAL TABLE part_fts USING fts5(
  part_id UNINDEXED, pn, name, description, mpns, skus, value_text, package, category,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);

-- ---------- Settings and audit ----------
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO setting (key, value) VALUES ('base_currency', 'USD');   -- confirmed or changed on first run

CREATE TABLE fx_rate (currency TEXT PRIMARY KEY, to_base REAL NOT NULL, updated_at TEXT);
INSERT INTO fx_rate (currency, to_base, updated_at) VALUES ('USD', 1, datetime('now'));

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  entity    TEXT NOT NULL,                    -- 'part', 'mfr_part', 'location'...
  entity_id INTEGER NOT NULL,
  action    TEXT NOT NULL CHECK (action IN ('create','update','delete','merge','archive','restore')),
  changes   TEXT                              -- JSON
);
