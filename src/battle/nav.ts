import * as THREE from 'three'
import { buildingSpecs, perimeterTrees, townLayout } from '../townData'

/* ------------------------------------------------------------------ *
 * Navigation.
 *
 * Before this module the player walked straight through buildings, so
 * "right-click walkable ground" and "no attacks through walls" had
 * nothing to stand on. What exists here is deliberately modest: one
 * blocking grid over the whole district, A* on it, string-pulled with
 * an analytic line-of-sight test, plus circle-vs-obstacle push-out for
 * direct movement.
 *
 * It is not a navmesh. Obstacles are the town's own geometry — building
 * footprints, the canal between its bridges, the fountain, the notice
 * board, the market stalls — plus whatever the wildscape registers for
 * its pines and standing stones. Ground clutter (ferns, trail planks,
 * the pond surface) is deliberately walkable.
 * ------------------------------------------------------------------ */

export type Obstacle =
  | { kind: 'rect'; x: number; z: number; halfW: number; halfD: number }
  | { kind: 'circle'; x: number; z: number; r: number }

/** Half-extent of the playable box, matching the clamp applied to the player. */
export const NAV_HALF = townLayout.bounds
/** One cell per metre: fine enough to squeeze between two buildings. */
const CELL = 1
const DIM = Math.ceil((NAV_HALF * 2) / CELL)
/** Body radius used when baking the grid, so a path never hugs a wall. */
const AGENT_RADIUS = 0.62

/* --------------------------- the obstacles --------------------------- */

/**
 * The canal is water except where a bridge crosses it. Bridges are authored in
 * townData as world-z values, so the blocked spans are the gaps between them.
 */
function canalObstacles(): Obstacle[] {
  const { canal, bridges } = townLayout
  const half = canal.waterLength / 2
  const edges = [canal.z - half, ...bridges.flatMap(z => [z - 3.4, z + 3.4]), canal.z + half].sort((a, b) => a - b)
  const out: Obstacle[] = []
  for (let i = 0; i < edges.length; i += 2) {
    const from = edges[i]
    const to = edges[i + 1]
    if (to - from < 0.5) continue
    out.push({ kind: 'rect', x: canal.x, z: (from + to) / 2, halfW: canal.waterWidth / 2, halfD: (to - from) / 2 })
  }
  return out
}

/** Static town obstacles. Nothing is retyped: every number comes from townData. */
export function townObstacles(): Obstacle[] {
  const stalls = townLayout.marketStalls
  return [
    ...buildingSpecs.map(spec => ({
      kind: 'rect' as const,
      x: spec.x,
      z: spec.z,
      halfW: spec.width / 2,
      halfD: spec.depth / 2,
    })),
    ...perimeterTrees().map(tree => ({ kind: 'circle' as const, x: tree.x, z: tree.z, r: 1.5 })),
    ...canalObstacles(),
    { kind: 'circle', x: townLayout.fountain.x, z: townLayout.fountain.z, r: townLayout.fountain.radius },
    { kind: 'rect', x: townLayout.noticeBoard.x, z: townLayout.noticeBoard.z, halfW: 2.3, halfD: 0.5 },
    ...Array.from({ length: stalls.count }, (_, i) => ({
      kind: 'rect' as const,
      x: stalls.x + i * stalls.step,
      z: stalls.z,
      halfW: 0.95,
      halfD: 0.45,
    })),
  ]
}

/* ------------------------------ geometry ----------------------------- */

/**
 * Narrowest span of an obstacle. A shot is stopped by anything at least this
 * wide; below it the thing is cover you can shoot past, not a wall.
 */
export const SHOT_CLEARANCE = 1.6

export function obstacleWidth(o: Obstacle) {
  return o.kind === 'circle' ? o.r * 2 : Math.min(o.halfW, o.halfD) * 2
}

/** Squared distance from a point to an obstacle's surface, negative inside. */
function penetration(o: Obstacle, x: number, z: number, radius: number) {
  if (o.kind === 'circle') {
    const d = Math.hypot(x - o.x, z - o.z)
    return o.r + radius - d
  }
  const dx = Math.abs(x - o.x) - o.halfW
  const dz = Math.abs(z - o.z) - o.halfD
  if (dx > 0 && dz > 0) return radius - Math.hypot(dx, dz)
  return radius - Math.max(dx, dz)
}

