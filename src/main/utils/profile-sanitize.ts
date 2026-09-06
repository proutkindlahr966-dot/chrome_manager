import type { ChromeProfile, DashboardStats, ProfileStatusPatch } from '../../shared/types'

/** Loại bỏ mật khẩu / TOTP khỏi payload gửi sang renderer (dashboard). */
export function sanitizeProfile(profile: ChromeProfile): ChromeProfile {
  return {
    ...profile,
    proxy: {
      ...profile.proxy,
      password: profile.proxy?.password ? '••••••••' : ''
    },
    gmail: profile.gmail
      ? {
          ...profile.gmail,
          password: profile.gmail.password ? '••••••••' : '',
          totpSecret: profile.gmail.totpSecret ? '••••••••' : '',
          raw: undefined
        }
      : null
  }
}

export function sanitizeProfiles(profiles: ChromeProfile[]): ChromeProfile[] {
  return profiles.map(sanitizeProfile)
}

export function sanitizeDashboardStats(stats: DashboardStats): DashboardStats {
  return {
    ...stats,
    recentlyLaunched: sanitizeProfiles(stats.recentlyLaunched)
  }
}

export function toStatusPatch(profile: ChromeProfile): ProfileStatusPatch {
  return {
    id: profile.id,
    status: profile.status,
    lastLaunchedAt: profile.lastLaunchedAt,
    updatedAt: profile.updatedAt
  }
}
