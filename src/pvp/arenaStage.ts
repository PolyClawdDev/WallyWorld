import * as THREE from 'three'
import { createArena, type Arena, type ArenaStats } from '../arena'
import { ARENA_FADE_MS, type ArenaView } from '../shared/pvp'

/* ------------------------------------------------------------------ *
 * Putting the player in the arena, and taking them back out.
 *
 * The brief's first requirement is that a duel inherits nothing from the
 * town: no terrain, trees, NPCs, buildings, colliders, lighting, fog,
 * audio, and no non-participants. The temptation is to enumerate those and
 * hide each one, which is how the trees got into the duel area in the
 * first place — an enumeration is a list somebody has to remember to add
 * to, and the town grows.
 *
 * So this works the other way round. On entry it walks the scene and hides
 * EVERYTHING that is visible, except the handful of objects the duel
 * itself owns, and remembers exactly what it hid. On exit it puts that
 * same list back. A new piece of town added tomorrow is hidden by a rule
 * that was written before it existed, and nothing can be left behind
 * because the restore is driven by the record of what was taken away.
 *
 * Lights are covered by the same sweep: `visible = false` on a light takes
 * it out of the render list, so the arena's seven lights are the only ones
 * in frame and the town's moon does not reach in.
 *
 * WHAT THIS DOES NOT DO is any collision or pathfinding. `src/battle/nav.ts`
 * is deliberately absent: constructing a NavGrid bakes the whole town into
 * a blocking grid, which is the bug that put pines in the duel area. The
 * server owns every position inside a duel and the arena is a circle with
 * nothing in it, so there is nothing here to solve.
 * ------------------------------------------------------------------ */

/**
 * Objects that belong to the duel rather than to the town, by name.
 *
 * The player group is passed in, because the caller owns it. These two are
 * found by name because nothing else has a handle on them at this level:
 * `combat-vfx` is the float-label and impact pool that draws the duel's
 * damage numbers, and `arena` is the floor itself.
 */
const KEPT_NAMES = new Set(['combat-vfx', 'arena'])

/**
 * The other wizard in the fight.
 *
 * Kept by flag rather than by handle, which is the whole reason this bug
 * existed: the caller passes in the objects it owns, and it does not own
 * this one — `pvp/world.ts` creates, recreates and disposes remote wizards
 * as presence changes, so any handle taken at entry can be stale by the
 * next frame. A character swap mid-instance disposes the group and builds
 * a new one; a keep-list holding the old object would hide the new one.
 *
 * Non-participants are not a worry here even though they carry the same
 * flag. `updatePvpWorld` REMOVES every remote except the opponent from the
 * scene while a duel is locked, and it runs after this sweep and before the
 * frame is drawn, so a bystander left visible by this rule is out of the
 * scene entirely before anything renders.
 */
const isRemotePlayer = (child: THREE.Object3D) => child.userData.remotePlayer === true

type Mode = 'in' | 'live' | 'out' | 'restore'

type Stage = {
  arenaId: string
  arena: Arena | null
  /** What was visible before the arena replaced it, so the restore is exact. */
  hidden: THREE.Object3D[]
  scene: THREE.Scene
  mode: Mode
  /** When the current mode started, on the render loop's clock. */
  since: number
  /** Set when `createArena` refused to build. See `enter`. */
  failure: string | null
}

let stage: Stage | null = null

/* ----------------------------- the veil ----------------------------- */
/*
 * A black div, written to directly from the render loop.
 *
 * Not a React node and not a mesh, for one reason each. React re-renders
 * on the presence tick, which is twelve times a second — visibly steppy
 * for a 380 ms fade. A mesh would have to be composited into a scene that
 * is in the middle of being swapped, which is the one moment its contents
 * are not trustworthy. A style write is exact, costs nothing, and is
 * correct on the frame the swap happens.
 */
let veilNode: HTMLDivElement | null = null

function veilElement() {
  if (veilNode || typeof document === 'undefined') return veilNode
  veilNode = document.createElement('div')
  veilNode.className = 'arena-veil'
  veilNode.setAttribute('aria-hidden', 'true')
  document.body.appendChild(veilNode)
  return veilNode
}

function paintVeil(amount: number) {
  const node = veilElement()
  if (!node) return
  node.style.opacity = amount.toFixed(3)
}

function dropVeil() {
  veilNode?.remove()
  veilNode = null
}

/* ---------------------------- the swap ----------------------------- */

function enter(scene: THREE.Scene, view: ArenaView, now: number, keep: THREE.Object3D[]) {
  const kept = new Set<THREE.Object3D>(keep)
  /*
   * Snapshot BEFORE the arena is attached, or the arena's own root is in the
   * list of things to hide and the floor never appears.
   */
  const hidden: THREE.Object3D[] = []
  for (const child of scene.children) {
    if (kept.has(child) || KEPT_NAMES.has(child.name)) continue
    if (isRemotePlayer(child)) continue
    if (!child.visible) continue
    child.visible = false
    hidden.push(child)
  }

  let arena: Arena | null = null
  let failure: string | null = null
  try {
    arena = createArena()
    arena.attach(scene)
    // The instance's own origin, so the server's fighter positions need no
    // translation: what arrives in a snapshot is where the wizard goes.
    arena.root.position.set(view.originX, 0, view.originZ)
  } catch (error) {
    /*
     * `createArena` throws when the kit tables have moved the platform
     * outside the size its art was authored for. That is a build-time
     * mistake, and `verify:arena` exists to catch it — but if it ever
     * reaches a player, the answer is NOT to refuse the duel. The server has
     * already taken both stakes and is running the match; a client that will
     * not draw the floor must still let its player fight and leave, or the
     * failure is a trap instead of an ugly frame. So the town goes back up
     * and the fight happens over it.
     */
    for (const child of hidden) child.visible = true
    hidden.length = 0
    failure = error instanceof Error ? error.message : String(error)
  }

  stage = { arenaId: view.id, arena, hidden, scene, mode: 'in', since: now, failure }
  return stage
}

