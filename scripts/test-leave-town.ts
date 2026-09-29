/*
 * The "leave town" hint has to be true at every point it can be shown.
 *
 * `wayOutOfTown` tells a player a compass word and a number of metres, and
 * the inspect card prints it as a fact. So the property under test is not
 * "roughly right": walk exactly that far in exactly that direction from any
 * point inside town and `isInTown` must be false when you arrive. A compass
 * word covers 45°, which is what makes this easy to get subtly wrong — an
 * earlier version searched at 10° and its advice landed players back in town
 * about half the time.
 *
 * Also checked: the distance is never shorter than an independent sweep
 * finds, so the hint cannot under-promise the walk.
 *
 * Run with: npm run test:leave-town
 */
import { isInTown, WORLD_HALF } from '../src/shared/zones'
import { wayOutOfTown } from '../src/pvp/leaveTown'

const COMPASS_V: Record<string, [number, number]> = {
  north: [0, 1],
  'north-east': [Math.SQRT1_2, Math.SQRT1_2],
  east: [1, 0],
  'south-east': [Math.SQRT1_2, -Math.SQRT1_2],
  south: [0, -1],
  'south-west': [-Math.SQRT1_2, -Math.SQRT1_2],
  west: [-1, 0],
  'north-west': [-Math.SQRT1_2, Math.SQRT1_2],
}

/** The best any compass-word answer could be, found independently at 0.25 m. */
function truth(x: number, z: number) {
  let best = Infinity
  for (const [dx, dz] of Object.values(COMPASS_V)) {
    for (let d = 0.25; d <= 2 * WORLD_HALF; d += 0.25) {
      const px = x + dx * d
      const pz = z + dz * d
      if (Math.abs(px) > WORLD_HALF || Math.abs(pz) > WORLD_HALF) break
      if (!isInTown(px, pz)) {
        if (d < best) best = d
        break
      }
    }
  }
  return best
}

let checked = 0
let bad = 0
let worst = 0
for (let x = -95; x <= 95; x += 1) {
  for (let z = -95; z <= 95; z += 1) {
    if (!isInTown(x, z)) continue
    checked++
    const out = wayOutOfTown(x, z)
    if (!out) {
      // Legal only if no compass direction reaches open ground at all.
      if (Number.isFinite(truth(x, z))) {
        bad++
        if (bad < 10) console.log(`NO ANSWER at ${x},${z} but truth=${truth(x, z)}`)
      }
      continue
    }
    const [ux, uz] = COMPASS_V[out.heading]
    // THE claim: walk exactly this far in exactly this direction and you are out.
    if (isInTown(x + ux * out.metres, z + uz * out.metres)) {
      bad++
      if (bad < 10) console.log(`UNTRUE ${x},${z} -> ${out.metres}m ${out.heading} still in town`)
      continue
    }
    worst = Math.max(worst, out.metres)
    if (out.metres < truth(x, z) - 0.001) {
      bad++
      if (bad < 10) console.log(`UNDERSTATES ${x},${z} -> ${out.metres} vs ${truth(x, z)}`)
    }
  }
}

console.log('\nsamples:')
for (const [x, z] of [[0, 8], [0, 0], [8, 8], [0, 40], [0, -60], [34, 20], [-48, 60], [50, 2], [70, 0], [88, 28]]) {
  const out = wayOutOfTown(x, z)
  console.log(`  (${x},${z}) inTown=${isInTown(x, z)} -> ${out ? `${out.metres} m ${out.heading}` : 'already outside'}`)
}

console.log(`\nchecked ${checked} in-town points · ${bad} wrong · longest advised walk ${worst} m`)
process.exit(bad === 0 ? 0 : 1)
