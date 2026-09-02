import { useState } from 'react'
import { supabase } from '../../supabaseClient'

export default function SignInForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(event) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    setSubmitting(false)

    if (signInError) {
      setError(signInError.message)
    }
    // On success, AuthContext's onAuthStateChange listener updates session
    // and the app re-renders into the authenticated view automatically.
  }

  return (
    <form onSubmit={handleSubmit} className="auth-form">
      <label htmlFor="signin-email">Email</label>
      <input
        id="signin-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoComplete="email"
      />

      <label htmlFor="signin-password">Mật khẩu</label>
      <input
        id="signin-password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        autoComplete="current-password"
      />

      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Đang đăng nhập…' : 'Đăng nhập'}
      </button>
    </form>
  )
}
