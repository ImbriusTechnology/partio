-- Builds keep their own copy of the BOM, taken when the build is planned (and again if you refresh it),
-- so editing a BOM never quietly changes a build you've already planned or bought parts for.

CREATE TABLE build_req (
  id              INTEGER PRIMARY KEY,
  build_id        INTEGER NOT NULL REFERENCES build(id) ON DELETE CASCADE,
  bom_line_id     INTEGER REFERENCES bom_line(id) ON DELETE SET NULL,
  line_no         INTEGER NOT NULL,
  part_id         INTEGER REFERENCES part(id),   -- the BOM's part; NULL while unresolved
  pn_as_imported  TEXT,
  mpn_as_imported TEXT,
  qty_per         REAL NOT NULL,                 -- per assembly
  designators     TEXT,
  dnp             INTEGER NOT NULL DEFAULT 0,
  use_part_id     INTEGER REFERENCES part(id),   -- a substitute chosen for this build; NULL: the BOM's part
  UNIQUE (build_id, line_no)
);
CREATE INDEX build_req_part ON build_req(part_id);
CREATE INDEX build_req_use ON build_req(use_part_id);

ALTER TABLE build ADD COLUMN created_at TEXT;
ALTER TABLE build ADD COLUMN qty_built INTEGER;    -- set on completion; may be fewer than planned
ALTER TABLE build ADD COLUMN bom_status TEXT;      -- the revision's status when the build was completed
ALTER TABLE build ADD COLUMN unit_cost REAL;       -- base currency, from the parts used; NULL if none were costed
