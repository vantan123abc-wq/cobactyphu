// Event Card dictionary — a "Decision & Moment System": some cards resolve
// instantly, others hand the drawing player a choice, one option of which
// may carry a probabilistic outcome. This is a second, additive EventCard
// model, deliberately NOT unifying with the existing domain/eventCard.js
// (GAME_DESIGN_SPEC.md §13's approved shape: id, deck, text, one flat
// deterministic effect — pay(n)/receive(n)/move_to(tile)/...). Per explicit
// direction: the two coexist; reconciling them, or retiring one, is a
// separate decision not made here. This mechanic itself has no grounding in
// any approved doc yet (not even tagged [PROPOSED] anywhere, unlike Flash
// Auction before its own confirmation pass) — built on direct instruction,
// same as Flash Auction was, but this one hasn't had a docs pass yet.
//
// Pure data: no I/O, no randomness, no framework import. Every level is
// frozen so nothing importing EVENT_CARDS can mutate the shared dictionary.

export const EVENT_CARD_TYPES = Object.freeze(['INSTANT', 'CHOICE']);

// The action vocabulary settlement intents and option intents use.
// ADD_MONEY/REMOVE_MONEY are terminal settlement intents (what a future
// orchestrator actually applies, e.g. via economy/applyTransaction.js);
// PROBABILITY is resolved away by engine/eventResolver.js's resolveChoice
// before its result is ever returned — a caller never sees a PROBABILITY
// intent in a final settlement array.
//
// MOVE_TO_JAIL/GRANT_JAIL_CARD (2026-08-22, user request — a real card
// needing "gửi thẳng vào tù" surfaced this system had no movement/inventory
// verb at all): terminal settlement intents, same standing as ADD_MONEY/
// REMOVE_MONEY — stateMachine/turnMachine.js's applyIntents() is what
// actually carries them out (MOVE_TO_JAIL reuses engine/jail.js's own
// sendToJail(), the exact function whose own docstring already listed
// "drawing a matching card" as one of jail's three real entry triggers,
// never wired until now; GRANT_JAIL_CARD increments the new
// PlayerGameState.jailFreeCards field). Neither takes an `amount` — MOVE_TO_JAIL
// needs no parameters (there is only one Jail tile), GRANT_JAIL_CARD always
// grants exactly one card.
//
// *_EACH_PLAYER/*_RICHEST/*_POOREST/*_IF_BALANCE_AT_LEAST/*_PER_DEVELOPMENT
// (2026-08-22, the 24-card "Cơ Hội/Khí Vận" deck brief) — the shared need
// behind 6 of that deck's cards: resolve a money intent against a
// *computed set* of players (everyone; whoever currently has the most/least
// cash, ties included; everyone crossing a cash threshold; a per-player
// amount driven by their own property development), not always the single
// drawing player ADD_MONEY/REMOVE_MONEY already assume. Kept as five
// distinct, narrowly-named intents rather than one generic "selector +
// amount formula" DSL — each pattern is used by exactly one or two real
// cards in the brief, and a fully generic selector system would be
// speculative abstraction for requirements that don't exist yet.
export const EVENT_ACTION_TYPES = Object.freeze([
  'ADD_MONEY',
  'REMOVE_MONEY',
  'PROBABILITY',
  'MOVE_TO_JAIL',
  'GRANT_JAIL_CARD',
  'ADD_MONEY_EACH_PLAYER',
  'REMOVE_MONEY_EACH_PLAYER',
  'REMOVE_MONEY_RICHEST',
  'ADD_MONEY_POOREST',
  'REMOVE_MONEY_IF_BALANCE_AT_LEAST',
  'REMOVE_MONEY_PER_DEVELOPMENT',
  'SET_RENT_MODIFIER_PERCENT',
  'SET_BUILD_COST_MODIFIER',
  'GRANT_NEXT_BUILD_DISCOUNT',
  'GRANT_NEXT_RENT_DISCOUNT',
  'MOVE_RELATIVE',
  'MOVE_TO_NEAREST_UNOWNED_PROPERTY',
  'DIE_FACE_REWARD',
  // C08 "Bảo Vệ Tài Sản" (2026-08-25). Like MOVE_RELATIVE above, it is
  // intercepted in turnMachine.js *before* applyIntents() rather than applied
  // there, because its real input — WHICH property — isn't in the static
  // intent at all: it arrives on the action payload and is validated against
  // live ownership. Nothing actually validates against this array (it is
  // documentary only), which is precisely why it was easy to omit when the
  // card was added — listed here so the vocabulary stays complete.
  'GRANT_PROPERTY_PROTECTION',
]);

