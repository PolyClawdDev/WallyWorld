import * as THREE from 'three'

/* ------------------------------------------------------------------ *
 * The player's hide.
 *
 * Everything else that used to live here — the single per-character
 * ability, its projectile and the floating damage numbers — moved to
 * src/battle when combat grew four abilities, ranks and levels. What is
 * left is the one piece that is not per-ability: how much punishment the
 * player can take, how fast it comes back, and what happens when it runs
 * out. The battle engine owns max health and rewrites it on level-up.
 * ------------------------------------------------------------------ */

export const PLAYER_MAX_HP = 100
/** Seconds out of combat before regeneration kicks in. */
const REGEN_DELAY_MS = 6000
const REGEN_PER_SECOND = 7
const SAFE_REGEN_PER_SECOND = 26
const RESPAWN_INVULNERABLE_MS = 2500

export type Vitals = {
  hp: number
  maxHp: number
  impulse: THREE.Vector3
  lastDamageAt: number
  invulnerableUntil: number
  isInvulnerable: (now: number) => boolean
  /** `away` is the direction the hit should shove the player, not a position. */
  damage: (amount: number, away: THREE.Vector3 | null, source: string, now: number) => boolean
  heal: (amount: number) => void
  update: (dt: number, now: number, safe: boolean) => void
  reset: (now: number) => void
}

export function createVitals(onDeath: (source: string) => void): Vitals {
  const vitals: Vitals = {
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    impulse: new THREE.Vector3(),
    lastDamageAt: 0,
    invulnerableUntil: 0,
    isInvulnerable(now) {
      return now < vitals.invulnerableUntil
    },
    damage(amount, away, source, now) {
      if (vitals.hp <= 0 || vitals.isInvulnerable(now)) return false
      vitals.hp = Math.max(0, vitals.hp - Math.trunc(amount))
      vitals.lastDamageAt = now
      if (away) {
        const knock = away.clone().setY(0)
        if (knock.lengthSq() > 1e-6) vitals.impulse.copy(knock.normalize().multiplyScalar(7))
      }
      if (vitals.hp <= 0) {
        vitals.impulse.set(0, 0, 0)
        onDeath(source)
        return true
      }
      return false
    },
    heal(amount) {
      vitals.hp = Math.min(vitals.maxHp, vitals.hp + amount)
    },
    update(dt, now, safe) {
      vitals.impulse.multiplyScalar(Math.exp(-dt * 7))
      if (vitals.hp <= 0 || vitals.hp >= vitals.maxHp) return
      if (safe) {
        vitals.heal(SAFE_REGEN_PER_SECOND * dt)
      } else if (now - vitals.lastDamageAt > REGEN_DELAY_MS) {
        vitals.heal(REGEN_PER_SECOND * dt)
      }
    },
    reset(now) {
      vitals.hp = vitals.maxHp
      vitals.impulse.set(0, 0, 0)
      vitals.lastDamageAt = 0
      vitals.invulnerableUntil = now + RESPAWN_INVULNERABLE_MS
    },
  }
  return vitals
}
