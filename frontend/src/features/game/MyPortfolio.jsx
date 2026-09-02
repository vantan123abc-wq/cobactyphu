import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useGameStore } from '../../store/gameStore'
import { GROUP_COLORS } from '../board/tileVisuals'
import TileIcon from '../board/TileIcon'
import { propertyValue } from './netWorthMirror'
import styles from './MyPortfolio.module.css'

// "Bất động sản đang sở hữu" — the local player's own portfolio at a
// glance (2026-08-23, user request).
//
// Fills a real gap rather than duplicating an existing panel: until now the
// only way to inspect a property you own was to hunt for its tile on the
// isometric board and click it (PropertyManager.jsx), and the only overview
// anywhere was PlayersPanel.jsx's row of anonymous coloured dots — which
// shows *that* you own six things but never which, how built up, or whether
// any are mortgaged. Every row here selects that property, so this is also
// the fast way INTO PropertyManager's existing build/sell/mortgage actions;
// it deliberately carries no action buttons of its own, so there stays
// exactly one place in the app that can mutate a property.
//
// Grouped by colour set, because that's the unit the game's own economy
// works in (calculateRent.js's group bonus, turnMachine.js's build
// preconditions) — "2/3 đỏ" is strategically the thing a player needs to
// see, and a flat alphabetical list would hide it.

const MAX_UPGRADE_LEVEL = 5 // mirrors domain/property.js, same as PropertyManager.jsx's own copy

// Vietnamese labels for the real group_id slugs in
// backend/supabase/seed/boards.sql (the same eight keys tileVisuals.js's
// GROUP_COLORS is built on).
const GROUP_LABEL = {
  red: 'Đỏ',
  cyan: 'Xanh Ngọc',
  purple: 'Tím',
  orange: 'Cam',
  yellow: 'Vàng',
  green: 'Lục',
  blue: 'Lam',
  darkblue: 'Xanh Đậm',
}

// propertyValue lived here as a private function until 2026-08-25, when
// PlayersPanel.jsx's live standings needed the identical maths — moved to
// netWorthMirror.js rather than copied a second time. See that file's header
// for why it has to match the server's figure exactly, not approximately.