// The four before MOVE_RELATIVE above (2026-08-22, same deck) are this
// batch's "temporary buff" pair of mechanisms — deliberately two different
// shapes, not one: SET_RENT_MODIFIER_PERCENT/SET_BUILD_COST_MODIFIER
// (K01/K02/K07/K08) are GLOBAL and round-scoped, expiring automatically at
// the next real round boundary (GameState.rentModifierPercent/
// buildCostModifierAmount's own doc comments); GRANT_NEXT_BUILD_DISCOUNT/
// GRANT_NEXT_RENT_DISCOUNT (C07/C12) are PLAYER-SPECIFIC and one-shot,
// consumed by that one player's own next qualifying action regardless of
// how many rounds that takes (PlayerGameState.nextBuildDiscount/
// nextRentDiscount's own doc comments). Both stack additively where they
// overlap (a build during an active K07/K08 window for a player who also
// holds a C07 discount pays both).
//
// MOVE_RELATIVE/MOVE_TO_NEAREST_UNOWNED_PROPERTY (2026-08-22, phase 4, C01
// "Lối Tắt"/C02 "Chuyến Đi May Mắn") — genuinely different from every
// intent above: these change *where the turn goes next* (a real landing,
// potentially its own whole sub-flow — another card draw, a purchase
// decision, rent, ...), not just a batch of player/GameState field updates.
// stateMachine/turnMachine.js's applyIntents() can't express that (it has
// no access to re-invoke landing resolution), so both are intercepted
// *before* reaching it, in resolveDrawingCard()/handleEventChoice()
// directly — see turnMachine.js's own moveByStepsAndResolve(). PASS_GO is
// credited normally for both (reusing engine/movement.js's real
// movePlayer(), not skipped) — "không tung xúc xắc" in C01's own text is
// about skipping the *dice roll*, not its usual economic side effects.
// MOVE_RELATIVE takes `steps` (a fixed, positive tile count — C01's 3
// options are 1/2/3); MOVE_TO_NEAREST_UNOWNED_PROPERTY takes no parameters,
// resolved by a live forward scan over the real board/properties at
// resolution time, capped at one full lap (the card's own "nếu không có...
// trong một vòng → không có hiệu ứng").
//
// DIE_FACE_REWARD (2026-08-22, same phase, C05 "Cơ Hội Đầu Tư"[risk
// option]/C11 "Cú Đánh Liều") — a real, previously-missing capability: the
// existing PROBABILITY intent is binary (one `chance`, onSuccess/onFailure)
// and can't express a 6-way per-die-face payout table. Takes a `table`
// object keyed '1'-'6', each value its own settlement-intent array (often
// empty, a real "nothing happens" tier) — resolved the same way
// PROBABILITY already is, by engine/eventResolver.js's resolveChoice(),
// against an externally-supplied `dieFaceRoll` (1-6) it never generates
// itself (same "always arrives as an input" convention probabilityRoll
// already established) — infrastructure/websocket/socketServer.js's
// serverGeneratedFields() is what actually rolls it, for MAKE_EVENT_CHOICE
// only. C11's own "trả $50, tung xúc xắc" (no real A-vs-B choice) is still
// modeled as a CHOICE card with exactly one option, specifically to reuse
// this already-proven external-randomness injection point rather than
// building a second one for the INSTANT path, which has no such channel
// today — flagged as a deliberate structural choice, not a misreading of
// the card's own "automatic" framing.

/**
 * @typedef {Object} SettlementIntent
 * @property {('ADD_MONEY'|'REMOVE_MONEY')} action
 * @property {number} amount
 */

/**
 * @typedef {Object} ProbabilityIntent
 * @property {'PROBABILITY'} action
 * @property {number} chance - success probability, in [0, 1)
 * @property {SettlementIntent[]} onSuccess
 * @property {SettlementIntent[]} onFailure
 */

