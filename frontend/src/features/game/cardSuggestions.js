// "You are holding a card that would help RIGHT NOW" — 2026-09-03, user
// request: "hãy có phép hệ thống tự đề xuất cho người chơi nếu vào tình huống
// cần dùng thẻ, ví dụ như khi vào tù mà đang có thẻ ra tù".
//
// Why this is needed at all: a keepable card does nothing on draw. It banks
// into PlayerGameState.inventory and only acts when the player themselves
// plays it via USE_INVENTORY_CARD. Nothing in the game ever pointed at the
// right moment to do that, so a card could sit unused through exactly the turn
// it was meant for.
//
// The jail case the request names is the sharpest example, and it is worse
// than it looks because the deck has TWO different jail mechanisms:
//   - C09_LUAT_SU is not keepable; it increments `jailFreeCards` the moment
//     it is drawn, and GameControls' jail row already has a button for that
//     counter.
//   - VE_SO_TRUNG_AN_UI *is* keepable. Holding it does not give you a jail
//     card — you must play it out of the inventory FIRST, which then grants
//     the counter, and only then can you use it to leave. Two steps, in two
//     different panels, with nothing connecting them.
// So a jailed player could be holding their way out and never know.
//
// Matching is done on the card's own INTENTS rather than on card ids. The
// deck is small enough that hardcoding ids would work today, but this file
// would then silently stop covering any card added later — the same drift the
// deleted frontend `eventCardDictionary.js` mirror was killed for. Intents
// arrive on the wire from GET /api/v1/event-cards already.

/**
 * Every intent action a card can produce, including the ones nested inside
 * options, probability branches and die-face tables — the same walk the
 * backend's own resolver does.
 */
function intentActionsOf(card) {
  const found = new Set()
  const walk = (intents) => {
    for (const intent of intents ?? []) {
      if (!intent?.action) continue
      found.add(intent.action)
      for (const branch of ['onSuccess', 'onFailure']) {
        if (Array.isArray(intent[branch])) walk(intent[branch])
      }
      if (intent.table) for (const outcome of Object.values(intent.table)) walk(outcome)
    }
  }
  walk(card?.intents)
  for (const option of card?.options ?? []) walk(option.intents)
  return found
}

/**
 * Which held cards are worth playing in the current situation, most pressing
 * first.
 *
 * Deliberately conservative: a suggestion the player did not want is a nag on
 * a panel they have to look at every turn, so each rule below fires only where
 * the card's effect is *actionable now*, not merely "relevant someday". C08's
 * protection, for instance, is not suggested just because you own something
 * unimproved — only once a buyout is actually pending against that lot.
 *
 * @returns {Array<{ cardId: string, urgent: boolean, why: string }>}
 */
export function suggestCards({ gameState, me, cards }) {
  if (!gameState || !me || !cards) return []
  const inventory = me.inventory ?? []
  if (inventory.length === 0) return []

  const suggestions = []
  const add = (cardId, urgent, why) => {
    if (!suggestions.some((s) => s.cardId === cardId)) suggestions.push({ cardId, urgent, why })
  }

  // A hostile buyout already pending against one of MY unimproved lots. This
  // is reachable on someone ELSE's turn, which is exactly why it is worth
  // surfacing: USE_INVENTORY_CARD is deliberately turn-independent
  // (socketServer.js's TURN_INDEPENDENT_ACTION_TYPES), so the defence is
  // legal right now — but only for as long as the buyer takes to click.
  const threatenedProperty = gameState.pendingHostileBuyoutPropertyId
    ? gameState.properties?.find(
        (p) => p.id === gameState.pendingHostileBuyoutPropertyId && p.ownerId === me.id && p.upgradeLevel === 0
      )
    : null

  const iAmLiquidating =
    gameState.phase === 'LIQUIDATION_REQUIRED' && gameState.pendingLiquidation?.debtorId === me.id

  for (const cardId of inventory) {
    const card = cards[cardId]
    if (!card) continue // dictionary not loaded — CardInventory reports that separately
    const actions = intentActionsOf(card)

    if (actions.has('GRANT_JAIL_CARD') && me.inJail && (me.jailFreeCards ?? 0) === 0) {
      add(cardId, true, 'Bạn đang ở tù và chưa có Thẻ Ra Tù nào. Dùng thẻ này để nhận một thẻ, rồi bấm "Dùng Thẻ Miễn Phí" ở khu hành động.')
    }

    if (actions.has('ADD_MONEY') && iAmLiquidating) {
      add(cardId, true, 'Bạn đang phải thanh lý tài sản để trả nợ — thẻ này cho thêm tiền mặt, có thể đỡ phải bán nhà.')
    }

    if (actions.has('GRANT_PROPERTY_PROTECTION') && threatenedProperty) {
      add(cardId, true, 'Có người đang chuẩn bị thâu tóm một ô đất trống của bạn. Dùng thẻ này để bảo vệ nó — thẻ dùng được cả khi không phải lượt bạn.')
    }

    // Not urgent: nothing is lost by waiting, the discount just goes unused
    // on this particular build.
    if (actions.has('GRANT_NEXT_BUILD_DISCOUNT') && gameState.phase === 'AWAITING_UPGRADE' && !(me.nextBuildDiscount > 0)) {
      add(cardId, false, 'Bạn đang được mời xây nhà — dùng thẻ này trước để được giảm giá cho lần xây đó.')
    }
  }

  return suggestions.sort((a, b) => Number(b.urgent) - Number(a.urgent))
}
