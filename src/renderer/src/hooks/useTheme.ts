import { useEffect, useState } from 'react'

type ThemeMode = 'light' | 'dark' | 'system'

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return mode
}

export function useTheme(mode: ThemeMode = 'system'): {
  theme: 'light' | 'dark'
  setMode: (mode: ThemeMode) => void
  mode: ThemeMode
} {
  const [currentMode, setCurrentMode] = useState<ThemeMode>(mode)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme(mode))

  useEffect(() => {
    setCurrentMode(mode)
  }, [mode])

  useEffect(() => {
    const applied = resolveTheme(currentMode)
    setTheme(applied)
    document.documentElement.classList.toggle('dark', applied === 'dark')

    if (currentMode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => {
      const next = resolveTheme('system')
      setTheme(next)
      document.documentElement.classList.toggle('dark', next === 'dark')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [currentMode])

  return { theme, mode: currentMode, setMode: setCurrentMode }
}