/**
 * @typedef {Object} EventCardOption
 * @property {string} id
 * @property {string} text
 * @property {{amount: number}} [validation] - present only when selecting this option requires a minimum balance
 * @property {(SettlementIntent|ProbabilityIntent)[]} intents
 */

/**
 * @typedef {Object} EventCardDictionaryEntry
 * @property {string} id
 * @property {('INSTANT'|'CHOICE')} type
 * @property {string} text
 * @property {SettlementIntent[]} [intents] - present when type is 'INSTANT'
 * @property {EventCardOption[]} [options] - present when type is 'CHOICE'
 * @property {{field: 'currentBalance', op: 'lt', value: number}} [eligibility] - 2026-08-22 (the 24-card brief's own conditional "comeback" cards, e.g. "chỉ dùng nếu Cash < $300"): when present, the drawing player must satisfy this before the card's own effect applies at all — INSTANT: its intents; CHOICE: entering AWAITING_EVENT_CHOICE at all. An ineligible draw is still fully revealed (lastDrawnEventCardId, the reveal-to-everyone UI) — it's an honest "you drew this but weren't eligible" no-op, not silently swallowed. Only `field: 'currentBalance'` exists today; extend the field union, not the shape, if a future card needs a different gate (net worth, property count, ...).
 * @property {boolean} [keepable] - 2026-08-27 (Card Inventory system): if true, drawing this card pushes its ID into the player's inventory instead of executing it immediately. The player can then trigger it via USE_INVENTORY_CARD later.
 */

