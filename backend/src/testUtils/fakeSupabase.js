// Test-only in-memory stand-in for @supabase/supabase-js's chainable query
// builder — generic enough to share across every P10 repository's tests
// (roomRepository/gameRepository) instead of one hand-rolled single-path
// mock per file (boardRepository.test.js's own inline mock, kept as-is,
// only ever needed one path: .from().select().eq().order()). No real SQL,
// no RLS, no network — same "fully testable with a mock client" posture,
// scaled up to support insert/update/upsert since those repositories
// write, not just read.
//
// Supports exactly the query-builder surface this backend's repositories
// call: .from(table).select(cols)/.insert(rows)/.update(obj)/.upsert(rows,
// opts)/.delete(), chained with .eq(col,val)/.in(col,vals), terminated by
// .single() or awaited directly for an array result. Deliberately does not support
// PostgREST's embedded-resource select syntax (`room_players(*, profiles(*))`)
// — the real repositories avoid it too (flat queries + JS-side merge,
// matching boardRepository.js's own plain-query style), so the mock never
// needs to emulate it.

function matchesFilters(row, filters) {
  return filters.every(({ type, column, value }) => {
    if (type === 'eq') return row[column] === value;
    if (type === 'in') return value.includes(row[column]);
    return true;
  });
}

export function createFakeSupabase(initialTables = {}) {
  const tables = new Map();
  for (const [name, rows] of Object.entries(initialTables)) {
    tables.set(
      name,
      rows.map((r) => ({ ...r }))
    );
  }

  function getTable(name) {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  }

  function from(tableName) {
    const filters = [];
    let mode = null; // 'select' | 'insert' | 'update' | 'upsert' | 'delete'
    let payload = null;
    let selectAfterWrite = false;
    let single = false;

    async function execute() {
      const table = getTable(tableName);

      if (mode === 'insert') {
        const inserted = payload.map((row) => ({ ...row }));
        table.push(...inserted);
        return finish(selectAfterWrite ? inserted : null);
      }

      if (mode === 'update') {
        const matched = table.filter((row) => matchesFilters(row, filters));
        matched.forEach((row) => Object.assign(row, payload));
        return finish(selectAfterWrite ? matched : null);
      }

      if (mode === 'upsert') {
        const { rows, opts } = payload;
        const conflictCols = (opts.onConflict ?? 'id').split(',').map((s) => s.trim());
        const results = [];
        for (const row of rows) {
          const existing = table.find((r) => conflictCols.every((c) => r[c] === row[c]));
          if (existing) {
            Object.assign(existing, row);
            results.push(existing);
          } else {
            const inserted = { ...row };
            table.push(inserted);
            results.push(inserted);
          }
        }
        return finish(selectAfterWrite ? results : null);
      }

      if (mode === 'delete') {
        const toDelete = table.filter((row) => matchesFilters(row, filters));
        const remaining = table.filter((row) => !matchesFilters(row, filters));
        tables.set(tableName, remaining);
        return finish(selectAfterWrite ? toDelete : null);
      }

      // select (default when only .select()/.eq()/.in() were called)
      const matched = table.filter((row) => matchesFilters(row, filters));
      return finish(matched);
    }

    function finish(data) {
      if (single) {
        const row = Array.isArray(data) ? (data[0] ?? null) : data;
        return { data: row, error: null };
      }
      return { data, error: null };
    }

    const builder = {
      select(_cols) {
        if (mode === null) mode = 'select';
        selectAfterWrite = true;
        return builder;
      },
      eq(column, value) {
        filters.push({ type: 'eq', column, value });
        return builder;
      },
      in(column, value) {
        filters.push({ type: 'in', column, value });
        return builder;
      },
      order() {
        return builder; // ordering not exercised by any current caller's test assertions
      },
      insert(rows) {
        mode = 'insert';
        payload = Array.isArray(rows) ? rows : [rows];
        return builder;
      },
      update(obj) {
        mode = 'update';
        payload = obj;
        return builder;
      },
      upsert(rows, opts = {}) {
        mode = 'upsert';
        payload = { rows: Array.isArray(rows) ? rows : [rows], opts };
        return builder;
      },
      delete() {
        mode = 'delete';
        return builder;
      },
      single() {
        single = true;
        return builder;
      },
      then(resolve, reject) {
        return execute().then(resolve, reject);
      },
    };

    return builder;
  }

  return { from, _tables: tables };
}
