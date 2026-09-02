import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../../supabaseClient'
import { updateAuthToken } from '../../network/socketClient'

const AuthContext = createContext(undefined)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) updateAuthToken(session.access_token)
      setLoading(false)
    })

    // Forwards every session change — including Supabase's own background
    // TOKEN_REFRESHED, which fires well before the old token actually
    // expires — into socketClient.js's own `authToken`. Found live,
    // 2026-08-22: without this, a session living longer than one token's
    // lifetime (any tab left open past ~1hr) could never give the socket
    // layer a token that still worked once it needed to (re)connect — see
    // socketClient.js's own connectSocket/updateAuthToken for the other
    // half of this fix.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) updateAuthToken(session.access_token)
    })

    return () => subscription.unsubscribe()
  }, [])

  const value = {
    session,
    user: session?.user ?? null,
    loading,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