/** @type {Object<string, EventCardDictionaryEntry>} */
export const EVENT_CARDS = Object.freeze({
  DIVIDEND_50: Object.freeze({
    id: 'DIVIDEND_50',
    type: 'INSTANT',
    text: 'The Bank pays you a dividend of 50.',
    intents: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 50 })]),
  }),

  INVESTMENT_OPPORTUNITY: Object.freeze({
    id: 'INVESTMENT_OPPORTUNITY',
    type: 'CHOICE',
    text: 'Investment Opportunity: take a safe payout, or risk it for more.',
    options: Object.freeze([
      Object.freeze({
        id: 'OPT_SAFE',
        text: 'Take a guaranteed 200.',
        intents: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 200 })]),
      }),
      Object.freeze({
        id: 'OPT_RISK',
        text: 'Invest 300 for a 50% chance at 900.',
        validation: Object.freeze({ amount: 300 }),
        intents: Object.freeze([
          Object.freeze({ action: 'REMOVE_MONEY', amount: 300 }),
          Object.freeze({
            action: 'PROBABILITY',
            chance: 0.5,
            onSuccess: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 900 })]),
            onFailure: Object.freeze([]),
          }),
        ]),
      }),
    ]),
  }),

  // Real Vietnamese-flavor content, 2026-08-22 (user request, "Xin Xăm"/Khí
  // Vận and "Vé Số"/Cơ Hội concepts — see docs/PROJECT_STATUS.md for the
  // full brief). Deliberately NOT tagged by deck (chance vs. fortune) —
  // this dictionary still has no deck-membership field at all (an
  // already-documented, separate gap, resolveDrawingCard's own header:
  // "known simplification, not a considered design decision"); not
  // resolved here, out of this pass's own scope.
  CHUNG_CU_MINI_THU_TIEN: Object.freeze({
    id: 'CHUNG_CU_MINI_THU_TIEN',
    type: 'INSTANT',
    text: 'Khu chung cư mini của bạn tháng này khách thuê kín phòng, thu ngay $100 tiền trọ.',
    intents: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 100 })]),
  }),

  QUY_TO_DAN_PHO: Object.freeze({
    id: 'QUY_TO_DAN_PHO',
    type: 'INSTANT',
    text: 'Đóng quỹ tổ dân phố và quỹ khuyến học xóm: Trừ $50.',
    intents: Object.freeze([Object.freeze({ action: 'REMOVE_MONEY', amount: 50 })]),
  }),

  XE_CONG_NGHE_GIO_CAO_DIEM: Object.freeze({
    id: 'XE_CONG_NGHE_GIO_CAO_DIEM',
    type: 'INSTANT',
    text: 'Chạy cuốc xe công nghệ giờ cao điểm trời mưa, khách tip đậm. Nhận $50.',
    intents: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 50 })]),
  }),

  // The flagship new-capability card — the concrete example that surfaced
  // this dictionary had no movement verb at all until today. No REMOVE_MONEY
  // fine attached — the user's own example named only the jail effect, not
  // an extra penalty, so none is invented here.
  CHAY_QUA_TOC_DO: Object.freeze({
    id: 'CHAY_QUA_TOC_DO',
    type: 'INSTANT',
    text: 'Chạy quá tốc độ. Lập tức đi thẳng vào Tù, không được nhận tiền xuất phát.',
    intents: Object.freeze([Object.freeze({ action: 'MOVE_TO_JAIL' })]),
  }),

  // The other half of today's new-capability pair — closes a real,
  // separately-found gap the same session: engine/jail.js's useCard() has
  // always released a player from jail with no check they actually held a
  // card (PlayerGameState had no inventory field for it to check). Now that
  // GRANT_JAIL_CARD/jailFreeCards exist, this is the one real source of a
  // legitimately-held card.
  VE_SO_TRUNG_AN_UI: Object.freeze({
    id: 'VE_SO_TRUNG_AN_UI',
    type: 'INSTANT',
    keepable: true,
    text: 'Bạn trúng an ủi một tờ vé số, kèm theo một phiếu bảo lãnh tại ngoại — giữ lại, dùng khi cần thoát khỏi cảnh ngồi tù!',
    intents: Object.freeze([Object.freeze({ action: 'GRANT_JAIL_CARD' })]),
  }),

  // ── 24-card "Cơ Hội/Khí Vận" deck, 2026-08-22 — phases 1+2 (cards that
  // work with intents that already existed, plus the "targets a computed
  // player-set" intents added alongside that batch) and phase 3 (the
  // "temporary buff" pair of mechanisms — global/round-scoped and player-
  // specific/one-shot). Card ids below are prefixed with the user's own
  // C##/K## numbering (their design doc's real reference) for traceability
  // back to it — not a naming convention this file used before. Still not
  // added — needing capabilities that don't exist yet (dynamic board-state-
  // dependent movement; deferred/queued obligations; dice-face-tiered
  // rewards; C03's own "adjust the next roll" needs a real new player
  // interaction, not a passive modifier, so it's grouped with those, not
  // this batch's other buffs) — see PROJECT_STATUS.md for the full phase
  // breakdown.

  C04_KHOAN_DAU_TU_AN_TOAN: Object.freeze({
    id: 'C04_KHOAN_DAU_TU_AN_TOAN',
    type: 'INSTANT',
    text: 'Một khoản đầu tư nhỏ mang lại lợi nhuận chắc chắn. Nhận +$75.',
    intents: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 75 })]),
  }),

  K05_HOAN_THUE: Object.freeze({
    id: 'K05_HOAN_THUE',
    type: 'INSTANT',
    text: 'Bạn được hoàn thuế. Nhận +$100.',
    intents: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 100 })]),
  }),

  // C08 — the deck's own first eligibility-gated card. "Nếu cash >= $300 ->
  // không thể sử dụng" is implemented as a real, revealed no-op (see the
  // `eligibility` field's own doc comment above), not a card that somehow
  // avoids being drawn at all — nothing in this engine knows a player's
  // state at shuffle time, only at resolution time.
  C08_CUU_HO_TAI_CHINH: Object.freeze({
    id: 'C08_CUU_HO_TAI_CHINH',
    type: 'INSTANT',
    text: 'Bạn được hỗ trợ trong thời điểm khó khăn. Nếu tiền mặt dưới $300, nhận +$100.',
    eligibility: Object.freeze({ field: 'currentBalance', op: 'lt', value: 300 }),
    intents: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 100 })]),
  }),

  // C09 — Luật Sư. The design doc's own two sub-options ("miễn phí Jail" /
  // "thoát Jail ngay") resolve to the exact same mechanical outcome once
  // actually specified (released from jail, no fine charged) — there's no
  // real second exit *path* being described, both just describe "get out
  // free" from two flavor angles. Rather than invent an arbitrary mechanical
  // difference the brief doesn't actually specify, this reuses the real
  // Get Out of Jail Free inventory (jailFreeCards/GRANT_JAIL_CARD) verbatim
  // instead of a second, functionally-identical parallel system — flagged
  // here plainly as a deliberate simplification, not an oversight. If a
  // real distinct mechanic for "waive a specific owed fine" is wanted
  // later, that's a genuine new design question, not a guess to make here.
  C09_LUAT_SU: Object.freeze({
    id: 'C09_LUAT_SU',
    type: 'INSTANT',
    text: 'Một người đại diện pháp lý giúp bạn xử lý rắc rối — bạn nhận một Thẻ Miễn Phí Ra Tù.',
    intents: Object.freeze([Object.freeze({ action: 'GRANT_JAIL_CARD' })]),
  }),

  K03_NGAY_HOI_THANH_PHO: Object.freeze({
    id: 'K03_NGAY_HOI_THANH_PHO',
    type: 'INSTANT',
    text: 'Cả thành phố tổ chức lễ hội! Mọi người chơi đều nhận +$50.',
    intents: Object.freeze([Object.freeze({ action: 'ADD_MONEY_EACH_PLAYER', amount: 50 })]),
  }),

  K04_PHI_DICH_VU_CONG: Object.freeze({
    id: 'K04_PHI_DICH_VU_CONG',
    type: 'INSTANT',
    text: 'Đến kỳ đóng phí dịch vụ công. Mọi người chơi đều trả $25 cho ngân hàng.',
    intents: Object.freeze([Object.freeze({ action: 'REMOVE_MONEY_EACH_PLAYER', amount: 25 })]),
  }),

  // K06 — money removed here disappears from the economy entirely (paid to
  // the Bank, per the brief's own "tránh tạo snowball" reasoning), not
  // redistributed to the drawer — REMOVE_MONEY_RICHEST's own applyIntents
  // branch always targets the Bank as the recipient, same as a plain
  // REMOVE_MONEY intent already does.
  K06_KIEM_TOAN_TAI_CHINH: Object.freeze({
    id: 'K06_KIEM_TOAN_TAI_CHINH',
    type: 'INSTANT',
    text: 'Kiểm toán tài chính toàn bàn! Người chơi có tiền mặt cao nhất phải trả $100 cho ngân hàng (nếu hòa, mỗi người trả $50).',
    intents: Object.freeze([Object.freeze({ action: 'REMOVE_MONEY_RICHEST', amount: 100, tiedAmount: 50 })]),
  }),

  K09_BAO_TRI_DO_THI: Object.freeze({
    id: 'K09_BAO_TRI_DO_THI',
    type: 'INSTANT',
    text: 'Đến kỳ bảo trì đô thị. Mỗi người chơi trả $25 cho mỗi cấp độ nhà/khách sạn đang sở hữu.',
    intents: Object.freeze([Object.freeze({ action: 'REMOVE_MONEY_PER_DEVELOPMENT', amountPerLevel: 25 })]),
  }),

  K10_QUY_HO_TRO_THANH_PHO: Object.freeze({
    id: 'K10_QUY_HO_TRO_THANH_PHO',
    type: 'INSTANT',
    text: 'Quỹ hỗ trợ thành phố dành cho người khó khăn nhất. Người chơi có tiền mặt thấp nhất nhận +$100 (nếu hòa, mỗi người nhận $75).',
    intents: Object.freeze([Object.freeze({ action: 'ADD_MONEY_POOREST', amount: 100, tiedAmount: 75 })]),
  }),

  K12_NGAY_THUE: Object.freeze({
    id: 'K12_NGAY_THUE',
    type: 'INSTANT',
    text: 'Ngày thuế! Mọi người chơi có tiền mặt từ $1000 trở lên phải trả $100 cho ngân hàng.',
    intents: Object.freeze([Object.freeze({ action: 'REMOVE_MONEY_IF_BALANCE_AT_LEAST', amount: 100, threshold: 1000 })]),
  }),

  // ── Phase 3: the "temporary buff" pair of mechanisms — see the
  // EVENT_ACTION_TYPES block comment above for global/round-scoped vs.
  // player-specific/one-shot.
  K01_THI_TRUONG_SOI_DONG: Object.freeze({
    id: 'K01_THI_TRUONG_SOI_DONG',
    type: 'INSTANT',
    text: 'Thị trường bất động sản sôi động! Trong vòng này, tiền thuê đất tăng 10%.',
    intents: Object.freeze([Object.freeze({ action: 'SET_RENT_MODIFIER_PERCENT', percent: 10 })]),
  }),

  K02_THI_TRUONG_SUY_THOAI: Object.freeze({
    id: 'K02_THI_TRUONG_SUY_THOAI',
    type: 'INSTANT',
    text: 'Thị trường suy thoái. Trong vòng này, tiền thuê đất giảm 10%.',
    intents: Object.freeze([Object.freeze({ action: 'SET_RENT_MODIFIER_PERCENT', percent: -10 })]),
  }),

  K07_GIA_VAT_LIEU_TANG: Object.freeze({
    id: 'K07_GIA_VAT_LIEU_TANG',
    type: 'INSTANT',
    text: 'Giá vật liệu xây dựng tăng. Trong vòng này, mỗi lần xây nhà tốn thêm $50.',
    intents: Object.freeze([Object.freeze({ action: 'SET_BUILD_COST_MODIFIER', amount: 50 })]),
  }),

  K08_VAT_LIEU_GIAM_GIA: Object.freeze({
    id: 'K08_VAT_LIEU_GIAM_GIA',
    type: 'INSTANT',
    text: 'Vật liệu xây dựng giảm giá. Trong vòng này, mỗi lần xây nhà được giảm $50.',
    intents: Object.freeze([Object.freeze({ action: 'SET_BUILD_COST_MODIFIER', amount: -50 })]),
  }),

  C07_GIAM_GIA_XAY_DUNG: Object.freeze({
    id: 'C07_GIAM_GIA_XAY_DUNG',
    type: 'INSTANT',
    keepable: true,
    text: 'Bạn tìm được nguồn vật liệu giá tốt. Lần xây dựng tiếp theo của bạn được giảm $50.',
    intents: Object.freeze([Object.freeze({ action: 'GRANT_NEXT_BUILD_DISCOUNT', amount: 50 })]),
  }),

  // C08 "Bảo Vệ Tài Sản" (card deck v2, 2026-08-25) — the only card in the
  // entire deck that touches the Steal/Hostile-Acquisition system, and the
  // design doc's own reason for it: Build already serves double duty (raise
  // rent AND make a property permanently un-stealable), so this card offers
  // the defensive half WITHOUT the cost, turning "build now to protect, or
  // keep the cash?" into a real recurring decision.
  //
  // NOTE ON THE ID: the pre-existing `C08_CUU_HO_TAI_CHINH` is a completely
  // different card (a conditional +$100 rescue) that happens to carry the
  // same C08 prefix from an earlier numbering. It is deliberately left
  // untouched rather than renamed — a live game's persisted
  // pendingEventCardId/lastDrawnEventCardId reference card ids by string, so
  // renaming one would break any match already in flight. The collision is
  // cosmetic, and flagged in PROJECT_STATUS.md rather than papered over.
  //
  // A CHOICE card with a single option, unusually — the real decision is
  // WHICH property to protect, which the static `options` array cannot
  // express, so it travels in the action payload (`propertyId`) and is
  // validated server-side by turnMachine.js's own GRANT_PROPERTY_PROTECTION
  // interception, the same way C01's MOVE_RELATIVE is intercepted there.
  //
  // The eligibility kind is new: unlike every other gate here (a plain
  // numeric field on the player), this one asks whether the player owns
  // anything protectable at all. Without it, a player owning no unimproved
  // property would enter AWAITING_EVENT_CHOICE with no legal choice to make
  // and hang their own turn until the timer fired — the exact deadlock class
  // C11's own `gte` gate was added to close.
  C08_BAO_VE_TAI_SAN: Object.freeze({
    id: 'C08_BAO_VE_TAI_SAN',
    type: 'CHOICE',
    keepable: true,
    text: 'Bạn nhanh chóng củng cố quyền sở hữu trước khi đối thủ kịp ra tay. Chọn một bất động sản chưa xây nhà của bạn — nó không thể bị cưỡng đoạt cho đến lượt kế tiếp của bạn.',
    eligibility: Object.freeze({ kind: 'OWNS_PROTECTABLE_PROPERTY' }),
    options: Object.freeze([
      Object.freeze({
        id: 'OPT_PROTECT',
        text: 'Bảo vệ một bất động sản chưa xây nhà.',
        intents: Object.freeze([Object.freeze({ action: 'GRANT_PROPERTY_PROTECTION' })]),
      }),
    ]),
  }),

  // C12 — the deck's own "biggest comeback card." Eligibility per the
  // user's own design doc is an OR of two conditions ("nằm trong nhóm net
  // worth thấp nhất, hoặc cash dưới $200") — only the cash half is
  // implemented here; the `eligibility` field (domain doc comment above)
  // only supports a single field/op/value check against the drawing player
  // alone, and "lowest net worth among all players" needs a genuine
  // cross-player comparison (this project's real engine/netWorth.js could
  // supply it, but that's real new wiring, not a data-only addition like
  // the rest of this card). Flagged plainly as a narrower eligibility gate
  // than designed, not silently assumed equivalent — a cash-poor player
  // still always qualifies, a property-rich-but-cash-poor player might not
  // have qualified under the full OR condition.
  C12_CO_HOI_CUOI: Object.freeze({
    id: 'C12_CO_HOI_CUOI',
    type: 'CHOICE',
    keepable: true,
    text: 'Cơ hội cuối cùng để lội ngược dòng! (Chỉ dùng được khi tiền mặt dưới $200 — bản rút gọn: chưa tính theo tổng tài sản thấp nhất bàn.)',
    eligibility: Object.freeze({ field: 'currentBalance', op: 'lt', value: 200 }),
    options: Object.freeze([
      Object.freeze({
        id: 'OPT_CASH',
        text: 'Nhận +$150.',
        intents: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 150 })]),
      }),
      Object.freeze({
        id: 'OPT_BUILD_DISCOUNT',
        text: 'Lần xây dựng tiếp theo được giảm $100.',
        intents: Object.freeze([Object.freeze({ action: 'GRANT_NEXT_BUILD_DISCOUNT', amount: 100 })]),
      }),
      Object.freeze({
        id: 'OPT_RENT_DISCOUNT',
        text: 'Lần thanh toán rent tiếp theo được giảm 50%, tối đa $150.',
        intents: Object.freeze([Object.freeze({ action: 'GRANT_NEXT_RENT_DISCOUNT', percent: 50, max: 150 })]),
      }),
    ]),
  }),

  // ── Phase 4 (2026-08-22) — the deck's hardest, deliberately-last group:
  // dynamic board-state-dependent movement (C01/C02) and dice-face-tiered
  // reward tables (C05/C11). See turnMachine.js's moveByStepsAndResolve()/
  // findNearestUnownedAhead() and EVENT_ACTION_TYPES' own MOVE_RELATIVE/
  // MOVE_TO_NEAREST_UNOWNED_PROPERTY/DIE_FACE_REWARD doc comments above for
  // the real mechanics; this section is just the card data.

  C01_LOI_TAT: Object.freeze({
    id: 'C01_LOI_TAT',
    type: 'CHOICE',
    text: 'Bạn tìm được một tuyến đường thuận lợi. Chọn một ô trong 3 ô phía trước — di chuyển thẳng tới đó, không tung xúc xắc, kích hoạt hiệu ứng ô đích bình thường.',
    options: Object.freeze([
      Object.freeze({ id: 'OPT_1_TILE', text: 'Tiến 1 ô.', intents: Object.freeze([Object.freeze({ action: 'MOVE_RELATIVE', steps: 1 })]) }),
      Object.freeze({ id: 'OPT_2_TILES', text: 'Tiến 2 ô.', intents: Object.freeze([Object.freeze({ action: 'MOVE_RELATIVE', steps: 2 })]) }),
      Object.freeze({ id: 'OPT_3_TILES', text: 'Tiến 3 ô.', intents: Object.freeze([Object.freeze({ action: 'MOVE_RELATIVE', steps: 3 })]) }),
    ]),
  }),

  C02_CHUYEN_DI_MAY_MAN: Object.freeze({
    id: 'C02_CHUYEN_DI_MAY_MAN',
    type: 'INSTANT',
    text: 'Một chuyến đi bất ngờ đưa bạn đến ô đất chưa có chủ gần nhất phía trước. (Nếu không có ô nào như vậy trong cả vòng bàn cờ, không có gì xảy ra.)',
    intents: Object.freeze([Object.freeze({ action: 'MOVE_TO_NEAREST_UNOWNED_PROPERTY' })]),
  }),

  // C05 — this deck's own "Cơ Hội Đầu Tư", a real 6-face-tiered risk table,
  // distinct from the pre-existing placeholder INVESTMENT_OPPORTUNITY card
  // (a binary 50/50) already in this dictionary from before this deck
  // existed — both are kept, not merged; INVESTMENT_OPPORTUNITY was never
  // part of the user's own 24-card design.
  C05_CO_HOI_DAU_TU: Object.freeze({
    id: 'C05_CO_HOI_DAU_TU',
    type: 'CHOICE',
    text: 'Cơ hội đầu tư! An toàn hay mạo hiểm?',
    options: Object.freeze([
      Object.freeze({ id: 'OPT_SAFE', text: 'An toàn — nhận +$100.', intents: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 100 })]) }),
      Object.freeze({
        id: 'OPT_RISK',
        text: 'Mạo hiểm — tung xúc xắc: 1-2: $0, 3-4: $150, 5: $200, 6: $300.',
        intents: Object.freeze([
          Object.freeze({
            action: 'DIE_FACE_REWARD',
            table: Object.freeze({
              1: Object.freeze([]),
              2: Object.freeze([]),
              3: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 150 })]),
              4: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 150 })]),
              5: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 200 })]),
              6: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 300 })]),
            }),
          }),
        ]),
      }),
    ]),
  }),

  // C11 — no real A-vs-B choice in the brief's own text ("Trả $50. Sau đó
  // tung xúc xắc.") — modeled as a single-option CHOICE card anyway,
  // specifically to reuse MAKE_EVENT_CHOICE's already-proven external-
  // randomness injection point (EVENT_ACTION_TYPES' own DIE_FACE_REWARD doc
  // comment has the full reasoning) rather than building a second one for
  // the INSTANT path.
  // eligibility added 2026-08-23 — this closes a real hard deadlock, not a
  // balance tweak. C11 is the only CHOICE card in this deck with exactly
  // ONE option, and that option carries a `validation.amount` of 50. A
  // player holding less than $50 who drew it entered AWAITING_EVENT_CHOICE,
  // where VALID_ACTIONS_BY_PHASE permits only MAKE_EVENT_CHOICE — and the
  // sole option it could name was rejected for insufficient balance. That
  // left literally no legal move for anyone at the table: not the drawer,
  // not the other players (blocked by the phase gate plus finding #30's
  // NOT_YOUR_TURN guard), and not the new AWAITING_EVENT_CHOICE turn timer
  // added the same day (finding #35), whose synthesized default would have
  // been rejected for the same reason and left the room stalled anyway.
  // FORFEIT_MATCH was the only way out.
  //
  // Gating eligibility is the fix rather than special-casing the timeout,
  // because cardEligible() already turns an ineligible draw into a real,
  // revealed no-op that continues straight to POST_ACTIONS — the card is
  // still shown to everyone, it simply has no effect, exactly the behavior
  // C12 (the only other gated card) already relies on. Uses the same
  // {field, op, value} shape; 'gte' was added to cardEligible() for this.
  C11_CU_DANH_LIEU: Object.freeze({
    id: 'C11_CU_DANH_LIEU',
    type: 'CHOICE',
    text: 'Một cú đánh liều! Trả $50, sau đó tung xúc xắc để xem vận may. (Cần có ít nhất $50 tiền mặt.)',
    eligibility: Object.freeze({ field: 'currentBalance', op: 'gte', value: 50 }),
    options: Object.freeze([
      Object.freeze({
        id: 'OPT_GAMBLE',
        text: 'Chấp nhận — trả $50 và tung xúc xắc.',
        validation: Object.freeze({ amount: 50 }),
        intents: Object.freeze([
          Object.freeze({ action: 'REMOVE_MONEY', amount: 50 }),
          Object.freeze({
            action: 'DIE_FACE_REWARD',
            table: Object.freeze({
              1: Object.freeze([Object.freeze({ action: 'REMOVE_MONEY', amount: 100 })]),
              2: Object.freeze([]),
              3: Object.freeze([]),
              4: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 100 })]),
              5: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 200 })]),
              6: Object.freeze([Object.freeze({ action: 'ADD_MONEY', amount: 300 })]),
            }),
          }),
        ]),
      }),
    ]),
  }),
});