function tearDown(current: Stage) {
  if (current.arena) {
    // `detach` puts the scene's own sky and fog back; `dispose` walks the
    // arena's allocation ledger. Both, in that order, and both exactly once.
    current.arena.detach()
    current.arena.dispose()
  }
  for (const child of current.hidden) child.visible = true
  current.hidden.length = 0
  current.arena = null
}

export type StageReport = {
  active: boolean
  /** True once the floor is up and the fade has finished: safe to fight on. */
  ready: boolean
  arenaId: string | null
  mode: Mode | null
  veil: number
  /** How many scene objects the town is currently hiding behind. */
  hidden: number
  stats: ArenaStats | null
  failure: string | null
}

const IDLE: StageReport = {
  active: false,
  ready: false,
  arenaId: null,
  mode: null,
  veil: 0,
  hidden: 0,
  stats: null,
  failure: null,
}

/**
 * Drives the stage from whatever the server last said about the instance.
 *
 * Called every frame with the live `ArenaView`, or null when there is no
 * duel. `phase === 'closed'` is the ONLY thing that starts the exit — a
 * settled match with a results panel on screen is still in the arena, and
 * reading the duel's own phase here is what used to send people home while
 * they were reading the numbers.
 *
 * Returns what it did, so the caller can gate the camera and the verifier
 * can assert on it.
 */
export function syncArenaStage(
  scene: THREE.Scene,
  view: ArenaView | null,
  now: number,
  keep: THREE.Object3D[],
): StageReport {
  const wanted = view && view.phase !== 'closed' ? view : null

  // A different instance while one is up means the last exit was missed.
  // Tearing the old one down immediately is right: two arenas in one scene
  // is two floors and fourteen lights.
  if (stage && wanted && stage.arenaId !== wanted.id) {
    tearDown(stage)
    stage = null
  }
  if (!stage && wanted) enter(scene, wanted, now, keep)
  if (!stage) {
    dropVeil()
    return IDLE
  }

  const current = stage
  if (wanted && current.mode === 'out') {
    // The instance came back from the dead — a reconnect inside the grace
    // window, most likely. Stop leaving.
    current.mode = 'in'
    current.since = now
  }
  if (!wanted && (current.mode === 'in' || current.mode === 'live')) {
    current.mode = 'out'
    current.since = now
  }

  const elapsed = now - current.since
  const t = Math.min(1, Math.max(0, elapsed / ARENA_FADE_MS))
  if (current.mode === 'in' && t >= 1) {
    current.mode = 'live'
    current.since = now
  } else if (current.mode === 'out' && t >= 1) {
    // Black screen: the one frame on which swapping the world is invisible.
    tearDown(current)
    current.mode = 'restore'
    current.since = now
  } else if (current.mode === 'restore' && t >= 1) {
    dropVeil()
    stage = null
    return IDLE
  }

  if (wanted && current.arena) {
    current.arena.root.position.set(wanted.originX, 0, wanted.originZ)
    current.arena.update(now)
  }

  paintVeil(veilOf(current, now))
  return reportOf(current, now)
}

function veilOf(current: Stage, now: number) {
  const t = Math.min(1, Math.max(0, (now - current.since) / ARENA_FADE_MS))
  switch (current.mode) {
    case 'in': return 1 - t
    case 'out': return t
    case 'restore': return 1 - t
    default: return 0
  }
}

function reportOf(current: Stage, now: number): StageReport {
  return {
    active: current.mode !== 'restore',
    // Deliberately not gated on the fade: the floor exists and the fighters are
    // on their marks from the first frame, and the server's both-ready gate
    // should not be made to wait out an animation.
    ready: Boolean(current.arena || current.failure) && current.mode !== 'restore',
    arenaId: current.arenaId,
    mode: current.mode,
    veil: veilOf(current, now),
    hidden: current.hidden.length,
    stats: current.arena?.stats ?? null,
    failure: current.failure,
  }
}

/**
 * What the stage is doing, without touching it.
 *
 * `syncArenaStage` advances a state machine, so it is not something a probe or
 * a verifier may call: asking the question would answer it differently.
 */
export function arenaStageReport(now = 0): StageReport {
  return stage ? reportOf(stage, now) : IDLE
}

/** Where the boundary is, for a client that wants to warn about it. */
export function arenaBoundary() {
  return stage?.arena ? { radius: stage.arena.boundaryRadius, floorY: stage.arena.floorY } : null
}

/**
 * Tears the stage down now, without a fade.
 *
 * For the world being unmounted, where there is nothing left to fade into.
 * Idempotent, because unmount paths run more than once in development.
 */
export function disposeArenaStage() {
  if (stage) tearDown(stage)
  stage = null
  dropVeil()
}