export default function MyPortfolio() {
  const { user } = useAuth()
  const gameState = useGameStore((s) => s.currentGameState)
  const staticBoard = useGameStore((s) => s.staticBoard)
  const selectedPropertyId = useGameStore((s) => s.selectedPropertyId)
  const selectProperty = useGameStore((s) => s.selectProperty)

  const [isExpanded, setIsExpanded] = useState(true)

  if (!gameState || !staticBoard) return null
  const me = gameState.players.find((p) => p.playerId === user.id)
  if (!me) return null

  const holdings = gameState.properties
    .filter((p) => p.ownerId === me.id)
    .map((property) => ({ property, tile: staticBoard.tiles.find((t) => t.id === property.boardTileId) }))
    .filter((h) => h.tile)

  const totalValue = holdings.reduce((sum, h) => sum + propertyValue(h.tile, h.property), 0)
  const transportCount = holdings.filter((h) => h.tile.tileType === 'transport').length
  const utilityCount = holdings.filter((h) => h.tile.tileType === 'utility').length

  // Bucket by colour set, with transport/utility as their own two buckets —
  // their rent is driven by how many you hold, not by a colour group.
  const buckets = new Map()
  for (const h of holdings) {
    const key = h.tile.tileType === 'property' ? `group:${h.tile.groupId ?? '_'}` : `type:${h.tile.tileType}`
    if (!buckets.has(key)) buckets.set(key, { key, tileType: h.tile.tileType, groupId: h.tile.groupId, items: [] })
    buckets.get(key).items.push(h)
  }

  const groups = [...buckets.values()]
    .map((b) => {
      const totalInSet =
        b.tileType === 'property' && b.groupId
          ? staticBoard.tiles.filter((t) => t.groupId === b.groupId).length
          : staticBoard.tiles.filter((t) => t.tileType === b.tileType).length
      // calculateRent.js's group bonus needs: the whole set owned, and every
      // member unmortgaged. It USED to also require the property unimproved
      // (upgradeLevel 0) — that check was removed on 2026-09-02, the bonus
      // now doubles rent at every level. So "complete + none mortgaged" is
      // the full condition, per-group, no per-property nuance left.
      const complete = b.items.length === totalInSet && totalInSet > 0
      // "None mortgaged" — the other precondition of hasGroupBonus()
      // (calculateRent.js), alongside owning the whole set.
      const noneMortgaged = b.items.every((h) => !h.property.mortgaged)
      return { ...b, totalInSet, complete, noneMortgaged, order: Math.min(...b.items.map((h) => h.tile.position)) }
    })
    .sort((a, b) => a.order - b.order)

  // Since 2026-09-02 the group bonus is a per-GROUP condition: complete set,
  // nothing mortgaged, applied at every development level. (It used to be
  // per-property — only helping an unimproved member — which is why this was
  // a row-level check and an earlier "×2 on the group header" draft was
  // wrong. That reasoning is now inverted: every row in a qualifying set
  // gets it.) `property` is kept in the signature for call-site symmetry.
  function rowHasBonus(group) {
    return group.tileType === 'property' && group.complete && group.noneMortgaged
  }

  const completeSets = groups.filter((g) => g.tileType === 'property' && g.complete).length

  // Rent at the property's current level. The ×2 monopoly bonus IS folded in
  // now (2026-09-02): since its revision it is a flat, exact, dice-free
  // doubling whenever the set is complete and unmortgaged, so there is no
  // branch left to drift from — and it is the single largest factor in
  // property rent, so omitting it showed players half the real number. The
  // ×2 badge beside this stays, as the explanation of why the figure is
  // doubled. Utility rent still depends on a future dice roll and has no
  // fixed figure.
  function rentLabel(tile, property, groupBonus) {
    if (tile.tileType === 'property') {
      const printed = property.upgradeLevel === 0 ? tile.baseRent : tile.rentTable?.[property.upgradeLevel - 1]
      if (typeof printed !== 'number') return '—'
      return groupBonus ? `$${printed * 2}` : `$${printed}`
    }
    // Transport rent is a plain doubling by how many you hold — exact, with
    // no branch to drift from, so the real current figure is shown.
    if (tile.tileType === 'transport') {
      return typeof tile.baseRent === 'number' ? `$${tile.baseRent * Math.pow(2, transportCount - 1)}` : '—'
    }
    return utilityCount >= 2 ? '10× xúc xắc' : '4× xúc xắc'
  }

  return (
    <div className={styles.panel}>
      <button
        type="button"
        className={styles.headerBtn}
        onClick={() => setIsExpanded(!isExpanded)}
        title={isExpanded ? 'Thu gọn danh sách' : 'Mở rộng danh sách'}
      >
        <h2 className={styles.heading}>Bất Động Sản</h2>
        <span className={styles.count}>{holdings.length}</span>
        <span className={styles.toggleIcon}>{isExpanded ? '▼' : '▶'}</span>
      </button>

      {isExpanded && (
        <div className={styles.body}>
          {holdings.length === 0 ? (
            <p className={styles.empty}>Bạn chưa sở hữu ô đất nào.</p>
          ) : (
            <>
              <div className={styles.summary}>
                <div className={styles.summaryCell}>
                  <span className={styles.summaryLabel}>Giá trị</span>
                  <span className={styles.summaryValue}>${totalValue}</span>
                </div>
                <div className={styles.summaryCell}>
                  <span className={styles.summaryLabel}>Trọn bộ</span>
                  <span className={styles.summaryValue}>{completeSets}</span>
                </div>
              </div>

              <div className={styles.groups}>
                {groups.map((g) => (
                  <div key={g.key} className={styles.group}>
                    <div className={styles.groupHeader}>
                      {g.tileType === 'property' ? (
                        <span className={styles.swatch} style={{ background: GROUP_COLORS[g.groupId] ?? '#6b7280' }} />
                      ) : (
                        <TileIcon type={g.tileType} className={styles.groupIcon} />
                      )}
                      <span className={styles.groupName}>
                        {g.tileType === 'property'
                          ? (GROUP_LABEL[g.groupId] ?? 'Khác')
                          : g.tileType === 'transport'
                            ? 'Bến xe'
                            : 'Công ty'}
                      </span>
                      <span className={styles.groupCount}>
                        {g.items.length}/{g.totalInSet}
                      </span>
                      {g.complete && <span className={styles.completeBadge} title="Đã sở hữu trọn bộ">✓</span>}
                    </div>

                    {g.items.map(({ tile, property }) => (
                      <button
                        key={property.id}
                        type="button"
                        className={`${styles.row} ${property.mortgaged ? styles.mortgagedRow : ''} ${
                          selectedPropertyId === property.id ? styles.selectedRow : ''
                        }`}
                        onClick={() => selectProperty(property.id)}
                        title={`${tile.name}${property.mortgaged ? ' — đang cầm cố' : ''}`}
                      >
                        <span className={styles.rowName}>{tile.name}</span>
                        {property.upgradeLevel > 0 && (
                          <span className={styles.rowBuildings}>
                            {property.upgradeLevel === MAX_UPGRADE_LEVEL ? '🏨' : '🏠'.repeat(property.upgradeLevel)}
                          </span>
                        )}
                        {property.mortgaged ? (
                          <span className={styles.rowMortgaged}>CẦM CỐ</span>
                        ) : (
                          <span className={styles.rowRent}>
                            {rentLabel(tile, property, rowHasBonus(g))}
                            {rowHasBonus(g) && (
                              <span className={styles.rowBonus} title="Trọn bộ nhóm màu, không ô nào cầm cố — tiền thuê nhân đôi ở mọi mức xây">
                                ×2
                              </span>
                            )}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
