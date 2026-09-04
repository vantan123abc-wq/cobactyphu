import styles from './BoardTile.module.css'
import { GROUP_COLORS, CHANCE_FORTUNE_COLOR, playerColor } from './tileVisuals'
import { archetypeMeta, maxTier } from './synergy'
import { trapIcon, trapLabel } from './traps'
import TileIcon from './TileIcon'
import GoTileArt from './GoTileArt'
import JailArt from './JailArt'
import GoToJailArt from './GoToJailArt'
import EventTileArt from './EventTileArt'

// Mirrors PropertyManager.jsx's own mirrored backend constant
// (properties.upgrade_level CHECK 0-5, 5 = hotel) — redeclared per file, no
// shared package between frontend components for this, same standing as
// every other mirrored constant in this codebase.
const MAX_UPGRADE_LEVEL = 5

/**
 * One board square. Still no store access of its own (P11-T09 kept
 * GameBoard.jsx as the one place that looks up `properties`/selection state,
 * same division of labor `playersByPosition` already established) — `onClick`
 * arrives pre-bound from GameBoard, already `undefined` for tiles with no
 * matching Property row (go/chance/fortune/tax/corners), so this component
 * doesn't need to know *why* a tile isn't clickable, only whether it is.
 * `owner`/`upgradeLevel` follow the same pattern (2026-08-22, user request:
 * show ownership/houses directly on the board, not only once a tile is
 * selected) — GameBoard.jsx resolves `property.ownerId` to the real
 * PlayerGameState once per tile, this component just renders whatever it's
 * handed.
 *
 * Player tokens are no longer rendered here (moved to GameBoard.jsx's own
 * absolutely-positioned overlay, 2026-08-21 board-animation slice) — CSS
 * Grid has no way to transition a `grid-row`/`grid-column` change, so a
 * token that needs to slide smoothly between two tiles can't live as a
 * grid-item child of whichever tile currently "owns" it; it has to be
 * positioned independently of the grid, over the top of it.
 * @param {object} props
 * @param {import('../../../../backend/src/domain/tile.js').Tile} props.tile
 * @param {boolean} props.isCorner
 * @param {'left'|'top'|'right'|'bottom'|'corner'} [props.edge] - which board edge this tile sits on (GameBoard.jsx's computeEdge). Drives which side the color band sits on (always the one facing the board's centre) and which way the text runs, so both match a real printed board — see BoardTile.module.css.
 * @param {boolean} [props.isSelected] - true when this tile's property is PropertyManager.jsx's current selection
 * @param {() => void} [props.onClick] - only set by GameBoard when this tile has a matching Property row; selecting is independent of who owns it.
 * @param {object} [props.owner] - PlayerGameState of this tile's property owner, or null/undefined when unowned or not ownable at all.
 * @param {number} [props.upgradeLevel] - property.upgradeLevel (0 = no houses, 1-4 = houses, 5 = hotel); 0 when unowned/not ownable. `mortgaged` is deliberately not shown here — PropertyManager.jsx (opened by selecting the tile) owns that level of detail.
 * @param {string} [props.rentPreview] - what landing on this tile costs right now (GameBoard.jsx's rentPreview.js#rentLabel — "$130", "10× xúc xắc", "Cầm cố", ...), only meaningful once owned. Deliberately the RENT, not `tile.price` — a real user correction, 2026-08-25: "số tiền này là số tiền khi giẫm vào phải trả mà" (this number is what you pay when you land on it) — the purchase price stops being the relevant figure the instant a tile is owned.
 * @param {boolean} [props.isTargetable] - PLACE_TRAP target-picking (ASYMMETRIC, GameBoard.jsx's own trapDraft) — true for EVERY tile while a trap is being aimed, not just the ones with a Property row (trapEngine.js's validateTrapPlacement has no ownership restriction). Drives a distinct crosshair affordance so "pick any tile" reads differently from the normal "select this property" click.
 * @param {{archetype: string, tier: number, owned: number}} [props.synergy] - [ASYMMETRIC] this tile's live Thế Lực contribution, resolved once per render by GameBoard.jsx (synergy.js#synergyByTileId) — absent for an unowned/mortgaged tile, for one whose owner is still below tier 1, and always in CLASSIC. Drives the archetype-coloured glow that answers "which of these tiles are actually doing something right now", which is otherwise invisible: synergies are derived from a whole portfolio, so nothing about a single tile reveals its own tier.
 * @param {{tileIndex: number, type: string, expiresAtRound: number}} [props.trap] - [ASYMMETRIC] a trap standing on this tile — **only ever the viewer's OWN**. The server redacts every other player's trap down to an anonymous, position-less stub before it leaves the room (engine/stateRedaction.js), so this component cannot render, and was never told, where an opponent's trap is.
 * @param {object} [props.style] - grid placement, set by GameBoard
 */
