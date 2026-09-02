// Player-facing explanations for every server rejection — 2026-09-02.
//
// Until now, all seven UI surfaces that can receive a rejection rendered it
// raw as `{errorCode}: {message}`. That message is an internal developer
// string, so players saw things like:
//
//   MONOPOLY_PROTECTED: handleHostileBuyout: property
//   'f303cf51-b811-4072-bd56-ca25044206d4' belongs to a completed
//   color-group monopoly, protected from hostile buyout
//
// — a function name and a raw database UUID, in English, in a Vietnamese
// game.
//
// Every code below comes from the real taxonomy, collected from the actual
// `errorCode:` emissions in socketServer.js plus every `reason` passed to
// InvalidPropertyActionError / InvalidBidError / InvalidTradeError /
// InvalidJailActionError / InvalidInventoryActionError / InvalidForfeitError /
// EventChoiceError — not from guesswork about what might come back.
//
// Each entry says what happened AND what the player can do instead, because a
// rejection the player cannot act on is only marginally better than a raw
// dump. Several deliberately teach a rule the UI has no other place to
// explain (why a monopoly is buyout-proof, why selling must be even, why a
// freshly bought lot cannot be built on yet).
//
// `tone` drives presentation only:
//   'rule'   — you asked for something the rules don't allow. Normal, common.
//   'timing' — legal move, wrong moment. Usually resolves itself.
//   'fault'  — something went wrong that isn't the player's doing.
//
// An unknown code falls back to a generic entry rather than leaking the raw
// message: a code missing from this table is a gap to fill here, never a
// reason to show a player a fragment of a stack trace.

