-- Common packages, seeded in every new library (the user can edit or delete them).
-- Chip sizes carry their metric name as an alias: '2012M' (and '2012' where it can't be mistaken
-- for an imperial size) finds 0805. Metric 0603 and 0402 are only accepted with the M suffix,
-- because 0603 and 0402 are also imperial sizes.

INSERT INTO package (name, mount) VALUES
  ('01005','SMD'), ('0201','SMD'), ('0402','SMD'), ('0603','SMD'), ('0805','SMD'),
  ('1206','SMD'), ('1210','SMD'), ('1812','SMD'), ('2010','SMD'), ('2512','SMD'),
  ('SOD-123','SMD'), ('SOD-323','SMD'), ('SMA','SMD'), ('SMB','SMD'), ('SMC','SMD'),
  ('SOT-23-3','SMD'), ('SOT-23-5','SMD'), ('SOT-23-6','SMD'), ('SOT-89','SMD'), ('SOT-223','SMD'),
  ('TO-252','SMD'), ('TO-263','SMD'),
  ('SOIC-8','SMD'), ('SOIC-14','SMD'), ('SOIC-16','SMD'),
  ('MSOP-8','SMD'), ('TSSOP-14','SMD'), ('TSSOP-16','SMD'), ('TSSOP-20','SMD'),
  ('QFN-16','SMD'), ('QFN-20','SMD'), ('QFN-32','SMD'),
  ('TQFP-32','SMD'), ('TQFP-44','SMD'), ('LQFP-48','SMD'), ('LQFP-64','SMD'),
  ('DIP-8','TH'), ('DIP-14','TH'), ('DIP-16','TH'),
  ('TO-92','TH'), ('TO-220','TH'), ('DO-35','TH'), ('DO-41','TH'),
  ('Axial','TH'), ('Radial','TH');

-- Metric names of chip sizes
INSERT INTO package_alias (alias, package_id, is_metric)
SELECT m.alias, p.id, 1 FROM package p JOIN (
  SELECT '01005' AS pkg, '0402M' AS alias UNION ALL
  SELECT '0201',  '0603M' UNION ALL
  SELECT '0402',  '1005M' UNION ALL SELECT '0402', '1005' UNION ALL
  SELECT '0603',  '1608M' UNION ALL SELECT '0603', '1608' UNION ALL
  SELECT '0805',  '2012M' UNION ALL SELECT '0805', '2012' UNION ALL
  SELECT '1206',  '3216M' UNION ALL SELECT '1206', '3216' UNION ALL
  SELECT '1210',  '3225M' UNION ALL SELECT '1210', '3225' UNION ALL
  SELECT '1812',  '4532M' UNION ALL SELECT '1812', '4532' UNION ALL
  SELECT '2010',  '5025M' UNION ALL SELECT '2010', '5025' UNION ALL
  SELECT '2512',  '6332M' UNION ALL SELECT '2512', '6332'
) m ON m.pkg = p.name;

-- Other spellings people (and vendor exports) use
INSERT INTO package_alias (alias, package_id)
SELECT a.alias, p.id FROM package p JOIN (
  SELECT 'SOT-23-3' AS pkg, 'SOT23' AS alias UNION ALL SELECT 'SOT-23-3', 'SOT-23' UNION ALL SELECT 'SOT-23-3', 'SOT23-3' UNION ALL
  SELECT 'SOT-23-5', 'SOT23-5' UNION ALL SELECT 'SOT-23-5', 'SC-74A' UNION ALL
  SELECT 'SOT-23-6', 'SOT23-6' UNION ALL
  SELECT 'SOT-223', 'SOT223' UNION ALL SELECT 'SOT-89', 'SOT89' UNION ALL
  SELECT 'SOD-123', 'SOD123' UNION ALL SELECT 'SOD-323', 'SOD323' UNION ALL
  SELECT 'SMA', 'DO-214AC' UNION ALL SELECT 'SMB', 'DO-214AA' UNION ALL SELECT 'SMC', 'DO-214AB' UNION ALL
  SELECT 'TO-252', 'DPAK' UNION ALL SELECT 'TO-263', 'D2PAK' UNION ALL
  SELECT 'SOIC-8', 'SO-8' UNION ALL SELECT 'SOIC-8', 'SOIC8' UNION ALL SELECT 'SOIC-8', 'SO8' UNION ALL
  SELECT 'SOIC-14', 'SO-14' UNION ALL SELECT 'SOIC-16', 'SO-16' UNION ALL
  SELECT 'MSOP-8', 'MSOP8' UNION ALL
  SELECT 'DIP-8', 'PDIP-8' UNION ALL SELECT 'DIP-8', 'DIP8' UNION ALL
  SELECT 'DIP-14', 'PDIP-14' UNION ALL SELECT 'DIP-16', 'PDIP-16' UNION ALL
  SELECT 'TO-92', 'TO92' UNION ALL SELECT 'TO-220', 'TO220'
) a ON a.pkg = p.name;
