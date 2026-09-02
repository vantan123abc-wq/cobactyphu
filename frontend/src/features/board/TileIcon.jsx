// Custom tile-type icon set, 2026-08-21 — replaces the plain OS-emoji
// glyphs `tileVisuals.js` used to export as `TILE_ICON` (🚉💡❓🍀💸) and
// `BoardTile.jsx`'s own `CORNER_LABEL` used for the 3 non-GO corners
// (🚔🅿️👮). Emoji render inconsistently across platforms/browsers (a real,
// separate legibility complaint from a live screenshot, alongside the
// isometric board's own text-contrast fix in BoardTile.module.css) and
// don't match any deliberate visual style — this is a small, consistent,
// hand-drawn outline-icon set instead (24x24 viewBox, `currentColor`, so
// callers tint it via CSS `color` the same way text already inherits
// `--text-h`/etc.), a dedicated component file rather than added to
// `tileVisuals.js` — that file is deliberately plain-constants-only (its
// own header: exporting a component from it trips oxlint's
// react(only-export-components) Fast Refresh rule).
//
// Reused by every place that already imported `TILE_ICON` from
// `tileVisuals.js` (`BoardTile.jsx`, `FlashAuction.jsx`,
// `PropertyActionDrawer.jsx`, `RentRiskChoice.jsx`, `PropertyManager.jsx`)
// — same icon, same tile type, wherever it's shown, not just on the board.

const OUTLINE_ICONS = {
  // Cơ Hội reskin (2026-08-22, user request — "Vé Số Kiến Thiết" concept):
  // two fanned lottery-ticket stubs, each with a dashed perforation line —
  // replaces the old plain "?" bubble. Rotated only ±10deg around each
  // rect's own center (not the more dramatic 3-ticket fan the brief's own
  // reference described) specifically so the rotated corners stay
  // comfortably inside the 24x24 viewBox at any icon size — same
  // "verifiable by structure, not by eye" discipline this file's own header
  // already established.
  chance: (
    <>
      <rect x="7" y="9" width="10" height="6" rx="1" transform="rotate(-10 12 12)" />
      <rect x="7" y="9" width="10" height="6" rx="1" transform="rotate(10 12 12)" />
      <line x1="10" y1="9.6" x2="10" y2="14.4" transform="rotate(-10 12 12)" strokeDasharray="1.2 1.2" />
      <line x1="14" y1="9.6" x2="14" y2="14.4" transform="rotate(10 12 12)" strokeDasharray="1.2 1.2" />
    </>
  ),
  transport: (
    <>
      <rect x="4" y="4" width="16" height="12" rx="3" />
      <line x1="4" y1="10" x2="20" y2="10" />
      <line x1="9" y1="4" x2="9" y2="10" />
      <line x1="15" y1="4" x2="15" y2="10" />
      <line x1="4" y1="16" x2="4" y2="19" />
      <line x1="20" y1="16" x2="20" y2="19" />
      <circle cx="8" cy="19.3" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="16" cy="19.3" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  tax: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v5c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
      <path d="M5 11v5c0 1.66 3.13 3 7 3s7-1.34 7-3v-5" />
    </>
  ),
  jail: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="8" y1="3" x2="8" y2="21" />
      <line x1="13" y1="3" x2="13" y2="21" />
      <line x1="18" y1="3" x2="18" y2="21" />
    </>
  ),
  free_parking: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 16V8h3.2a2.4 2.4 0 0 1 0 4.8H10" />
    </>
  ),
  go_to_jail: (
    <>
      <circle cx="8" cy="12.5" r="4" />
      <circle cx="16" cy="12.5" r="4" />
      <line x1="11" y1="9.8" x2="13" y2="9.8" />
    </>
  ),
  // Khí Vận reskin (2026-08-22, user request — "Xin Xăm" bamboo
  // fortune-stick concept): a tube with a few sticks mid-draw, one topped
  // with a small marker dot — replaces the old plain 4-circle "clover"
  // shape, and moves this type from FILLED_ICONS to here (outline-style,
  // matching the tube's own open-top silhouette).
  fortune: (
    <>
      <rect x="7" y="13" width="10" height="8" rx="1.5" />
      <line x1="9" y1="13" x2="8.3" y2="5" />
      <line x1="12" y1="13" x2="12" y2="3.5" />
      <line x1="15" y1="13" x2="15.7" y2="6" />
      <circle cx="12" cy="3.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
}

// Two icons are solid-filled shapes, not outlines — set their own
// fill/stroke explicitly rather than relying on the shared wrapper
// defaults below (which are tuned for the outline set above).
const FILLED_ICONS = {
  utility: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" fill="currentColor" stroke="none" />,
}

/**
 * @param {object} props
 * @param {string} props.type - a `tile_type` value (`chance`/`fortune`/`transport`/`utility`/`tax`/`jail`/`free_parking`/`go_to_jail`); anything else (`go`/`property`) has no icon by design, same as the old `TILE_ICON` map's own coverage
 * @param {string} [props.className]
 */
export default function TileIcon({ type, className }) {
  const outline = OUTLINE_ICONS[type]
  const filled = FILLED_ICONS[type]
  if (!outline && !filled) return null

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {outline ?? filled}
    </svg>
  )
}