const ERRORS = {
  // ── Turn / session ──────────────────────────────────────────────────
  NOT_YOUR_TURN: {
    tone: 'timing',
    title: 'Chưa tới lượt bạn',
    body: 'Hành động này chỉ thực hiện được trong lượt của bạn. Giao dịch, đấu giá và dùng thẻ trong kho thì không cần chờ lượt.',
  },
  PHASE_MISMATCH: {
    tone: 'timing',
    title: 'Chưa tới bước này',
    body: 'Hành động hợp lệ, nhưng không phải ở giai đoạn hiện tại của lượt. Hãy làm theo các nút đang hiển thị.',
  },
  STALE_ACTION: {
    tone: 'timing',
    title: 'Ván cờ vừa thay đổi',
    body: 'Có người hành động trước bạn nên thao tác này đã lỗi thời. Xem lại tình hình rồi thử lại.',
  },
  ROOM_NOT_IN_PROGRESS: {
    tone: 'timing',
    title: 'Ván chưa bắt đầu',
    body: 'Phòng này chưa vào ván, hoặc ván đã kết thúc.',
  },
  GAME_ALREADY_FINISHED: {
    tone: 'timing',
    title: 'Ván đã kết thúc',
    body: 'Không còn hành động nào được chấp nhận nữa.',
  },
  NOT_A_PARTICIPANT: {
    tone: 'fault',
    title: 'Bạn không ở trong ván này',
    body: 'Tài khoản của bạn không có chỗ trong ván đấu này.',
  },
  NOT_A_PLAYER: {
    tone: 'fault',
    title: 'Không tìm thấy người chơi',
    body: 'Không xác định được người chơi tương ứng trong ván.',
  },
  GAME_NOT_FOUND: {
    tone: 'fault',
    title: 'Không tìm thấy ván',
    body: 'Ván đấu này không còn tồn tại.',
  },

  // ── Tiền và quyền sở hữu ────────────────────────────────────────────
  INSUFFICIENT_BALANCE: {
    tone: 'rule',
    title: 'Không đủ tiền mặt',
    body: 'Số dư không đủ cho hành động này. Bạn có thể cầm cố đất hoặc bán nhà để có thêm tiền mặt.',
  },
  NOT_OWNER: {
    tone: 'rule',
    title: 'Không phải đất của bạn',
    body: 'Bạn chỉ thao tác được trên bất động sản mình đang sở hữu.',
  },
  NOT_OWNED: {
    tone: 'rule',
    title: 'Ô đất chưa có chủ',
    body: 'Hành động này cần một ô đất đã có người sở hữu.',
  },
  ALREADY_OWNED: {
    tone: 'rule',
    title: 'Ô đất đã có chủ',
    body: 'Ô này đã thuộc về người khác rồi.',
  },

  // ── Xây, bán, cầm cố ────────────────────────────────────────────────
  INCOMPLETE_GROUP: {
    tone: 'rule',
    title: 'Chưa đủ bộ màu',
    body: 'Hành động này yêu cầu bạn sở hữu trọn nhóm màu.',
  },
  // UNEVEN_BUILD removed 2026-09-02 — the even-build rule was dropped from
  // handleBuildHouse, so this code can no longer be emitted.
  UNEVEN_SELL: {
    tone: 'rule',
    title: 'Phải bán đều tay',
    body: 'Trong một nhóm màu, phải bán bớt từ ô đang có nhiều nhà nhất trước, để các ô không chênh nhau quá một bậc khi bạn hạ dần công trình.',
  },
  MAX_UPGRADE_LEVEL: {
    tone: 'rule',
    title: 'Đã xây tối đa',
    body: 'Ô này đã lên tới khách sạn, không nâng cấp thêm được.',
  },
  NO_HOUSES_TO_SELL: {
    tone: 'rule',
    title: 'Không có công trình để bán',
    body: 'Ô này chưa xây gì nên không có nhà nào để bán lại.',
  },
  INSUFFICIENT_SUPPLY: {
    tone: 'rule',
    title: 'Kho nhà đã cạn',
    body: 'Cả bàn dùng chung 32 nhà và 12 khách sạn. Phải có người bán bớt công trình thì mới xây tiếp được — số còn lại hiện ở thanh thông tin phía trên.',
  },
  GROUP_MORTGAGED: {
    tone: 'rule',
    title: 'Nhóm đang bị cầm cố',
    body: 'Không xây được khi còn ô nào trong nhóm đang cầm cố. Hãy chuộc lại trước.',
  },
  PROPERTY_HAS_HOUSES: {
    tone: 'rule',
    title: 'Ô này vẫn còn nhà',
    body: 'Chỉ cầm cố được ô không có công trình. Bán hết nhà trên chính ô này trước đã (các ô khác trong nhóm không ảnh hưởng). Lưu ý: cầm cố bất kỳ ô nào trong nhóm sẽ làm mất thưởng ×2 độc quyền cho tới khi chuộc lại.',
  },
  ALREADY_MORTGAGED: {
    tone: 'rule',
    title: 'Ô này đang cầm cố',
    body: 'Ô đất này đã ở trong tình trạng cầm cố rồi.',
  },
  NOT_MORTGAGED: {
    tone: 'rule',
    title: 'Ô này chưa cầm cố',
    body: 'Chỉ chuộc lại được ô đang bị cầm cố.',
  },
  RECENTLY_ACQUIRED: {
    tone: 'rule',
    title: 'Đất vừa mới mua',
    body: 'Phải chờ tới lượt kế tiếp của bạn mới xây được trên ô vừa mua. Luật này ngăn việc mua xong xây ngay để né bị cưỡng đoạt.',
  },

  // ── Cưỡng đoạt ──────────────────────────────────────────────────────
  MONOPOLY_PROTECTED: {
    tone: 'rule',
    title: 'Ô này được bảo vệ',
    body: 'Ô nằm trong một nhóm màu đã hoàn chỉnh. Gom đủ cả bộ chính là cách khiến đất miễn nhiễm với cưỡng đoạt.',
  },
  HOUSE_PROTECTED: {
    tone: 'rule',
    title: 'Ô này được bảo vệ',
    body: 'Ô đã xây nhà. Chỉ cần một căn là đất được miễn nhiễm cưỡng đoạt vĩnh viễn.',
  },
  CARD_PROTECTED: {
    tone: 'rule',
    title: 'Đất đang được lá bài bảo vệ',
    body: 'Chủ đất đã dùng thẻ Bảo Vệ Tài Sản lên ô này. Hiệu lực hết vào lượt kế tiếp của họ.',
  },
  NO_PENDING_BUYOUT: {
    tone: 'timing',
    title: 'Không có ô nào để cưỡng đoạt',
    body: 'Cơ hội cưỡng đoạt chỉ mở ngay sau khi bạn trả tiền thuê cho người khác, và chỉ trong đúng lượt đó.',
  },

  // ── Đấu giá ─────────────────────────────────────────────────────────
  BID_TOO_LOW: {
    tone: 'rule',
    title: 'Giá đặt quá thấp',
    body: 'Mỗi lần đặt phải cao hơn hẳn giá cao nhất hiện tại. Đây là số tiền tuyệt đối, không phải mức cộng thêm.',
  },
  BIDDER_NOT_ACTIVE: {
    tone: 'rule',
    title: 'Bạn đã rời phiên đấu giá',
    body: 'Bạn đã bỏ cuộc, hoặc không nằm trong danh sách được đấu giá. Bỏ cuộc đồng nghĩa rút lại giá của mình và không quay lại được.',
  },

  // ── Giao dịch ───────────────────────────────────────────────────────
  NOT_TARGET: {
    tone: 'rule',
    title: 'Bạn không phải bên nhận',
    body: 'Chỉ người được đề nghị mới chấp nhận hoặc từ chối giao dịch này.',
  },
  NOT_PROPOSER: {
    tone: 'rule',
    title: 'Bạn không phải bên đề nghị',
    body: 'Chỉ người tạo giao dịch mới hủy được nó.',
  },
  TRADE_NOT_FOUND: {
    tone: 'timing',
    title: 'Giao dịch không còn nữa',
    body: 'Giao dịch này đã được xử lý, đã bị hủy, hoặc đã hết hạn.',
  },
  SELF_TRADE: {
    tone: 'rule',
    title: 'Không thể tự giao dịch',
    body: 'Bạn phải chọn một người chơi khác.',
  },
  ASSET_LOCKED: {
    tone: 'rule',
    title: 'Tài sản đang bị khóa',
    body: 'Ô đất này đã được đưa vào một giao dịch khác đang chờ. Hủy giao dịch kia trước đã.',
  },
  MAX_COUNTER_DEPTH_EXCEEDED: {
    tone: 'rule',
    title: 'Trả giá qua lại quá nhiều lần',
    body: 'Một chuỗi giao dịch chỉ được trả giá tối đa 5 lần. Hãy chốt, hoặc bắt đầu một đề nghị mới.',
  },
  PLAYER_BANKRUPT: {
    tone: 'rule',
    title: 'Người chơi đã bị loại',
    body: 'Người đã phá sản không tham gia giao dịch hay dùng thẻ được nữa.',
  },

  // ── Nhà tù ──────────────────────────────────────────────────────────
  NO_JAIL_CARD: {
    tone: 'rule',
    title: 'Bạn không có thẻ ra tù',
    body: 'Bạn có thể trả $50 để ra ngay, hoặc thử đổ xúc xắc đôi.',
  },

  // ── Kho thẻ ─────────────────────────────────────────────────────────
  CARD_NOT_HELD: {
    tone: 'rule',
    title: 'Bạn không giữ lá bài này',
    body: 'Lá bài có thể đã được dùng rồi.',
  },
  CARD_NOT_KEEPABLE: {
    tone: 'rule',
    title: 'Lá bài này không cất giữ được',
    body: 'Chỉ những lá được đánh dấu giữ lại mới chơi được từ Kho Thẻ.',
  },
  NOT_ELIGIBLE: {
    tone: 'rule',
    title: 'Không còn đủ điều kiện',
    body: 'Điều kiện của lá bài này không còn đúng với tình hình hiện tại của bạn.',
  },
  NOT_PROTECTABLE: {
    tone: 'rule',
    title: 'Không bảo vệ được ô này',
    body: 'Chỉ bảo vệ được đất của chính bạn và chưa xây nhà — đất đã xây thì vốn đã miễn nhiễm rồi.',
  },

  // ── Thẻ sự kiện ─────────────────────────────────────────────────────
  UNKNOWN_OPTION: {
    tone: 'fault',
    title: 'Lựa chọn không hợp lệ',
    body: 'Lựa chọn này không thuộc lá bài đang mở.',
  },

  // ── Cược tiền thuê ──────────────────────────────────────────────────
  NO_PENDING_RENT_GAMBLE: {
    tone: 'timing',
    title: 'Không có khoản cược nào',
    body: 'Cơ hội cược tiền thuê chỉ mở sau khi có người trả tiền thuê cho bạn.',
  },

  // ── Đầu hàng ────────────────────────────────────────────────────────
  ALREADY_ELIMINATED: {
    tone: 'timing',
    title: 'Bạn đã bị loại',
    body: 'Bạn đã rời ván đấu này rồi.',
  },
  SOLE_SURVIVOR: {
    tone: 'rule',
    title: 'Không thể đầu hàng',
    body: 'Bạn là người chơi cuối cùng còn lại — đầu hàng lúc này sẽ khiến ván không có người thắng.',
  },

  // ── Hệ thống ────────────────────────────────────────────────────────
  MALFORMED_PAYLOAD: {
    tone: 'fault',
    title: 'Dữ liệu gửi lên không hợp lệ',
    body: 'Máy chủ không hiểu được yêu cầu này. Thử tải lại trang.',
  },
  INTERNAL_ERROR: {
    tone: 'fault',
    title: 'Lỗi hệ thống',
    body: 'Có lỗi ngoài dự kiến ở máy chủ. Hành động của bạn chưa được thực hiện.',
  },
}

const FALLBACK = {
  tone: 'fault',
  title: 'Không thực hiện được',
  body: 'Máy chủ đã từ chối hành động này. Tình hình ván đấu không thay đổi.',
}

/**
 * Turns a raw rejection into something worth showing a player.
 * @param {{errorCode?: string, message?: string}|null|undefined} lastError
 * @returns {{tone: string, title: string, body: string, code: string}|null}
 */
export function explainError(lastError) {
  if (!lastError) return null
  const code = lastError.errorCode ?? 'INTERNAL_ERROR'
  return { ...(ERRORS[code] ?? FALLBACK), code }
}