/**
 * One 3D building standing on a tile — four walls in the owner's colour
 * plus a real four-sided hip roof (mái tứ giác). Factored out 2026-08-23
 * when the roof went from one face to four and the markup would otherwise
 * have been nine identical divs written twice; the wall structure itself
 * is unchanged from the original hand-authored version.
 *
 * Every dimension lives in BoardTile.module.css (--w/--wall-h/--roof-run
 * on .house3d/.hotel3d) — see that file for why the previous single flat
 * roof face made the buildings look sunk into the board.
 */
function Building({ kind, color }) {
  return (
    <div className={kind} style={{ '--house-color': color }}>
      <div className={`${styles.face} ${styles.faceFront}`} />
      <div className={`${styles.face} ${styles.faceBack}`} />
      <div className={`${styles.face} ${styles.faceRight}`} />
      <div className={`${styles.face} ${styles.faceLeft}`} />
      <div className={`${styles.roof} ${styles.roofFront}`} />
      <div className={`${styles.roof} ${styles.roofBack}`} />
      <div className={`${styles.roof} ${styles.roofRight}`} />
      <div className={`${styles.roof} ${styles.roofLeft}`} />
    </div>
  );
}

export default function BoardTile({ tile, isCorner, edge, isSelected, onClick, isTargetable, synergy, trap, owner, upgradeLevel = 0, rentPreview, style }) {
  const groupColor = tile.groupId ? GROUP_COLORS[tile.groupId] : undefined;
  const bandColor = CHANCE_FORTUNE_COLOR[tile.tileType] ?? groupColor;
  const ownerColor = owner ? playerColor(owner) : null;
  const synergyMeta = synergy ? archetypeMeta(synergy.archetype) : null;

  function handleKeyDown(e) {
    if (!onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  }

  // Any owned tile GameBoard.jsx could compute a real rent preview for —
  // property, transport, or utility alike. `rentPreview` arrives as
  // `undefined` for anything unowned, so this doubles as the ownership
  // check without needing `owner` here at all.
  const showOwnedPrice = !isCorner && rentPreview != null;

  return (
    <div
      className={`${styles.tile} ${styles[edge] ?? ''} ${isCorner ? styles.corner : ''} ${isSelected ? styles.selected : ''} ${onClick ? styles.clickable : ''} ${isTargetable ? styles.targetable : ''} ${synergyMeta ? styles.synergy : ''}`}
      style={{
        ...style,
        ...(ownerColor ? { '--owner-color': ownerColor } : {}),
        // Tier drives INTENSITY, not hue — one archetype keeps one colour at
        // every tier, so the board reads as "these are all Tử Địa" at a
        // glance and the brightness says how far along that set is.
        ...(synergyMeta ? { '--synergy-color': synergyMeta.color, '--synergy-tier': synergy.tier } : {}),
      }}
      title={tile.name}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? handleKeyDown : undefined}
    >
      {bandColor && !isCorner && tile.tileType !== 'chance' && tile.tileType !== 'fortune' && (
        <div className={styles.band} style={{ background: bandColor }} />
      )}

      {/* Live Thế Lực marker. Sits opposite .ownedPrice (which uses the tile's
          own "tail" edge) so an owned tile powering a synergy shows both
          without them ever overlapping. Filled pips, one per tier reached,
          out of the archetype's own maximum — a shape, not a number, because
          it has to stay readable at a board tile's real on-screen size. */}
      {synergyMeta && (
        <div
          className={styles.synergyBadge}
          title={`${synergyMeta.label} — Thế lực cấp ${synergy.tier}/${maxTier(synergy.archetype)} (${synergy.owned} ô). ${synergyMeta.effect}`}
        >
          {'◆'.repeat(synergy.tier)}
        </div>
      )}

      {/* The viewer's own trap. Drawn faint on purpose: it is a reminder of
          where you set it, not a highlight — and every other player's board
          shows nothing at all on this tile (see the `trap` prop's own note). */}
      {trap && (
        <div className={styles.trapMarker} title={`Bẫy của bạn — ${trapLabel(trap.type)}`}>
          {trapIcon(trap.type)}
        </div>
      )}

      {/* Permanent RENT readout for an OWNED tile (2026-08-25, user request:
          "các ô đã được mua thì ở đuôi ô có hiển thị thêm giá tiền" —
          clarified via a Business Tour reference screenshot to mean
          always-on and prominent, not a hover/tap reveal; then corrected
          again same day: "số tiền này là số tiền khi giẫm vào phải trả mà"
          — this must be what LANDING here costs, not `tile.price` (what it
          cost to buy). GameBoard.jsx computes the real figure via
          rentPreview.js#rentLabel and passes it down as `rentPreview`, the
          same "resolve once in GameBoard, this component just renders it"
          division of labour `owner`/`upgradeLevel` already use.
          Sits directly on .tile, not inside .content — positioned via
          `inset-block-end` (a writing-mode-aware logical offset, not
          physical `bottom`) so ONE rule lands on the correct real edge for
          all four board sides without hand-written per-edge overrides: it
          resolves against each tile's own `writing-mode` before the
          decorative whole-tile `rotateZ(180deg)` (.top/.right) is applied,
          the exact same "local coordinate, rotated as one rigid unit" trick
          .band's own flex-order-based positioning above already relies on
          to always face the board's centre — this lands on the OPPOSITE
          edge (đuôi/"tail"), verified against that same logic across all 4
          edges live rather than guessed. */}
      {showOwnedPrice && (
        <div className={styles.ownedPrice}>
          {/* The pill is a nested child, not text directly inside
              .ownedPrice — CSS's own `.ownedPrice > *` rule (background/
              padding/radius) needs a real child element to match against. */}
          <span>{rentPreview}</span>
        </div>
      )}

      <div className={styles.content}>
        {isCorner ? (
          tile.tileType === 'go' ? (
            <GoTileArt />
          ) : tile.tileType === 'jail' ? (
            <JailArt />
          ) : tile.tileType === 'go_to_jail' ? (
            <GoToJailArt />
          ) : (
            <>
              <TileIcon type={tile.tileType} className={styles.cornerIcon} />
              <span className={styles.name} style={{ fontSize: '1.2em', marginTop: '0.2em' }}>{tile.name}</span>
            </>
          )
        ) : tile.tileType === 'chance' || tile.tileType === 'fortune' ? (
          <EventTileArt type={tile.tileType} />
        ) : (
          <>
            <TileIcon type={tile.tileType} className={styles.icon} />
            <span className={styles.name}>{tile.name}</span>
            {/* Unowned only, as of 2026-08-25 — .ownedPrice above now
                covers the owned case permanently, and showing the price
                twice on the same tile would be real, avoidable clutter. */}
            {tile.tileType === 'property' && typeof tile.price === 'number' && !owner && (
              <span className={styles.price}>${tile.price}</span>
            )}
            {tile.tileType === 'tax' && typeof tile.taxAmount === 'number' && <span className={styles.price}>${tile.taxAmount}</span>}
          </>
        )}
      </div>

      {upgradeLevel > 0 && !isCorner && (
        <div className={styles.buildings3d}>
          {upgradeLevel >= MAX_UPGRADE_LEVEL ? (
            <Building kind={styles.hotel3d} color={ownerColor} />
          ) : (
            Array.from({ length: upgradeLevel }).map((_, i) => (
              <Building key={i} kind={styles.house3d} color={ownerColor} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
