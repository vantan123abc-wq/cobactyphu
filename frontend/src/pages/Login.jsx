import { useState } from 'react'
import SignInForm from '../features/auth/SignInForm'
import SignUpForm from '../features/auth/SignUpForm'

export default function Login() {
  const [mode, setMode] = useState('signin')

  return (
    <section className="auth-page">
      <h1>Cờ Tỷ Phú</h1>
      <div className="auth-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'signin'}
          className={mode === 'signin' ? 'active' : ''}
          onClick={() => setMode('signin')}
        >
          Đăng nhập
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'signup'}
          className={mode === 'signup' ? 'active' : ''}
          onClick={() => setMode('signup')}
        >
          Đăng ký
        </button>
      </div>

      {mode === 'signin' ? <SignInForm /> : <SignUpForm />}
    </section>
  )
}