/** Ray/segment against one obstacle. Only "does it hit", not where. */
function segmentHits(o: Obstacle, ax: number, az: number, bx: number, bz: number, pad: number) {
  const dx = bx - ax
  const dz = bz - az
  if (o.kind === 'circle') {
    const r = o.r + pad
    const fx = ax - o.x
    const fz = az - o.z
    const a = dx * dx + dz * dz
    if (a < 1e-9) return fx * fx + fz * fz <= r * r
    const t = Math.max(0, Math.min(1, -(fx * dx + fz * dz) / a))
    const cx = fx + dx * t
    const cz = fz + dz * t
    return cx * cx + cz * cz <= r * r
  }
  // Slab test against the padded rectangle.
  const minX = o.x - o.halfW - pad
  const maxX = o.x + o.halfW + pad
  const minZ = o.z - o.halfD - pad
  const maxZ = o.z + o.halfD + pad
  let t0 = 0
  let t1 = 1
  for (const [origin, delta, lo, hi] of [
    [ax, dx, minX, maxX],
    [az, dz, minZ, maxZ],
  ] as const) {
    if (Math.abs(delta) < 1e-9) {
      if (origin < lo || origin > hi) return false
      continue
    }
    const near = (lo - origin) / delta
    const far = (hi - origin) / delta
    t0 = Math.max(t0, Math.min(near, far))
    t1 = Math.min(t1, Math.max(near, far))
    if (t0 > t1) return false
  }
  return true
}

/* ------------------------------ the grid ----------------------------- */

export type NavGrid = ReturnType<typeof createNavGrid>

