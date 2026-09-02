-- CoBacTyPhu — Board/tile seed data (Phase 13, Real Content: "Cờ Tỷ Phú Vĩnh Phát")
-- Supersedes the P02-T03 structural-placeholder version. Source of truth
-- for tile counts/positions/categories is still ADAPTIVE_BOARD_DESIGN.md
-- (36 tiles Small / 44 tiles Large, locked, approved 2026-08-16) — that
-- decision was explicitly NOT reopened for this task (user confirmed,
-- 2026-08-19: adapt real content onto the existing structure rather than
-- switch to a fixed 40-tile classic board). Names/prices/groups/economics
-- are the real ones provided this task, not placeholders, wherever the
-- source material actually covers a tile — see the two sections below for
-- exactly which tiles are real vs. still-placeholder.
--
-- ============================================================
-- WHY 40 REAL TILES DON'T MAP 1:1 ONTO EITHER BOARD
-- ============================================================
-- The real "Vĩnh Phát" layout given this task is a classic 40-tile board
-- (4 corners + 9 edge tiles/side). Small is 36 (4 corners + 8/side) —
-- 4 fewer edge tiles than the real layout provides. Large is 44 (4 corners
-- + 10/side) — 4 MORE than the real layout provides.
--
-- Small (36): every one of the 22 real properties is kept — the real
-- property count already matches Small's own locked property count (22)
-- exactly, so nothing here was dropped or invented to hit that number.
-- What WAS dropped, exactly 1 non-property tile per side (4 total, matching
-- Small's 8/side vs. the source's 9/side):
--   - Side 1: Bến Xe Cần Giuộc (station)
--   - Side 2: the source's 2nd Khí Vận instance
--   - Side 3: Bến Xe Chợ Lớn (station)
--   - Side 4: the source's 2nd Cơ Hội instance
-- Chosen to drop stations/deck-instances specifically, never a named
-- property — a Cơ Hội/Khí Vận instance is functionally identical to any
-- other (same shared deck, same effect), so dropping a *duplicate*
-- instance loses nothing content-wise. Of the 4 real named stations, Bến
-- Xe Miền Tây and Bến Xe Miền Đông were kept (kept the two most widely-
-- recognized Ho Chi Minh City bus terminals of the four real named ones;
-- Cần Giuộc/Chợ Lớn dropped) — a judgment call, not a computed answer;
-- trivially swappable in this file if you'd rather keep a different pair.
--
-- Large (44): all 36 real edge tiles are kept as-is (Large has *more* room
-- than the source provides, so nothing needed to be dropped, including
-- both stations Small had to drop) — plus 4 placeholder property slots
-- ("Property 23"–"Property 26", same naming convention the prior
-- placeholder-era file already used) to reach the required 40 edge tiles.
-- Consequence, flagged directly: Large's realized category counts (26
-- property/3 chance/3 fortune/2 tax/4 transport/2 utility) now differ
-- slightly from ADAPTIVE_BOARD_DESIGN.md's original table (28/2/2/3/3/2) —
-- that table was authored for *generic* placeholder content with no fixed
-- real-world counts of its own; real content doesn't split into an
-- arbitrary ratio chosen before any real content existed. Not a silent
-- deviation: every number above is exact, not approximate.
--
-- ============================================================
-- ECONOMICS — two corrections made to the task's own source anchors
-- ============================================================
-- The task's "known anchors" block for Tân Kỳ Tân Quý ($400) / Lũy Bán
-- Bích ($350) — rent $2 / $4, house cost $50, mortgage $30 — is, digit for
-- digit, the real *classic Cờ Tỷ Phú/Monopoly cheapest-tier* figures
-- (Mediterranean/Baltic Ave's real numbers), not a plausible number for the
-- most expensive properties on the board: a $2–4 rent on a $400 property
-- would make it effectively free to land on, breaking the property's own
-- purpose. Read as a mislabeled reference rather than applied literally:
--   - Applied instead to Nguyễn Huệ / Lê Lợi (the actual $60 "Red" group)
--     — an exact match to that tier's own price point, not just the anchor.
--   - Tân Kỳ Tân Quý / Lũy Bán Bích use the real classic top-tier numbers
--     instead (rent 50/35, house $200, mortgage $200/$175) — internally
--     consistent with every other tier's progression below.
-- The Trường Chinh/Lê Đại Hành anchor (house $100, mortgage $70/$80) was
-- NOT overridden — those figures are plausible for a $260–280 property
-- (merely non-standard vs. classic-Monopoly's own $150/$130-140 for that
-- tier, not incoherent the way the DarkBlue anchor was), and a genuine
-- regional edition legitimately having its own numbers is not, by itself,
-- a reason to override an explicitly-given value.
-- Every other property's rent progression (1 house → hotel) and house
-- cost/mortgage value — none given explicitly by the task — uses the real,
-- standard classic Cờ Tỷ Phú/Monopoly progression for that exact price
-- point (the task's own prices already match that table's tiers exactly,
-- so this is interpolation from a known real source, not invention).
-- Income Tax's "10% of holdings or flat $200, player's choice" is seeded
-- as a flat $200 only — this schema/engine has one tax_amount column and
-- resolveTile.js's PAYING_TAX path has no percentage-choice branch; adding
-- one would be new core logic, out of this task's own explicit "seed data
-- only" scope. Luxury Tax ($100 flat) needed no such simplification.
--
-- Group IDs (group_id, lowercase slug per color): red, cyan, purple,
-- orange, yellow, green, blue, darkblue — matching the 8 real groups
-- given, letting BUILD_HOUSE's full-group-ownership check finally have
-- real group data to check against (previously always empty/ungrouped).
--
-- Transport (station) rent: seeded as base_rent = 25 only, no rent_table —
-- engine/calculateRent.js's own transport formula is
-- `baseRent × 2^(ownedCount−1)`, which already produces 25/50/100/200 for
-- 1/2/3/4 owned from that single base value; matches the task's given
-- progression exactly, confirmed by reading that formula, not assumed.
-- Utility rent (4× / 10× dice, by ownership count) is likewise entirely
-- computed by calculateRent.js already — utility tiles only need
-- price/mortgage_value seeded, base_rent correctly stays NULL (dice-based,
-- same convention the prior placeholder file already established).
--
-- Corner names/order/positions, tile-type taxonomy, and the Cơ
-- Hội/Khí Vận deck-label convention are unchanged from the prior version
-- of this file (still real/confirmed, per BOARD_SPECIFICATION.md).


INSERT INTO boards (id, name, tile_count, min_players, max_players) VALUES
  ('small', 'Small Board', 36, 2, 4),
  ('large', 'Large Board', 44, 5, 6)
ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- Small board — 36 tiles (4 corners + 8/edge). Corners at 0, 9, 18, 27.
-- Realized composition: 22 property, 2 chance, 2 fortune, 2 tax,
-- 2 transport, 2 utility — see header for exactly what was dropped
-- from the real 40-tile source to reach this (all real, nothing invented).
-- ============================================================
-- ON CONFLICT upsert, not a plain INSERT: the live project already has the
-- P02-T03 placeholder rows applied (docs/PROJECT_STATUS.md, 2026-08-18) —
-- this needs to cleanly replace them in place, not fail on
-- board_tiles' own UNIQUE (board_id, "position") constraint.
INSERT INTO board_tiles (board_id, "position", tile_type, name, group_id, price, base_rent, rent_table, house_cost, mortgage_value, tax_amount) VALUES
  ('small', 0,  'go',           'Bắt Đầu',                    NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('small', 1,  'property',     'Nguyễn Huệ',                 'red',      60,   2,    '[10,30,90,160,250]'::jsonb,      50,   30,   NULL),
  ('small', 2,  'fortune',      'Khí Vận',                    NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('small', 3,  'property',     'Lê Lợi',                     'red',      60,   4,    '[20,60,180,320,450]'::jsonb,      50,   30,   NULL),
  ('small', 4,  'tax',          'Thuế Thu Nhập',              NULL,       NULL, NULL, NULL,                              NULL, NULL, 200),
  ('small', 5,  'property',     'Lương Định Của',             'cyan',     100,  6,    '[30,90,270,400,550]'::jsonb,      50,   50,   NULL),
  ('small', 6,  'chance',       'Cơ Hội',                     NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('small', 7,  'property',     'Võ Thị Sáu',                 'cyan',     100,  6,    '[30,90,270,400,550]'::jsonb,      50,   50,   NULL),
  ('small', 8,  'property',     'Hai Bà Trưng',                'cyan',     120,  8,    '[40,100,300,450,600]'::jsonb,     50,   60,   NULL),
  ('small', 9,  'jail',         'Ở Tù / Thăm Tù',              NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('small', 10, 'property',     'Nguyễn Tất Thành',           'purple',   140,  10,   '[50,150,450,625,750]'::jsonb,     100,  70,   NULL),
  ('small', 11, 'utility',      'Công Ty Điện Lực',            NULL,       200,  NULL, NULL,                              NULL, 75,   NULL),
  ('small', 12, 'property',     'Nguyễn Trãi',                'purple',   140,  10,   '[50,150,450,625,750]'::jsonb,     100,  70,   NULL),
  ('small', 13, 'property',     'An Dương Vương',             'purple',   160,  12,   '[60,180,500,700,900]'::jsonb,     100,  80,   NULL),
  ('small', 14, 'transport',    'Bến Xe Miền Tây',             NULL,       200,  25,   NULL,                              NULL, 100,  NULL),
  ('small', 15, 'property',     'Hậu Giang',                  'orange',   180,  14,   '[70,200,550,750,950]'::jsonb,     100,  90,   NULL),
  ('small', 16, 'property',     'Hùng Vương',                 'orange',   180,  14,   '[70,200,550,750,950]'::jsonb,     100,  90,   NULL),
  ('small', 17, 'property',     'Huỳnh Tấn Phát',             'orange',   200,  16,   '[80,220,600,800,1000]'::jsonb,    100,  100,  NULL),
  ('small', 18, 'free_parking', 'Bãi Đậu Xe Miễn Phí',         NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('small', 19, 'property',     'Phạm Thế Hiển',              'yellow',   220,  18,   '[90,250,700,875,1050]'::jsonb,    150,  110,  NULL),
  ('small', 20, 'chance',       'Cơ Hội',                     NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('small', 21, 'property',     'Kha Vạn Cân',                'yellow',   220,  18,   '[90,250,700,875,1050]'::jsonb,    150,  110,  NULL),
  ('small', 22, 'property',     'Nguyễn Tri Phương',          'yellow',   240,  20,   '[100,300,750,925,1100]'::jsonb,   150,  120,  NULL),
  ('small', 23, 'property',     'Lê Đại Hành',                'green',    260,  22,   '[110,330,800,975,1150]'::jsonb,   100,  70,   NULL),
  ('small', 24, 'property',     'Trường Chinh',               'green',    260,  22,   '[110,330,800,975,1150]'::jsonb,   100,  70,   NULL),
  ('small', 25, 'utility',      'Công Ty Cấp Nước',            NULL,       200,  NULL, NULL,                              NULL, 75,   NULL),
  ('small', 26, 'property',     'Hoàng Văn Thụ',              'green',    280,  24,   '[120,360,850,1025,1200]'::jsonb,  100,  80,   NULL),
  ('small', 27, 'go_to_jail',   'Vào Tù',                     NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('small', 28, 'property',     'Cộng Hòa',                   'blue',     300,  26,   '[130,390,900,1100,1275]'::jsonb,  200,  150,  NULL),
  ('small', 29, 'property',     'Nguyễn Kiệm',                'blue',     300,  26,   '[130,390,900,1100,1275]'::jsonb,  200,  150,  NULL),
  ('small', 30, 'fortune',      'Khí Vận',                    NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('small', 31, 'property',     'Quang Trung',                'blue',     320,  28,   '[150,450,1000,1200,1400]'::jsonb, 200,  160,  NULL),
  ('small', 32, 'transport',    'Bến Xe Miền Đông',            NULL,       200,  25,   NULL,                              NULL, 100,  NULL),
  ('small', 33, 'property',     'Lũy Bán Bích',               'darkblue', 350,  35,   '[175,500,1100,1300,1500]'::jsonb, 200,  175,  NULL),
  ('small', 34, 'tax',          'Thuế Đặc Biệt',              NULL,       NULL, NULL, NULL,                              NULL, NULL, 100),
  ('small', 35, 'property',     'Tân Kỳ Tân Quý',             'darkblue', 400,  50,   '[200,600,1400,1700,2000]'::jsonb, 200,  200,  NULL)
ON CONFLICT (board_id, "position") DO UPDATE SET
  tile_type = EXCLUDED.tile_type, name = EXCLUDED.name, group_id = EXCLUDED.group_id,
  price = EXCLUDED.price, base_rent = EXCLUDED.base_rent, rent_table = EXCLUDED.rent_table,
  house_cost = EXCLUDED.house_cost, mortgage_value = EXCLUDED.mortgage_value, tax_amount = EXCLUDED.tax_amount;


-- ============================================================
-- Large board — 44 tiles (4 corners + 10/edge). Corners at 0, 11, 22, 33.
-- Realized composition: 26 property (22 real + 4 placeholder — see
-- header), 3 chance, 3 fortune, 2 tax, 4 transport, 2 utility. All real
-- content is identical to Small above (same prices/economics per tile) —
-- only which real tiles are *included* differs (Large drops none).
-- ============================================================
-- ON CONFLICT upsert, not a plain INSERT: the live project already has the
-- P02-T03 placeholder rows applied (docs/PROJECT_STATUS.md, 2026-08-18) —
-- this needs to cleanly replace them in place, not fail on
-- board_tiles' own UNIQUE (board_id, "position") constraint.
INSERT INTO board_tiles (board_id, "position", tile_type, name, group_id, price, base_rent, rent_table, house_cost, mortgage_value, tax_amount) VALUES
  ('large', 0,  'go',           'Bắt Đầu',                    NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('large', 1,  'property',     'Nguyễn Huệ',                 'red',      60,   2,    '[10,30,90,160,250]'::jsonb,      50,   30,   NULL),
  ('large', 2,  'fortune',      'Khí Vận',                    NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('large', 3,  'property',     'Lê Lợi',                     'red',      60,   4,    '[20,60,180,320,450]'::jsonb,      50,   30,   NULL),
  ('large', 4,  'tax',          'Thuế Thu Nhập',              NULL,       NULL, NULL, NULL,                              NULL, NULL, 200),
  ('large', 5,  'transport',    'Bến Xe Cần Giuộc',            NULL,       200,  25,   NULL,                              NULL, 100,  NULL),
  ('large', 6,  'property',     'Lương Định Của',             'cyan',     100,  6,    '[30,90,270,400,550]'::jsonb,      50,   50,   NULL),
  ('large', 7,  'chance',       'Cơ Hội',                     NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('large', 8,  'property',     'Võ Thị Sáu',                 'cyan',     100,  6,    '[30,90,270,400,550]'::jsonb,      50,   50,   NULL),
  ('large', 9,  'property',     'Hai Bà Trưng',                'cyan',     120,  8,    '[40,100,300,450,600]'::jsonb,     50,   60,   NULL),
  ('large', 10, 'property',     'Property 23',                NULL,       100,  10,   '[50,150,450,625,750]'::jsonb,     50,   50,   NULL),
  ('large', 11, 'jail',         'Ở Tù / Thăm Tù',              NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('large', 12, 'property',     'Nguyễn Tất Thành',           'purple',   140,  10,   '[50,150,450,625,750]'::jsonb,     100,  70,   NULL),
  ('large', 13, 'utility',      'Công Ty Điện Lực',            NULL,       200,  NULL, NULL,                              NULL, 75,   NULL),
  ('large', 14, 'property',     'Nguyễn Trãi',                'purple',   140,  10,   '[50,150,450,625,750]'::jsonb,     100,  70,   NULL),
  ('large', 15, 'property',     'An Dương Vương',             'purple',   160,  12,   '[60,180,500,700,900]'::jsonb,     100,  80,   NULL),
  ('large', 16, 'transport',    'Bến Xe Miền Tây',             NULL,       200,  25,   NULL,                              NULL, 100,  NULL),
  ('large', 17, 'property',     'Hậu Giang',                  'orange',   180,  14,   '[70,200,550,750,950]'::jsonb,     100,  90,   NULL),
  ('large', 18, 'fortune',      'Khí Vận',                    NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('large', 19, 'property',     'Hùng Vương',                 'orange',   180,  14,   '[70,200,550,750,950]'::jsonb,     100,  90,   NULL),
  ('large', 20, 'property',     'Huỳnh Tấn Phát',             'orange',   200,  16,   '[80,220,600,800,1000]'::jsonb,    100,  100,  NULL),
  ('large', 21, 'property',     'Property 24',                NULL,       100,  10,   '[50,150,450,625,750]'::jsonb,     50,   50,   NULL),
  ('large', 22, 'free_parking', 'Bãi Đậu Xe Miễn Phí',         NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('large', 23, 'property',     'Phạm Thế Hiển',              'yellow',   220,  18,   '[90,250,700,875,1050]'::jsonb,    150,  110,  NULL),
  ('large', 24, 'chance',       'Cơ Hội',                     NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('large', 25, 'property',     'Kha Vạn Cân',                'yellow',   220,  18,   '[90,250,700,875,1050]'::jsonb,    150,  110,  NULL),
  ('large', 26, 'property',     'Nguyễn Tri Phương',          'yellow',   240,  20,   '[100,300,750,925,1100]'::jsonb,   150,  120,  NULL),
  ('large', 27, 'transport',    'Bến Xe Chợ Lớn',              NULL,       200,  25,   NULL,                              NULL, 100,  NULL),
  ('large', 28, 'property',     'Lê Đại Hành',                'green',    260,  22,   '[110,330,800,975,1150]'::jsonb,   100,  70,   NULL),
  ('large', 29, 'property',     'Trường Chinh',               'green',    260,  22,   '[110,330,800,975,1150]'::jsonb,   100,  70,   NULL),
  ('large', 30, 'utility',      'Công Ty Cấp Nước',            NULL,       200,  NULL, NULL,                              NULL, 75,   NULL),
  ('large', 31, 'property',     'Hoàng Văn Thụ',              'green',    280,  24,   '[120,360,850,1025,1200]'::jsonb,  100,  80,   NULL),
  ('large', 32, 'property',     'Property 25',                NULL,       100,  10,   '[50,150,450,625,750]'::jsonb,     50,   50,   NULL),
  ('large', 33, 'go_to_jail',   'Vào Tù',                     NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('large', 34, 'property',     'Cộng Hòa',                   'blue',     300,  26,   '[130,390,900,1100,1275]'::jsonb,  200,  150,  NULL),
  ('large', 35, 'property',     'Nguyễn Kiệm',                'blue',     300,  26,   '[130,390,900,1100,1275]'::jsonb,  200,  150,  NULL),
  ('large', 36, 'fortune',      'Khí Vận',                    NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('large', 37, 'property',     'Quang Trung',                'blue',     320,  28,   '[150,450,1000,1200,1400]'::jsonb, 200,  160,  NULL),
  ('large', 38, 'transport',    'Bến Xe Miền Đông',            NULL,       200,  25,   NULL,                              NULL, 100,  NULL),
  ('large', 39, 'chance',       'Cơ Hội',                     NULL,       NULL, NULL, NULL,                              NULL, NULL, NULL),
  ('large', 40, 'property',     'Lũy Bán Bích',               'darkblue', 350,  35,   '[175,500,1100,1300,1500]'::jsonb, 200,  175,  NULL),
  ('large', 41, 'tax',          'Thuế Đặc Biệt',              NULL,       NULL, NULL, NULL,                              NULL, NULL, 100),
  ('large', 42, 'property',     'Tân Kỳ Tân Quý',             'darkblue', 400,  50,   '[200,600,1400,1700,2000]'::jsonb, 200,  200,  NULL),
  ('large', 43, 'property',     'Property 26',                NULL,       100,  10,   '[50,150,450,625,750]'::jsonb,     50,   50,   NULL)
ON CONFLICT (board_id, "position") DO UPDATE SET
  tile_type = EXCLUDED.tile_type, name = EXCLUDED.name, group_id = EXCLUDED.group_id,
  price = EXCLUDED.price, base_rent = EXCLUDED.base_rent, rent_table = EXCLUDED.rent_table,
  house_cost = EXCLUDED.house_cost, mortgage_value = EXCLUDED.mortgage_value, tax_amount = EXCLUDED.tax_amount;
