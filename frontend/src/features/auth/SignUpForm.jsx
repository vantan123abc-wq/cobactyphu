import { useRef, useState } from 'react'
import { supabase } from '../../supabaseClient'

// Số ô OTP
const OTP_LENGTH = 6

export default function SignUpForm() {
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // Bước 2: nhập OTP
  const [otpStep, setOtpStep] = useState(false)
  const [otp, setOtp] = useState(Array(OTP_LENGTH).fill(''))
  const [verifying, setVerifying] = useState(false)
  const inputRefs = useRef([])

  // Bước 1: đăng ký → Supabase gửi email OTP
  async function handleSubmit(event) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName },
      },
    })

    setSubmitting(false)

    if (signUpError) {
      setError(signUpError.message)
      return
    }

    // Nếu Supabase yêu cầu xác nhận email → chuyển sang bước OTP
    if (!data.session) {
      setOtpStep(true)
      // Focus vào ô đầu tiên sau khi render
      setTimeout(() => inputRefs.current[0]?.focus(), 100)
    }
  }

  // Xử lý nhập từng ký tự OTP
  function handleOtpChange(index, value) {
    // Chỉ nhận chữ số
    if (!/^\d*$/.test(value)) return

    const newOtp = [...otp]
    newOtp[index] = value.slice(-1) // chỉ lấy 1 ký tự cuối
    setOtp(newOtp)

    // Tự động nhảy sang ô tiếp theo
    if (value && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus()
    }
  }

  // Xử lý phím Backspace để quay lại ô trước
  function handleOtpKeyDown(index, e) {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  // Xử lý dán (paste) toàn bộ mã OTP
  function handleOtpPaste(e) {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH)
    if (!pasted) return
    const newOtp = Array(OTP_LENGTH).fill('')
    pasted.split('').forEach((char, i) => { newOtp[i] = char })
    setOtp(newOtp)
    // Focus vào ô cuối cùng đã điền
    const lastIndex = Math.min(pasted.length, OTP_LENGTH - 1)
    inputRefs.current[lastIndex]?.focus()
  }

  // Bước 2: xác nhận OTP
  async function handleVerifyOtp(event) {
    event.preventDefault()
    const token = otp.join('')
    if (token.length < OTP_LENGTH) {
      setError('Vui lòng nhập đủ mã OTP.')
      return
    }

    setVerifying(true)
    setError(null)

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'signup',
    })

    setVerifying(false)

    if (verifyError) {
      setError(verifyError.message)
      setOtp(Array(OTP_LENGTH).fill(''))
      setTimeout(() => inputRefs.current[0]?.focus(), 100)
    }
    // Nếu thành công → AuthContext sẽ tự cập nhật session và chuyển màn hình
  }

  // Gửi lại OTP
  async function handleResend() {
    setError(null)
    setOtp(Array(OTP_LENGTH).fill(''))
    const { error: resendError } = await supabase.auth.resend({
      type: 'signup',
      email,
    })
    if (resendError) {
      setError(resendError.message)
    } else {
      setTimeout(() => inputRefs.current[0]?.focus(), 100)
    }
  }

  // ── Giao diện bước 2: nhập OTP ──────────────────────────────────────────
  if (otpStep) {
    return (
      <form onSubmit={handleVerifyOtp} className="auth-form otp-form">
        <p className="otp-instruction">
          Mã xác nhận đã gửi tới <strong>{email}</strong>.<br />
          Nhập mã <strong>{OTP_LENGTH} chữ số</strong> để hoàn tất đăng ký.
        </p>

        <div className="otp-inputs">
          {otp.map((digit, index) => (
            <input
              key={index}
              ref={(el) => (inputRefs.current[index] = el)}
              id={`otp-digit-${index}`}
              type="text"
              inputMode="numeric"
              pattern="\d*"
              maxLength={1}
              value={digit}
              onChange={(e) => handleOtpChange(index, e.target.value)}
              onKeyDown={(e) => handleOtpKeyDown(index, e)}
              onPaste={index === 0 ? handleOtpPaste : undefined}
              className="otp-input"
              autoComplete="one-time-code"
              aria-label={`Chữ số OTP thứ ${index + 1}`}
            />
          ))}
        </div>

        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}

        <button type="submit" disabled={verifying || otp.join('').length < OTP_LENGTH}>
          {verifying ? 'Đang xác nhận…' : 'Xác nhận'}
        </button>

        <button type="button" className="resend-btn" onClick={handleResend}>
          Gửi lại mã
        </button>
      </form>
    )
  }

  // ── Giao diện bước 1: đăng ký ──────────────────────────────────────────
  return (
    <form onSubmit={handleSubmit} className="auth-form">
      <label htmlFor="signup-display-name">Tên hiển thị</label>
      <input
        id="signup-display-name"
        type="text"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        minLength={1}
        maxLength={40}
        required
        autoComplete="nickname"
      />

      <label htmlFor="signup-email">Email</label>
      <input
        id="signup-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoComplete="email"
      />

      <label htmlFor="signup-password">Mật khẩu</label>
      <input
        id="signup-password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        minLength={6}
        required
        autoComplete="new-password"
      />

      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Đang đăng ký…' : 'Đăng ký'}
      </button>
    </form>
  )
}