export function createNavGrid(extra: Obstacle[] = []) {
  const obstacles = [...townObstacles(), ...extra]

  // Bucketed by 8m tile so push-out and line-of-sight only look at neighbours.
  const BUCKET = 8
  const buckets = new Map<number, number[]>()
  const bucketKey = (bx: number, bz: number) => bx * 4096 + bz
  obstacles.forEach((o, index) => {
    const reach = o.kind === 'circle' ? o.r : Math.hypot(o.halfW, o.halfD)
    const x0 = Math.floor((o.x - reach - 2 + NAV_HALF) / BUCKET)
    const x1 = Math.floor((o.x + reach + 2 + NAV_HALF) / BUCKET)
    const z0 = Math.floor((o.z - reach - 2 + NAV_HALF) / BUCKET)
    const z1 = Math.floor((o.z + reach + 2 + NAV_HALF) / BUCKET)
    for (let bx = x0; bx <= x1; bx++) {
      for (let bz = z0; bz <= z1; bz++) {
        const key = bucketKey(bx, bz)
        if (!buckets.has(key)) buckets.set(key, [])
        buckets.get(key)!.push(index)
      }
    }
  })
  const near = (x: number, z: number, reach = 0) => {
    const x0 = Math.floor((x - reach + NAV_HALF) / BUCKET)
    const x1 = Math.floor((x + reach + NAV_HALF) / BUCKET)
    const z0 = Math.floor((z - reach + NAV_HALF) / BUCKET)
    const z1 = Math.floor((z + reach + NAV_HALF) / BUCKET)
    const seen = new Set<number>()
    for (let bx = x0; bx <= x1; bx++) {
      for (let bz = z0; bz <= z1; bz++) {
        for (const index of buckets.get(bucketKey(bx, bz)) ?? []) seen.add(index)
      }
    }
    return seen
  }

  const solid = new Uint8Array(DIM * DIM)
  const cellCentre = (i: number) => (i + 0.5) * CELL - NAV_HALF
  const cellIndex = (v: number) => Math.floor((v + NAV_HALF) / CELL)
  for (const o of obstacles) {
    const reach = (o.kind === 'circle' ? o.r : Math.hypot(o.halfW, o.halfD)) + AGENT_RADIUS + CELL
    const ix0 = Math.max(0, cellIndex(o.x - reach))
    const ix1 = Math.min(DIM - 1, cellIndex(o.x + reach))
    const iz0 = Math.max(0, cellIndex(o.z - reach))
    const iz1 = Math.min(DIM - 1, cellIndex(o.z + reach))
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        if (solid[iz * DIM + ix]) continue
        if (penetration(o, cellCentre(ix), cellCentre(iz), AGENT_RADIUS) > 0) solid[iz * DIM + ix] = 1
      }
    }
  }

  const inBounds = (x: number, z: number) => Math.abs(x) < NAV_HALF - 1 && Math.abs(z) < NAV_HALF - 1
  const blockedCell = (ix: number, iz: number) =>
    ix < 0 || iz < 0 || ix >= DIM || iz >= DIM || solid[iz * DIM + ix] === 1

  /** True where a body of `radius` cannot stand. */
  const blocked = (x: number, z: number, radius = AGENT_RADIUS) => {
    if (!inBounds(x, z)) return true
    for (const index of near(x, z, radius + 2)) {
      if (penetration(obstacles[index], x, z, radius) > 0) return true
    }
    return false
  }

  /**
   * Push a body out of anything it is standing inside. Iterated a few times so
   * a corner between two buildings resolves instead of oscillating.
   */
  const resolve = (position: THREE.Vector3, radius = AGENT_RADIUS) => {
    for (let pass = 0; pass < 3; pass++) {
      let moved = false
      for (const index of near(position.x, position.z, radius + 2)) {
        const o = obstacles[index]
        const depth = penetration(o, position.x, position.z, radius)
        if (depth <= 0) continue
        let nx: number
        let nz: number
        if (o.kind === 'circle') {
          const dx = position.x - o.x
          const dz = position.z - o.z
          const d = Math.hypot(dx, dz) || 1e-4
          nx = dx / d
          nz = dz / d
        } else {
          // Leave along the face it is least deep into, which is the shortest way out.
          const dx = position.x - o.x
          const dz = position.z - o.z
          const overX = o.halfW + radius - Math.abs(dx)
          const overZ = o.halfD + radius - Math.abs(dz)
          if (overX < overZ) {
            nx = Math.sign(dx) || 1
            nz = 0
          } else {
            nx = 0
            nz = Math.sign(dz) || 1
          }
        }
        position.x += nx * (depth + 0.001)
        position.z += nz * (depth + 0.001)
        moved = true
      }
      if (!moved) break
    }
    position.x = THREE.MathUtils.clamp(position.x, -NAV_HALF, NAV_HALF)
    position.z = THREE.MathUtils.clamp(position.z, -NAV_HALF, NAV_HALF)
    return position
  }

  /**
   * Slide a body from where it is toward a delta, keeping the components that
   * do not collide. Walking into a wall at an angle should slide along it.
   */
  const slide = (position: THREE.Vector3, dx: number, dz: number, radius = AGENT_RADIUS) => {
    if (!blocked(position.x + dx, position.z + dz, radius)) {
      position.x += dx
      position.z += dz
      return
    }
    if (!blocked(position.x + dx, position.z, radius)) position.x += dx
    else if (!blocked(position.x, position.z + dz, radius)) position.z += dz
    resolve(position, radius)
  }

  /**
   * Clear line between two points, used for shots and for path smoothing.
   *
   * `minWidth` exists because the two callers want different answers. Path
   * smoothing must respect every trunk it would walk into, so it passes zero.
   * Shooting passes SHOT_CLEARANCE: a wall stops an arrow, a pine trunk in a
   * wood full of pine trunks would stop every arrow ever fired, and the
   * wildwood is where the hunting is.
   */
  const lineOfSight = (ax: number, az: number, bx: number, bz: number, pad = 0.12, minWidth = 0) => {
    const reach = Math.hypot(bx - ax, bz - az) / 2 + 2
    for (const index of near((ax + bx) / 2, (az + bz) / 2, reach)) {
      const obstacle = obstacles[index]
      if (minWidth > 0 && obstacleWidth(obstacle) < minWidth) continue
      if (segmentHits(obstacle, ax, az, bx, bz, pad)) return false
    }
    return true
  }

  /** Nearest standable point to a click, so clicking a roof still goes somewhere. */
  const nearestOpen = (x: number, z: number, radius = AGENT_RADIUS) => {
    if (!blocked(x, z, radius)) return new THREE.Vector3(x, 0, z)
    for (let ring = 1; ring <= 14; ring++) {
      for (let step = 0; step < ring * 8; step++) {
        const angle = (step / (ring * 8)) * Math.PI * 2
        const cx = x + Math.cos(angle) * ring * CELL
        const cz = z + Math.sin(angle) * ring * CELL
        if (!blocked(cx, cz, radius)) return new THREE.Vector3(cx, 0, cz)
      }
    }
    return null
  }

  /* ------------------------------- A* -------------------------------- */

  const open = new Int32Array(DIM * DIM)
  const gScore = new Float32Array(DIM * DIM)
  const cameFrom = new Int32Array(DIM * DIM)
  const visitStamp = new Int32Array(DIM * DIM)
  let stamp = 0

  /**
   * Returns waypoints from `from` to `to`, or null when nothing connects them.
   * The cap on expanded cells is what stops the player grinding against an
   * unreachable target forever.
   */
  const findPath = (from: THREE.Vector3, to: THREE.Vector3, maxCells = 9000): THREE.Vector3[] | null => {
    const start = nearestOpen(from.x, from.z)
    const goal = nearestOpen(to.x, to.z)
    if (!start || !goal) return null
    if (lineOfSight(start.x, start.z, goal.x, goal.z, AGENT_RADIUS)) return [goal]

    const si = cellIndex(start.x)
    const sj = cellIndex(start.z)
    const gi = cellIndex(goal.x)
    const gj = cellIndex(goal.z)
    if (blockedCell(si, sj) || blockedCell(gi, gj)) return null
    const startKey = sj * DIM + si
    const goalKey = gj * DIM + gi

    stamp++
    // Binary heap of (f, key) pairs kept in two parallel arrays.
    const heapF: number[] = []
    const heapKey: number[] = []
    const push = (f: number, key: number) => {
      heapF.push(f)
      heapKey.push(key)
      let i = heapF.length - 1
      while (i > 0) {
        const parent = (i - 1) >> 1
        if (heapF[parent] <= heapF[i]) break
        ;[heapF[parent], heapF[i]] = [heapF[i], heapF[parent]]
        ;[heapKey[parent], heapKey[i]] = [heapKey[i], heapKey[parent]]
        i = parent
      }
    }
    const pop = () => {
      const key = heapKey[0]
      const lastF = heapF.pop()!
      const lastKey = heapKey.pop()!
      if (heapF.length) {
        heapF[0] = lastF
        heapKey[0] = lastKey
        let i = 0
        for (;;) {
          const l = i * 2 + 1
          const r = l + 1
          let best = i
          if (l < heapF.length && heapF[l] < heapF[best]) best = l
          if (r < heapF.length && heapF[r] < heapF[best]) best = r
          if (best === i) break
          ;[heapF[best], heapF[i]] = [heapF[i], heapF[best]]
          ;[heapKey[best], heapKey[i]] = [heapKey[i], heapKey[best]]
          i = best
        }
      }
      return key
    }

    const heuristic = (key: number) => {
      const dx = Math.abs((key % DIM) - gi)
      const dz = Math.abs(Math.floor(key / DIM) - gj)
      return (Math.max(dx, dz) + 0.414 * Math.min(dx, dz)) * CELL
    }

    gScore[startKey] = 0
    cameFrom[startKey] = -1
    visitStamp[startKey] = stamp
    open[startKey] = stamp
    push(heuristic(startKey), startKey)

    let expanded = 0
    let found = false
    while (heapF.length && expanded < maxCells) {
      const key = pop()
      if (open[key] !== stamp) continue
      open[key] = 0
      if (key === goalKey) {
        found = true
        break
      }
      expanded++
      const ix = key % DIM
      const iz = Math.floor(key / DIM)
      for (let d = 0; d < 8; d++) {
        const ox = [1, -1, 0, 0, 1, 1, -1, -1][d]
        const oz = [0, 0, 1, -1, 1, -1, 1, -1][d]
        const nx = ix + ox
        const nz = iz + oz
        if (blockedCell(nx, nz)) continue
        // No cutting a diagonal through the corner of a building.
        if (ox && oz && (blockedCell(ix + ox, iz) || blockedCell(ix, iz + oz))) continue
        const nkey = nz * DIM + nx
        const cost = gScore[key] + (ox && oz ? 1.414 : 1) * CELL
        if (visitStamp[nkey] === stamp && cost >= gScore[nkey]) continue
        visitStamp[nkey] = stamp
        gScore[nkey] = cost
        cameFrom[nkey] = key
        open[nkey] = stamp
        push(cost + heuristic(nkey), nkey)
      }
    }
    if (!found) return null

    const cells: number[] = []
    for (let key = goalKey; key !== -1; key = cameFrom[key]) cells.push(key)
    cells.reverse()

    // String-pull: keep only the corners a straight line cannot skip.
    const points = cells.map(key => new THREE.Vector3(cellCentre(key % DIM), 0, cellCentre(Math.floor(key / DIM))))
    points[points.length - 1] = goal
    const pulled: THREE.Vector3[] = []
    let anchor = start
    let i = 0
    while (i < points.length) {
      let furthest = i
      for (let j = points.length - 1; j > i; j--) {
        if (lineOfSight(anchor.x, anchor.z, points[j].x, points[j].z, AGENT_RADIUS)) {
          furthest = j
          break
        }
      }
      pulled.push(points[furthest])
      anchor = points[furthest]
      if (furthest === points.length - 1) break
      i = furthest + 1
    }
    return pulled
  }

  return { obstacles, blocked, resolve, slide, lineOfSight, nearestOpen, findPath, agentRadius: AGENT_RADIUS }
}
