import { readFileSync } from 'node:fs';
import { createTile } from '../src/domain/tile.js';

export function loadSeedBoard(boardId) {
  const sql = readFileSync(new URL('../supabase/seed/boards.sql', import.meta.url), 'utf8');
  const rows = [];
  const re = /\(\s*'(small|large)'\s*,\s*(\d+)\s*,\s*'([a-z_]+)'\s*,\s*'((?:[^']|'')*)'\s*,\s*(NULL|'[a-z_]+')\s*,\s*(NULL|\d+)\s*,\s*(NULL|\d+)\s*,\s*(NULL|'\[[^\]]*\]'::jsonb)\s*,\s*(NULL|\d+)\s*,\s*(NULL|\d+)\s*,\s*(NULL|\d+)\s*\)/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const [, bid, pos, type, name, group, price, baseRent, rentTable, houseCost, mortgageValue, taxAmount] = m;
    if (bid !== boardId) continue;
    const num = (v) => (v === 'NULL' ? null : Number(v));
    const str = (v) => (v === 'NULL' ? null : v.replace(/^'|'$/g, ''));
    rows.push(createTile({
      id: `${bid}-${pos}`, boardId: bid, position: Number(pos), tileType: type,
      name: name.replace(/''/g, "'"),
      groupId: str(group), price: num(price), baseRent: num(baseRent),
      rentTable: rentTable === 'NULL' ? null : JSON.parse(rentTable.replace(/^'|'::jsonb$/g, '')),
      houseCost: num(houseCost), mortgageValue: num(mortgageValue), taxAmount: num(taxAmount),
    }));
  }
  rows.sort((a, b) => a.position - b.position);
  return rows;
}
