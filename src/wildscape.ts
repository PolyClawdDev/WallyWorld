import * as THREE from 'three'
import {
  ROAM_INSET,
  brassTrailWaypoints,
  highHuntArea,
  huntingArea,
  huntTrails,
  insideRegion,
  isGreen,
  regionArea,
  regionOutline,
  trailWaypoints,
  wildRegions,
} from './wildlife'
import type { WildRegion } from './wildlife'
import { DUEL_RINGS, WORLD_HALF, townBuildings, townPaving, townPlaza } from './shared/zones'
import { buildingSpecs, perimeterTrees } from './townData'
import { createBatch, disposeMaterial } from './voxelBuild'
import type { Surface } from './voxelBuild'
import { createTreeField, inFoliage, treeMetrics } from './treeArt'
import type { TreePlacement, TreeSpeciesId } from './treeArt'

/* ------------------------------------------------------------------ *
 * The green. Everything the player needs in order to find the hunt:
 * the shape of the open ground, the woods standing on it, a pond, a
 * hunter's camp, and lit dirt trails out of the plaza with signposts.
 *
 * Three things here are deliberate and worth reading before changing:
 *
 * 1. THE GROUND IS NOT A DISC. Each region's grass is cut to the same
 *    signed-distance outline the animals are fenced by, so what the
 *    player sees is exactly where the animals can be. It used to be a
 *    `CircleGeometry` scaled to a radius, which is why the hunting
 *    ground looked like a circle: it was one.
 *
 * 2. PROPS ARE BATCHED. Trail planks, fence rails, stumps, boulders,
 *    grass and signpost timber all go into one `Batch` and come out as
 *    about a dozen meshes. Built one THREE.Mesh at a time — which is
 *    how it used to be — the trails alone were a hundred and fifty
 *    draw calls.
 *
 * 3. THERE ARE THREE POINT LIGHTS OUT HERE, NOT EIGHTEEN. Every extra
 *    point light is another iteration inside every material's fragment
 *    shader for every pixel of the scene, and on a software renderer
 *    that is the most expensive thing in this file by a wide margin.
 *    Lamps still glow — emissive costs nothing — they just do not each
 *    light the world.
 *
 * 4. TREES GROW OUTSIDE THE REGIONS TOO. They did not, which is why the
 *    world read as seven forests with a lawn between them. `plantCountry`
 *    below plants the rest of the map at a fraction of a wood's density —
 *    copses, hedgerows, lone trees — and it goes through the same `plant`
 *    as the woods, so every trunk registers the same navigation obstacle.
 *
 * 5. NOTHING THE PLAYER CAN STAND ON HAS A LEAF OVER IT BELOW
 *    TRUNK_CORRIDOR. That is the one invariant worth defending here:
 *    every tree either keeps a clear bare-bole corridor to 4.2m — which
 *    is above the player, above the first-person eye at 2.7m and above
 *    the lowest the orbit camera can get — or it is a thicket and blocks
 *    over its whole width so nobody stands in it at all.
 *    `scripts/verify-canopy.ts` measures that rather than trusting it.
 * ------------------------------------------------------------------ */

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Spot = { x: number; z: number; roll: number }

/**
 * One planted tree, reduced to what two other things need to know about it:
 * the crown-separation test while planting, and the camera afterwards.
 *
 * `id` and `scale` are kept because the camera test is exact against the drawn
 * voxels — a bounding cylinder round an elder oak is twenty metres across and
 * would shove the lens out of its way for nothing.
 */
type Crown = {
  id: TreeSpeciesId
  scale: number
  /** The wider of the two non-uniform width axes. */
  squash: number
  x: number
  z: number
  /** Metres, widest foliage half-width of this instance. */
  crownRadius: number
  /** Metres, widest half-width of anything at all: the cull radius. */
  reach: number
  /** Metres, underside of the lowest leaf and top of the highest. */
  base: number
  top: number
}

/**
 * How the spring arm got the lens out of the wood, cheapest first.
 *
 * `clear` is the request honoured untouched, `over` is the last-resort climb
 * straight up above every crown — it is counted rather than trusted, because if
 * it ever happens in play the price list below is wrong.
 */
type ArmMode = 'clear' | 'lift' | 'duck' | 'slide' | 'short' | 'over'

/**
 * Scatter `count` points across a region's open green, lobe by lobe in
 * proportion to area, so a lopsided region gets planted lopsidedly instead of
 * piling everything into the middle of its biggest blob.
 */
function scatter(region: WildRegion, count: number, rng: () => number, inset: number): Spot[] {
  const out: Spot[] = []
  const area = region.lobes.reduce((sum, lobe) => sum + lobe.r * lobe.r, 0)
  /* Thirty tries per wanted point, not eight. The crown-separation test below
   * rejects most candidates in a dense wood on purpose, and at eight tries the
   * sampler ran out of attempts long before it ran out of room — which is how
   * raising the separation used to mean simply losing half the trees. */
  for (let attempt = 0; attempt < count * 30 && out.length < count; attempt++) {
    let pick = rng() * area
    let lobe = region.lobes[0]
    for (const candidate of region.lobes) {
      lobe = candidate
      pick -= candidate.r * candidate.r
      if (pick <= 0) break
    }
    const angle = rng() * Math.PI * 2
    const radius = Math.sqrt(rng()) * lobe.r
    const x = lobe.x + Math.cos(angle) * radius
    const z = lobe.z + Math.sin(angle) * radius
    if (!isGreen(x, z, inset)) continue
    if (!insideRegion(region, x, z, inset)) continue
    // Keep every hunt trail walkable rather than growing a pine in the middle.
    if (huntTrails.some(trail => trail.some(([tx, tz]) => Math.hypot(x - tx, z - tz) < 4.5))) continue
    out.push({ x, z, roll: rng() })
  }
  return out
}

/* --- surfaces -------------------------------------------------------- */

const TIMBER: Surface = { color: '#59422c', roughness: 0.9 }
const TIMBER_DARK: Surface = { color: '#3b2b1c', roughness: 0.92 }
const PLANK: Surface = { color: '#6b5a44', roughness: 0.95 }
const PLANK_WORN: Surface = { color: '#7c6a50', roughness: 0.95 }
const STONE: Surface = { color: '#5a6167', roughness: 0.95 }
const STONE_DARK: Surface = { color: '#44494e', roughness: 0.95 }
const MOSS: Surface = { color: '#4a6248', roughness: 0.95 }
const GRASS: Surface = { color: '#54723f', roughness: 0.95 }
const GRASS_DRY: Surface = { color: '#7a7c44', roughness: 0.95 }
const FERN: Surface = { color: '#436143', roughness: 0.95 }
const CANVAS: Surface = { color: '#6d5a42', roughness: 0.92 }
const LAMP: Surface = { color: '#f0b84d', glow: 2.2, roughness: 0.2, noShadow: true }
const BRASS_LAMP: Surface = { color: '#c4893a', glow: 1.9, roughness: 0.25, noShadow: true }

/** One ground tone per region kind, cut to the region's own outline. */
function groundPatch(region: WildRegion) {
  const outline = regionOutline(region, 56)
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, z)))
  const geometry = new THREE.ShapeGeometry(shape)
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: region.color, roughness: 0.95 }),
  )
  // ShapeGeometry is drawn in XY; lay it down so shape-y becomes world z.
  mesh.rotation.x = Math.PI / 2
  mesh.position.y = 0.05
  mesh.receiveShadow = true
  return mesh
}

/* --- what grows where ------------------------------------------------ *
 * Per region kind: which species, in what proportion, and how much ground each
 * tree gets. Densities are metres squared per tree against the region's MEASURED
 * open green, so a bigger clearing fills itself in without anyone retuning a
 * count — and the giants are rationed by a flat maximum, because two titans in
 * one clearing is a landmark and nine is a wall.
 * ------------------------------------------------------------------- */
type Planting = {
  /** Square metres of open green per tree. */
  spacing: number
  /**
   * Crown separation in this kind of ground: centre distance as a fraction of
   * the two crown radii. A wood is allowed to interlock more than a meadow —
   * that is the difference between a wood and a meadow — but see
   * `CROWN_SEPARATION` for what the number means and what it used to be.
   */
  separation: number
  /** Cumulative weights over species; the last one catches the remainder. */
  mix: Array<[TreeSpeciesId, number]>
  /** Hard cap per region on the two enormous species. */
  giants: number
  /** Square metres per grass tuft. */
  grass: number
  /** Square metres per boulder. */
  rock: number
  /** Nothing is planted within this radius of the region heart, for sightlines. */
  clearing: number
}

/**
 * Spacing is now a BUDGET, not an outcome.
 *
 * The real limit on how many trees stand in a wood is `CROWN_SEPARATION` below,
 * which rejects a candidate whose crown would sit inside a neighbour's. So the
 * densities here are deliberately more generous than the ground can take — they
 * decide how hard the sampler tries, and the separation decides what survives.
 * Tuning one without the other is what produced a wood of 47 trees where 98
 * were budgeted.
 */
const planting: Record<WildRegion['kind'], Planting> = {
  wildwood: { spacing: 26, separation: 0.6, mix: [['pine', 0.52], ['birch', 0.68], ['oak', 0.85], ['titanpine', 0.95], ['elder', 1]], giants: 7, grass: 26, rock: 120, clearing: 11 },
  woods: { spacing: 28, separation: 0.62, mix: [['pine', 0.45], ['oak', 0.75], ['birch', 0.94], ['elder', 1]], giants: 2, grass: 30, rock: 150, clearing: 6 },
  // Fewer ironbarks than before, proportionally. A fourteen-metre bronze crown
  // is the wood's signature and at seventy per cent of the mix there was only
  // room for two of them in the whole region.
  // No scrub in a wood. A thicket is a solid blocker over its whole width, and
  // the three wooded regions are where the bears are: the one place a player has
  // to be able to pick a target out at range. The wood floor is dressed with
  // grass tufts and ferns instead, which are not obstacles and are ankle high.
  brasswood: { spacing: 24, separation: 0.58, mix: [['ironbark', 0.58], ['titanpine', 0.7], ['pine', 0.9], ['birch', 1]], giants: 9, grass: 34, rock: 70, clearing: 4 },
  grassland: { spacing: 70, separation: 0.8, mix: [['oak', 0.4], ['birch', 0.7], ['scrub', 1]], giants: 1, grass: 18, rock: 300, clearing: 0 },
  meadow: { spacing: 80, separation: 0.8, mix: [['oak', 0.35], ['scrub', 1]], giants: 1, grass: 20, rock: 320, clearing: 0 },
  fields: { spacing: 85, separation: 0.8, mix: [['birch', 0.5], ['scrub', 1]], giants: 0, grass: 22, rock: 400, clearing: 0 },
  outskirts: { spacing: 90, separation: 0.82, mix: [['scrub', 0.7], ['birch', 1]], giants: 1, grass: 24, rock: 260, clearing: 0 },
}

const GIANT_SPECIES = new Set<TreeSpeciesId>(['titanpine', 'elder'])

/** Height multiplier ranges, so one species still covers a range of ages. */
const sizeRange: Record<TreeSpeciesId, [number, number]> = {
  pine: [0.88, 1.3],
  titanpine: [0.9, 1.18],
  oak: [0.8, 1.2],
  elder: [0.92, 1.12],
  birch: [0.8, 1.25],
  ironbark: [0.84, 1.16],
  // A thicket rather than a tree, and a blocking one, so it is the one species
  // whose size range is capped for SIGHTLINES rather than for looks: 1.0m to
  // 1.6m planted, which is under the eye at 2.7m from every standing position.
  scrub: [0.65, 1.05],
}

/**
 * Metres of leaf-free bole every planted tree keeps above the ground.
 *
 * THIRTEEN METRES, and the number comes from what has to fit under it, not from
 * what fits round a body. The body is 1.9m and the first-person eye is 2.7m, so
 * 4.2m — where this sat — cleared both and still failed completely, because
 * clearing a head is not the same as clearing a SIGHTLINE. Foliage beginning a
 * metre and a half over the eye is a ceiling: it fills the upper two thirds of
 * the frame at every range, the third-person lens meets it constantly at a 2.4m
 * to 4m orbit, and an animal thirty metres off is behind leaf rather than in
 * view. Measured: a horizontal ray at eye height reached 25m from 33% of
 * standing positions in the wildwood.
 *
 * 13m is chosen against three things that are not the player's height:
 *   - the third-person orbit, which reaches about 8m of lens height at the
 *     zooms people actually use, so the crown has to start above that;
 *   - the tallest thing in town, a 5m townhouse, so a wood still towers;
 *   - real mature woodland, where the first branch of a 25m broadleaf is
 *     between ten and fifteen metres up and you can see two hundred metres.
 * Higher than 16m and the crowns stop reading as connected to their trunks from
 * inside; lower than 12m and the low orbit is back in the leaves.
 *
 * Every species in `src/treeArt.ts` is authored with enough BARE BOLE ROWS to
 * reach this on its own, so `plantAt`'s scale floor barely has to do anything —
 * which is the point. Translating a crown upward by inflating the tree is how
 * you get a 60m pine.
 */
const TRUNK_CORRIDOR = 13

/**
 * How close two trunks may stand, as a fraction of their combined crown radius.
 *
 * This number is the whole of the clumping complaint. At 0.34 — where it sat,
 * for every tree in the world — two crowns stood at barely a third of their
 * combined radius, which is very nearly concentric: what the player saw was not
 * a wood but a few enormous lumps of leaf with several trunks growing out of
 * each. At 1.0 crowns would merely touch, which reads as an orchard.
 *
 * This is the OPEN COUNTRY figure, used for lone trees; a wood uses the tighter
 * `separation` on its own planting rule, and a grove tighter still. Raising all
 * three is only half the job: the sampler's attempt budget and the `spacing`
 * densities had to come up with them or the same rejection rate simply produces
 * fewer trees, which is what a previous pass measured as 52% rejected.
 */
const CROWN_SEPARATION = 0.8

/**
 * Inside a grove the rule is relaxed on purpose.
 *
 * A knot of three or four trunks sharing one crown is the best-looking thing a
 * wood does; the problem was never that it happened, it was that it happened
 * EVERYWHERE and by accident. Groves are placed deliberately, they are a small
 * fraction of the ground, and outside them crowns keep their distance.
 */
const GROVE_SEPARATION = 0.46
const GROVE_RADIUS = 9
/** Square metres of open green that earns a region one grove. */
const GROVE_AREA = 420

/**
 * Absolute floor on trunk-to-trunk distance, whatever the crowns say.
 *
 * FIVE METRES. At 2.4m — where this sat — two small trees could stand closer
 * together than the player is wide, which is the "still too close to each other"
 * half of the complaint: the crown rule is written in crown radii, so a pair of
 * birches with 3m crowns satisfied it at under three metres apart and read as
 * one forked plant rather than two trees. 5m is a gap you walk through without
 * thinking about it, and with the boles now under a metre through it is 4m of
 * clear air between bark and bark.
 *
 * It is a floor, not the typical spacing: the crown rule still pushes two pines
 * about 7m apart and two elders about 12m.
 */
const TRUNK_FLOOR = 5

/**
 * Widest the random squash in `plantAt` can make a tree, as a multiplier.
 *
 * The roll is 0.92 to 1.08 and it is applied as x*squash, z/squash, so the
 * widest either axis gets is 1/0.92. Used where a keep-out has to hold for the
 * tree that is about to be planted, before its squash has been rolled.
 */
const MAX_SQUASH = 1 / 0.92

/**
 * Metres outside a duel ring kept free of anything solid.
 *
 * A duel is not fought standing still on the mark: both players circle, retreat
 * and get knocked back, and the ring edge is not a wall. Six metres is the
 * run-up the ring's own navigation allowance already assumed.
 */
const RING_RUN_UP = 6

/**
 * Is something solid of this radius clear of every duel ring and its run-up?
 *
 * Trees are not the only thing scattered across the same ground: boulders come
 * out of the same region loop and never pass through `plantAt`, and a knee-high
 * rock on the rim of a ring is something to trip over in a fight where neither
 * player chose the footing.
 */
function clearOfRings(x: number, z: number, radius: number) {
  return !DUEL_RINGS.some(ring => Math.hypot(x - ring.x, z - ring.z) - radius < ring.radius + RING_RUN_UP)
}

/**
 * Metres of clear approach in front of a landmark building.
 *
 * A landmark is built to be seen from down the street — that is the whole of
 * why it is one — and the Zcash house had a birch standing at x=50.0 against a
 * door at x=50, with a second one lined up eleven metres behind it. Neither was
 * illegally placed: both cleared the building skirt and the paving by the rules
 * that existed, which only ever asked about walking into things, never about
 * looking at them.
 */
const LANDMARK_APPROACH = 20

/**
 * The strip in front of each landmark that stays empty, derived from the
 * buildings rather than typed out, so a second landmark gets the same courtesy
 * without anybody remembering to add it here.
 *
 * Every door in town is on the −z face, which is what makes one rectangle per
 * landmark enough. Widened three metres past the footprint because a tree at
 * the corner of the frame blocks the frontage as effectively as one in the
 * middle of it.
 */
const landmarkFronts = buildingSpecs
  .filter(spec => spec.landmark)
  .map(spec => ({
    x: spec.x,
    halfWidth: spec.width / 2 + 3,
    near: spec.z - spec.depth / 2,
    far: spec.z - spec.depth / 2 - LANDMARK_APPROACH,
  }))

/**
 * Is a plant of this radius clear of every landmark's approach?
 *
 * Tested against the CROWN rather than the bole, unlike the duel rings. On the
 * ground a corridor only has to be walkable, but a landmark is looked at from
 * eye height to well above it — the Zcash coin spans eight to twenty-three
 * metres up, which is exactly the band a 13m canopy occupies — so foliage in
 * the approach hides it just as completely as a trunk would.
 */
function clearOfLandmarkViews(x: number, z: number, radius: number) {
  return !landmarkFronts.some(
    front =>
      Math.abs(x - front.x) < front.halfWidth + radius &&
      z < front.near + radius &&
      z > front.far - radius,
  )
}

export function createWildscape() {
  const root = new THREE.Group()
  root.name = 'wildscape'
  const rng = mulberry32(90210)
  const batch = createBatch()
  /* Everything here that is NOT batched and NOT instanced: the ground patches,
   * the water, the fire and the lettered sign boards. Each owns its own
   * geometry and material, so each has to be handed back by dispose(). */
  const loose: THREE.Mesh[] = []
  const placements = new Map<TreeSpeciesId, TreePlacement[]>()
  const obstacles: Array<{ kind: 'circle'; x: number; z: number; r: number }> = []
  /** Every planted tree, for the crown-separation test and for the camera. */
  const crowns: Crown[] = []

  const plant = (id: TreeSpeciesId, placement: TreePlacement) => {
    if (!placements.has(id)) placements.set(id, [])
    placements.get(id)!.push(placement)
    const metrics = treeMetrics(id)
    const scale = placement.scale
    /* What blocks movement is what is SOLID in the band a body occupies, read
     * off the voxel profile — the bare bole for a tree you walk under, the
     * entire bush for a thicket whose leaves reach the ground. It used to be
     * the profile's advisory `trunkRadius`, which on the flared species was out
     * by a factor of six: the elder drew a fourteen-metre stump and blocked a
     * 2.3m circle, so the player walked into the wood of the tree. */
    // Non-uniform width is applied as x*squash, z/squash, so the wider axis is
    // whichever way squash went. Take the wider one everywhere: an over-wide
    // volume costs the camera a little room, an under-wide one is a body inside
    // a tree — which is exactly what the 8% of squash used to buy.
    const squash = Math.max(placement.squash ?? 1, 1 / (placement.squash ?? 1))
    const solid = metrics.solidRadiusBelow(TRUNK_CORRIDOR / scale) * scale * squash
    obstacles.push({ kind: 'circle', x: placement.x, z: placement.z, r: solid + 0.2 })
    crowns.push({
      id,
      scale,
      squash,
      x: placement.x,
      z: placement.z,
      crownRadius: metrics.canopyRadius * scale * squash,
      reach: Math.max(metrics.canopyRadius, metrics.footprintRadius) * scale * squash,
      base: metrics.canopy.base * scale,
      top: metrics.canopy.top * scale,
    })
  }

  /**
   * Plant one tree, or decline to.
   *
   * Every tree in the world goes through here — woods, copses, hedgerows, lone
   * trees on open ground — so the two rules hold everywhere by construction:
   * the scale is floored until the species' own lowest leaf clears
   * TRUNK_CORRIDOR, and the crown has to stand clear of its neighbours'.
   */
  const plantAt = (id: TreeSpeciesId, x: number, z: number, separation: number) => {
    const [low, high] = sizeRange[id]
    const metrics = treeMetrics(id)
    /* The scale at which this species' lowest leaf reaches the corridor. A
     * thicket — leaves at ground level — can never get there at any sane size,
     * so it keeps its authored range and blocks instead. */
    const clearing = metrics.canopy.base > 0.25 ? TRUNK_CORRIDOR / metrics.canopy.base : Infinity
    const floor = clearing <= high ? Math.max(low, clearing) : low
    const scale = floor + rng() * (high - floor)
    const radius = metrics.canopyRadius * scale
    /* Duel rings keep their own clearance, and this is the only place that can
     * enforce it: the ring test used to live solely in the predicate for trees
     * planted OUTSIDE the hunting regions, and North Copse sits inside one — so
     * it had six boles standing in the ring, the nearest 3.9m from the centre,
     * two of them thickets whose leaves reach the ground. That is the "trees in
     * the pvp area" complaint exactly.
     *
     * The two halves ask different questions and get different distances. What
     * is SOLID has to stay out of the ring AND its run-up, because that is what
     * a duellist walks into. A CROWN only has to stay off the ring itself: it
     * begins at TRUNK_CORRIDOR overhead, so it is not in anybody's way at eye
     * height, but it is what the third-person lens and the aim look through.
     * A tree may therefore still stand just outside with its branches stopping
     * at the rim, which is why the copse still reads as a copse. */
    const bole = metrics.solidRadiusBelow(TRUNK_CORRIDOR / scale) * scale * MAX_SQUASH + 0.2
    if (!clearOfRings(x, z, bole)) return false
    const crown = radius * MAX_SQUASH
    if (DUEL_RINGS.some(ring => Math.hypot(x - ring.x, z - ring.z) - crown < ring.radius)) return false
    if (!clearOfLandmarkViews(x, z, crown)) return false
    for (const other of crowns) {
      const gap = Math.max(TRUNK_FLOOR, (other.crownRadius + radius) * separation)
      if (Math.hypot(other.x - x, other.z - z) < gap) return false
    }
    plant(id, {
      x,
      z,
      scale,
      yaw: rng() * Math.PI * 2,
      lean: (rng() - 0.5) * (GIANT_SPECIES.has(id) ? 0.03 : 0.09),
      squash: 0.92 + rng() * 0.16,
      tint: 0.88 + rng() * 0.24,
    })
    return true
  }

  /** Pick a species out of a cumulative-weight mix. */
  const speciesFor = (mix: Array<[TreeSpeciesId, number]>, roll: number) => {
    for (const [candidate, ceiling] of mix) if (roll <= ceiling) return candidate
    return mix[mix.length - 1][0]
  }

  /* --- the shape of the open ground ---------------------------------- */
  const areas = new Map<string, number>()
  for (const region of wildRegions) {
    const patch = groundPatch(region)
    root.add(patch)
    loose.push(patch)
    areas.set(region.id, regionArea(region))
  }

  /* --- woods --------------------------------------------------------- */
  for (const region of wildRegions) {
    const rule = planting[region.kind]
    const area = areas.get(region.id) ?? 0
    const wanted = Math.round(area / rule.spacing)
    let giants = 0
    /* Three candidate positions per tree budgeted, because the separation test
     * below is what decides how many stand and it rejects most of what it is
     * offered in a dense wood. Offered exactly `wanted` positions — which is
     * what used to happen — a wood could never reach its own budget however
     * generous the budget was: the wildwood asked for 118 and planted 23. */
    const spots = scatter(region, wanted * 3, rng, 2.5)

    /* A handful of grove hearts, taken off the front of the same scatter so they
     * are spread the way the region is. Inside one of these the separation rule
     * relaxes and trunks knot together; everywhere else crowns keep clear. */
    const groves = spots.slice(0, Math.max(1, Math.round(area / GROVE_AREA)))
      .map(spot => ({ x: spot.x, z: spot.z }))
    const inGrove = (x: number, z: number) =>
      groves.some(grove => Math.hypot(grove.x - x, grove.z - z) < GROVE_RADIUS)

    for (const spot of spots) {
      // Clearings stay open so the third-person camera has somewhere to sit and
      // the player can see what is coming.
      if (rule.clearing && Math.hypot(spot.x - region.x, spot.z - region.z) < rule.clearing) continue
      let id = speciesFor(rule.mix, spot.roll)
      if (GIANT_SPECIES.has(id)) {
        if (giants >= rule.giants) id = region.kind === 'brasswood' ? 'ironbark' : 'pine'
        else giants += 1
      }
      // A giant never joins a grove: two twenty-metre crowns in one knot is the
      // wall the giant ration exists to prevent.
      const separation = !GIANT_SPECIES.has(id) && inGrove(spot.x, spot.z) ? GROVE_SEPARATION : rule.separation
      if (!plantAt(id, spot.x, spot.z, separation) && GIANT_SPECIES.has(id)) giants -= 1
    }

    /* --- undergrowth: grass tufts and ferns, cut into the same ground --- */
    for (const spot of scatter(region, Math.round(area / rule.grass), rng, 1)) {
      const dry = region.kind === 'brasswood' || region.kind === 'outskirts'
      const blades = 2 + Math.floor(spot.roll * 3)
      for (let i = 0; i < blades; i++) {
        const height = 0.25 + rng() * 0.5
        batch.box(
          [0.14, height, 0.14],
          [spot.x + (rng() - 0.5) * 0.9, height / 2, spot.z + (rng() - 0.5) * 0.9],
          rng() < 0.3 ? FERN : dry ? GRASS_DRY : GRASS,
          { rotY: rng() * Math.PI, rotZ: (rng() - 0.5) * 0.5 },
        )
      }
    }

    /* --- boulders ------------------------------------------------------ */
    for (const spot of scatter(region, Math.round(area / rule.rock), rng, 2)) {
      const size = 0.7 + spot.roll * 1.6
      if (!clearOfRings(spot.x, spot.z, size * 0.6)) continue
      // Three stacked slabs, shrinking: a voxel boulder rather than a polyhedron.
      batch.box([size, size * 0.5, size * 0.9], [spot.x, size * 0.22, spot.z], STONE, { rotY: spot.roll * 3 })
      batch.box([size * 0.72, size * 0.42, size * 0.66], [spot.x + 0.1, size * 0.62, spot.z - 0.08], STONE_DARK, { rotY: spot.roll * 5 })
      if (spot.roll > 0.55) batch.box([size * 0.5, size * 0.2, size * 0.46], [spot.x - 0.1, size * 0.9, spot.z + 0.1], MOSS, { rotY: spot.roll * 7 })
      obstacles.push({ kind: 'circle', x: spot.x, z: spot.z, r: size * 0.6 })
    }
  }

  /* --- the rest of the world ------------------------------------------ *
   * Trees used to exist only inside the seven hunting regions, because the
   * planting table is keyed by region kind and nothing ever asked what grew
   * between them. The answer was nothing, so the world read as seven forests
   * standing on a lawn.
   *
   * What goes in here is countryside, not wood: a few small copses, hedgerows
   * along nothing in particular the way hedgerows are, and lone trees on open
   * ground. Sparse by design — the woods have to stay the dense thing — and
   * every trunk goes through the same `plantAt` as a wood's, so it keeps the
   * same clear corridor and registers the same navigation obstacle.
   *
   * Where it will NOT go: on the plaza or within five metres of it, on any paved
   * street or within three of one, on or within five and a half metres of a
   * building footprint, inside or within four metres of a hunting region (the
   * regions plant themselves), within six metres of a marked hunt trail, inside
   * a duel ring plus six metres of run-up, or on top of the town's own perimeter
   * woodland. That union also swallows the canal and its banks, the fountain,
   * the notice board and the market stalls, all of which sit inside the paving
   * or the plaza — so every existing navigation obstacle is already excluded.
   *
   * The keep-out is built from `shared/zones` rather than from `isGreen`, which
   * is the WILDLIFE fence: its nine-metre skirt round every building and four
   * round every street exists to keep animals out of town, and applied to trees
   * it ruled out seventy per cent of the map — which is a different way of
   * planting nothing.
   * ------------------------------------------------------------------- */
  const PAVING_CLEAR = 3
  const PLAZA_CLEAR = 5
  const BUILDING_CLEAR = 5.5
  const perimeter = perimeterTrees()
  const nearTrail = (x: number, z: number, within: number) =>
    huntTrails.some(trail => {
      for (let i = 0; i < trail.length - 1; i++) {
        const [ax, az] = trail[i]
        const [bx, bz] = trail[i + 1]
        const dx = bx - ax
        const dz = bz - az
        const span = dx * dx + dz * dz
        const t = span < 1e-6 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / span))
        if (Math.hypot(x - (ax + dx * t), z - (az + dz * t)) < within) return true
      }
      return false
    })

  const openCountry = (x: number, z: number) => {
    if (Math.abs(x) > WORLD_HALF - 4 || Math.abs(z) > WORLD_HALF - 4) return false
    if (Math.hypot(x - townPlaza.x, z - townPlaza.z) <= townPlaza.r + PLAZA_CLEAR) return false
    if (townPaving.some(r => Math.abs(x - r.x) <= r.halfW + PAVING_CLEAR && Math.abs(z - r.z) <= r.halfD + PAVING_CLEAR)) return false
    if (townBuildings.some(r => Math.abs(x - r.x) <= r.halfW + BUILDING_CLEAR && Math.abs(z - r.z) <= r.halfD + BUILDING_CLEAR)) return false
    if (wildRegions.some(region => insideRegion(region, x, z, -4))) return false
    if (nearTrail(x, z, 6)) return false
    if (DUEL_RINGS.some(ring => Math.hypot(x - ring.x, z - ring.z) < ring.radius + 6)) return false
    return !perimeter.some(tree => Math.hypot(x - tree.x, z - tree.z) < 4.5)
  }

  /** A point on open country, or null if forty tries could not find one. */
  const countrySpot = (): Spot | null => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = (rng() * 2 - 1) * (WORLD_HALF - 6)
      const z = (rng() * 2 - 1) * (WORLD_HALF - 6)
      if (openCountry(x, z)) return { x, z, roll: rng() }
    }
    return null
  }

  const COPSE_MIX: Array<[TreeSpeciesId, number]> = [['birch', 0.42], ['oak', 0.7], ['pine', 0.9], ['scrub', 1]]
  const HEDGE_MIX: Array<[TreeSpeciesId, number]> = [['scrub', 0.6], ['birch', 0.9], ['oak', 1]]
  /* One lone tree in thirty is an elder oak, which at thirty-one metres and a
   * twenty-metre crown is a landmark you can navigate by from across the map. */
  const LONE_MIX: Array<[TreeSpeciesId, number]> = [['oak', 0.3], ['birch', 0.56], ['pine', 0.74], ['scrub', 0.967], ['elder', 1]]

  let copses = 0
  let hedges = 0
  let hedgePlants = 0
  let lone = 0

  /* Copses: three to seven trees in a knot, which is the grove rule applied to
   * open ground. This is where deliberate tight planting belongs. */
  for (let i = 0; i < 26; i++) {
    const heart = countrySpot()
    if (!heart) continue
    let grown = 0
    for (let n = 0; n < 9; n++) {
      const angle = rng() * Math.PI * 2
      const radius = Math.sqrt(rng()) * 7
      const x = heart.x + Math.cos(angle) * radius
      const z = heart.z + Math.sin(angle) * radius
      if (!openCountry(x, z)) continue
      if (plantAt(speciesFor(COPSE_MIX, rng()), x, z, GROVE_SEPARATION)) grown += 1
    }
    if (grown) copses += 1
  }

  /* Hedgerows: a line of thicket and birch with gaps in it. The gaps are not
   * decoration — a solid hedge is a wall, and every plant in one blocks.
   *
   * Laid outward from the middle in BOTH directions, each end stopping on its
   * own. Open country between the streets and the regions comes in narrow
   * ribbons, and a run laid one way from its start used to hit a street after
   * two plants and give up: one hedgerow out of eighteen tries survived. */
  for (let i = 0; i < 18; i++) {
    const start = countrySpot()
    if (!start) continue
    const yaw = rng() * Math.PI * 2
    const step = 3.4
    let grown = 0
    for (const way of [1, -1]) {
      for (let n = way > 0 ? 0 : 1; n < 7; n++) {
        // A fifth of the stations are left empty, so the run stays passable.
        if (rng() < 0.2) continue
        const x = start.x + Math.cos(yaw) * step * n * way + (rng() - 0.5) * 1.4
        const z = start.z + Math.sin(yaw) * step * n * way + (rng() - 0.5) * 1.4
        if (!openCountry(x, z)) break
        if (plantAt(speciesFor(HEDGE_MIX, rng()), x, z, GROVE_SEPARATION)) grown += 1
      }
    }
    hedgePlants += grown
    if (grown >= 3) hedges += 1
  }

  /* Lone trees, spread over everything that is left. */
  for (let i = 0; i < 240; i++) {
    const spot = countrySpot()
    if (!spot) continue
    if (plantAt(speciesFor(LONE_MIX, spot.roll), spot.x, spot.z, CROWN_SEPARATION)) lone += 1
  }

  const country = { copses, hedges, hedgePlants, lone }

  /* --- the wildwood pond and standing stones ------------------------- */
  const pondX = huntingArea.x + 12
  const pondZ = huntingArea.z - 10
  const pond = new THREE.Mesh(
    new THREE.CircleGeometry(8.2, 22),
    new THREE.MeshStandardMaterial({ color: '#1d5560', emissive: '#10323a', emissiveIntensity: 0.7, roughness: 0.15, metalness: 0.2 }),
  )
  pond.rotation.x = -Math.PI / 2
  pond.position.set(pondX, 0.09, pondZ)
  root.add(pond)
  loose.push(pond)
  for (let i = 0; i < 22; i++) {
    const angle = (i / 22) * Math.PI * 2
    const size = 0.5 + rng() * 0.6
    const x = pondX + Math.cos(angle) * 8.5
    const z = pondZ + Math.sin(angle) * 8.5
    batch.box([size, size * 0.5, size], [x, size * 0.2, z], i % 3 === 0 ? MOSS : STONE, { rotY: rng() * 3 })
  }
  // Reeds on the near bank, so the water has an edge rather than a rim.
  for (let i = 0; i < 40; i++) {
    const angle = rng() * Math.PI * 2
    const x = pondX + Math.cos(angle) * (8.4 + rng() * 1.6)
    const z = pondZ + Math.sin(angle) * (8.4 + rng() * 1.6)
    if (!isGreen(x, z, 1)) continue
    const height = 0.6 + rng() * 0.8
    batch.box([0.12, height, 0.12], [x, height / 2, z], GRASS_DRY, { rotZ: (rng() - 0.5) * 0.4 })
  }

  const standingStones: Array<{ x: number; z: number }> = []
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + 0.4
    const x = huntingArea.x + Math.cos(angle) * 14
    const z = huntingArea.z + Math.sin(angle) * 14
    const height = 4.2 + rng() * 2.2
    const tilt = (rng() - 0.5) * 0.16
    // Built as three courses so the monolith reads as cut stone, not a box.
    batch.box([1.5, 0.5, 1.2], [x, 0.25, z], STONE_DARK)
    batch.box([1.1, height, 0.9], [x, height / 2 + 0.4, z], STONE, { rotZ: tilt, rotY: angle })
    batch.box([1.25, 0.5, 1.05], [x + Math.sin(tilt) * height, height + 0.6, z], STONE_DARK, { rotY: angle })
    standingStones.push({ x, z })
    obstacles.push({ kind: 'circle', x, z, r: 0.95 })
  }

  /* --- fallen logs in the clearing ----------------------------------- */
  for (let i = 0; i < 6; i++) {
    const angle = rng() * Math.PI * 2
    const radius = 10 + rng() * 16
    const x = huntingArea.x + Math.cos(angle) * radius
    const z = huntingArea.z + Math.sin(angle) * radius
    if (!isGreen(x, z, 2)) continue
    const length = 3 + rng() * 2.4
    const yaw = rng() * Math.PI
    batch.box([length, 0.68, 0.68], [x, 0.34, z], { color: '#4a3a2c', roughness: 0.95 }, { rotY: yaw })
    batch.box([0.3, 0.72, 0.72], [x + Math.cos(yaw) * length * 0.5, 0.36, z - Math.sin(yaw) * length * 0.5], TIMBER_DARK, { rotY: yaw })
  }

  /* --- the trails out of town ---------------------------------------- */
  const lanternAt: Array<[number, number]> = []
  const layTrail = (waypoints: Array<[number, number]>) => {
    for (let i = 0; i < waypoints.length - 1; i++) {
      const [ax, az] = waypoints[i]
      const [bx, bz] = waypoints[i + 1]
      const length = Math.hypot(bx - ax, bz - az)
      const segments = Math.max(2, Math.round(length / 1.6))
      const yaw = Math.atan2(bx - ax, bz - az)
      for (let s = 0; s < segments; s++) {
        const t = s / segments
        const x = ax + (bx - ax) * t
        const z = az + (bz - az) * t
        // Two worn tones alternating: a trodden path, not a boardwalk.
        batch.box([3.1, 0.12, 1.6], [x, 0.07, z], s % 2 ? PLANK : PLANK_WORN, { rotY: yaw })
        if (s % 3 === 0) batch.box([0.5, 0.1, 0.5], [x + Math.cos(yaw) * 1.8, 0.1, z + Math.sin(yaw) * 1.8], STONE, { rotY: yaw })
      }
      lanternAt.push([bx + 1.9, bz + 1.1])
    }
  }
  layTrail(trailWaypoints)
  layTrail(brassTrailWaypoints)

  for (const [x, z] of lanternAt) {
    batch.box([0.18, 1.8, 0.18], [x, 0.9, z], TIMBER_DARK)
    batch.box([0.3, 0.1, 0.3], [x, 1.85, z], TIMBER)
    batch.box([0.42, 0.56, 0.42], [x, 1.62, z], LAMP)
  }

  /* --- hunter's camp at the edge of the wildwood --------------------- */
  const campX = huntingArea.x + 15
  const campZ = huntingArea.z + 18
  // A ridge tent: two sloped canvas walls on a pole, not a cone.
  batch.box([0.14, 2.4, 0.14], [campX - 2.2, 1.2, campZ], TIMBER_DARK)
  batch.box([0.14, 2.4, 0.14], [campX + 2.2, 1.2, campZ], TIMBER_DARK)
  batch.box([5.0, 0.16, 0.16], [campX, 2.4, campZ], TIMBER)
  for (const side of [-1, 1]) {
    batch.box([5.2, 0.16, 3.4], [campX, 1.3, campZ + side * 1.2], CANVAS, { rotX: side * 0.72 })
  }
  batch.box([5.2, 0.2, 0.2], [campX, 0.1, campZ + 2.3], TIMBER_DARK)
  batch.box([5.2, 0.2, 0.2], [campX, 0.1, campZ - 2.3], TIMBER_DARK)
  obstacles.push({ kind: 'circle', x: campX, z: campZ, r: 2.6 })

  // Drying rack with pelts, and a crate: signs somebody hunts here.
  batch.box([0.16, 1.7, 0.16], [campX - 4.4, 0.85, campZ + 1.4], TIMBER_DARK)
  batch.box([0.16, 1.7, 0.16], [campX - 1.4, 0.85, campZ + 1.4], TIMBER_DARK)
  batch.box([3.2, 0.14, 0.14], [campX - 2.9, 1.65, campZ + 1.4], TIMBER)
  for (let i = 0; i < 3; i++) {
    batch.box([0.7, 0.9, 0.08], [campX - 4.0 + i * 1.1, 1.15, campZ + 1.4], { color: '#7a5a38', roughness: 0.9 })
  }
  batch.box([1.1, 0.9, 0.9], [campX + 3.4, 0.45, campZ + 2.6], { color: '#70543c', roughness: 0.9 }, { rotY: 0.3 })

  // The fire keeps its own mesh, because it pulses: a batched box cannot be
  // scaled on its own. One point light out here, and this is it.
  const fireX = campX + 3.4
  const fireZ = campZ - 1.2
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2
    batch.box([0.44, 0.3, 0.4], [fireX + Math.cos(angle) * 1.15, 0.15, fireZ + Math.sin(angle) * 1.15], STONE_DARK, { rotY: angle })
  }
  for (let i = 0; i < 4; i++) {
    batch.box([1.5, 0.22, 0.22], [fireX, 0.2 + i * 0.12, fireZ], TIMBER_DARK, { rotY: (i / 4) * Math.PI })
  }
  const fire = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.9, 0.7),
    new THREE.MeshStandardMaterial({ color: '#e35e35', emissive: '#e35e35', emissiveIntensity: 2.8, roughness: 0.3 }),
  )
  fire.position.set(fireX, 0.6, fireZ)
  root.add(fire)
  loose.push(fire)
  const fireLight = new THREE.PointLight('#e8863c', 3.2, 18)
  fireLight.position.set(fireX, 1.4, fireZ)
  root.add(fireLight)

  /* --- the brasswood: dry hollow, timber cribs, brass lamps ---------- */
  const brass = highHuntArea
  const hollow = new THREE.Mesh(
    new THREE.CircleGeometry(6.0, 18),
    new THREE.MeshStandardMaterial({ color: '#1a1814', roughness: 0.98 }),
  )
  hollow.rotation.x = -Math.PI / 2
  hollow.position.set(brass.x - 3, 0.08, brass.z + 2)
  root.add(hollow)
  loose.push(hollow)

  const brassStumps: Array<{ x: number; z: number }> = []
  for (let i = 0; i < 11; i++) {
    const angle = (i / 11) * Math.PI * 2 + 0.3
    const radius = 8 + (i % 4) * 1.6
    const x = brass.x + Math.cos(angle) * radius
    const z = brass.z + Math.sin(angle) * radius
    if (!isGreen(x, z, 2) || !insideRegion(brass, x, z, ROAM_INSET)) continue
    batch.box([1.5, 0.7, 1.5], [x, 0.35, z], { color: '#2c241c', roughness: 0.95 }, { rotY: rng() * 3 })
    batch.box([1.2, 0.16, 1.2], [x, 0.76, z], { color: '#4a3a2c', roughness: 0.9 }, { rotY: rng() * 3 })
    brassStumps.push({ x, z })
    obstacles.push({ kind: 'circle', x, z, r: 0.8 })
  }

  const cribs: Array<{ x: number; z: number }> = []
  for (const [dx, dz] of [[7.5, -5.5], [-8.2, -4.0], [4.0, 9.0]] as Array<[number, number]>) {
    const x = brass.x + dx
    const z = brass.z + dz
    if (!isGreen(x, z, 2) || !insideRegion(brass, x, z, ROAM_INSET)) continue
    const yaw = rng() * 0.8
    for (let layer = 0; layer < 4; layer++) {
      for (let log = -1; log <= 1; log++) {
        batch.box(
          [3.4, 0.5, 0.5],
          [x + (layer % 2 ? 0 : log * 0.6), 0.3 + layer * 0.5, z + (layer % 2 ? log * 0.6 : 0)],
          log === 0 ? { color: '#4a3a2c', roughness: 0.95 } : TIMBER_DARK,
          { rotY: yaw + (layer % 2 ? Math.PI / 2 : 0) },
        )
      }
    }
    cribs.push({ x, z })
    obstacles.push({ kind: 'circle', x, z, r: 1.8 })
  }

  for (let i = 0; i < 7; i++) {
    const angle = (i / 7) * Math.PI * 2 + 0.2
    const x = brass.x + Math.cos(angle) * 13.5
    const z = brass.z + Math.sin(angle) * 13.5
    if (!isGreen(x, z, 1.5) || !insideRegion(brass, x, z, 1)) continue
    batch.box([0.2, 2.6, 0.2], [x, 1.3, z], { color: '#3a2d1e', roughness: 0.9 })
    batch.box([0.34, 0.16, 0.34], [x, 2.68, z], TIMBER_DARK)
    batch.box([0.42, 0.5, 0.42], [x, 2.4, z], BRASS_LAMP)
  }
  const brassLight = new THREE.PointLight('#c4893a', 2.4, 22)
  brassLight.position.set(brass.x - 3, 3.2, brass.z + 2)
  root.add(brassLight)

  /* --- signposts ------------------------------------------------------ */
  const signMeshes: THREE.Mesh[] = []
  const signpost = (x: number, z: number, faceYaw: number, lines: string[], accent: string) => {
    const cos = Math.cos(faceYaw)
    const sin = Math.sin(faceYaw)
    const local = (lx: number, ly: number, lz: number): [number, number, number] => [
      x + lx * cos + lz * sin,
      ly,
      z - lx * sin + lz * cos,
    ]
    for (const px of [-1.12, 1.12]) {
      batch.box([0.24, 3.2, 0.24], local(px, 1.6, -0.18), TIMBER, { rotY: faceYaw })
    }
    batch.box([2.7, 1.16, 0.12], local(0, 2.6, -0.1), TIMBER_DARK, { rotY: faceYaw })
    batch.box([0.8, 0.1, 0.1], local(1.5, 3.3, 0), TIMBER, { rotY: faceYaw })
    batch.box([0.3, 0.42, 0.3], local(1.86, 2.95, 0), LAMP, { rotY: faceYaw })
    // The lettering is a canvas board, which is the one thing here that cannot
    // be a cube: it is text, and it has to stay readable at a distance.
    const board = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.04, 0.1), woodSign(lines, accent))
    const [bx, by, bz] = local(0, 2.6, 0.02)
    board.position.set(bx, by, bz)
    board.rotation.y = faceYaw
    board.castShadow = true
    root.add(board)
    signMeshes.push(board)
    loose.push(board)
    obstacles.push({ kind: 'circle', x, z, r: 0.7 })
  }

  const trailYaw = Math.atan2(trailWaypoints[0][0] - 0, trailWaypoints[0][1] - 8)
  signpost(trailWaypoints[0][0], trailWaypoints[0][1], trailYaw + Math.PI, ['HUNTING', 'THIS WAY →'], '#d5a64b')
  signpost(trailWaypoints[2][0] + 2.4, trailWaypoints[2][1] + 2.4, trailYaw + Math.PI, ['WILDWOOD', '40 PACES'], '#9ca66d')
  const brassYaw = Math.atan2(brassTrailWaypoints[0][0] - 0, brassTrailWaypoints[0][1] - 8)
  signpost(brassTrailWaypoints[0][0], brassTrailWaypoints[0][1], brassYaw + Math.PI, ['BRASSWOOD', 'HIGH GAME →'], '#c4893a')
  signpost(brassTrailWaypoints[3][0] + 2.2, brassTrailWaypoints[3][1] + 1.6, brassYaw + Math.PI, ['BRASSWOOD', 'KEEP EAST'], '#c4893a')
  signpost(
    campX - 4.0,
    campZ + 3.8,
    Math.atan2(campX - huntingArea.x, campZ - huntingArea.z),
    ['THE WILDWOOD', 'BEARS · KEEP CLEAR'],
    '#e35e35',
  )
  signpost(huntingArea.x + 3, huntingArea.z + 17.5, 0, ['THE CLEARING', 'OPEN GROUND'], '#9ca66d')
  signpost(brass.x - 2.2, brass.z + 15.5, Math.PI, ['THE BRASSWOOD', 'WOLVES · BOARS'], '#c4893a')
  signpost(brass.x + 6.0, brass.z + 8.5, -0.4, ['DRY HOLLOW', 'HIGH GAME'], '#d5a64b')

  /* --- everything above becomes about a dozen meshes ------------------ */
  const welded = batch.build(root)
  const trees = createTreeField(placements)
  root.add(trees.group)

  root.userData.flicker = {
    fire,
    fireLight,
    lampMaterials: welded.meshes
      .map(mesh => mesh.material as THREE.MeshStandardMaterial)
      .filter(material => material.emissiveIntensity > 1),
  }

  /**
   * What the navigation grid in src/battle/nav.ts should treat as solid out
   * here. Published rather than re-derived: the scatter above consumes one
   * shared RNG in sequence, so any second pass would produce a different wood.
   * Only trunks, boulders, monoliths and stacked timber block — grass, trail
   * planks and the pond surface stay walkable on purpose.
   */
  root.userData.obstacles = obstacles

  /* --- what the camera must not sit inside ---------------------------- *
   * The trunk corridor keeps the player and the low end of the orbit out of the
   * leaves, but a camera pulled back and tilted up climbs to twenty metres and
   * there is no way to keep a wood out of that band — it is a wood. So the
   * camera asks instead, and moves.
   *
   * Bucketed on a 24m grid, because this is called a handful of times a frame
   * and the answer must not get slower as the world gains trees.
   * ------------------------------------------------------------------- */
  const CROWN_BUCKET = 24
  const bucketKey = (bx: number, bz: number) => bx * 1024 + bz
  const buckets = new Map<number, Crown[]>()
  for (const crown of crowns) {
    const x0 = Math.floor((crown.x - crown.reach) / CROWN_BUCKET)
    const x1 = Math.floor((crown.x + crown.reach) / CROWN_BUCKET)
    const z0 = Math.floor((crown.z - crown.reach) / CROWN_BUCKET)
    const z1 = Math.floor((crown.z + crown.reach) / CROWN_BUCKET)
    for (let bx = x0; bx <= x1; bx++) {
      for (let bz = z0; bz <= z1; bz++) {
        const key = bucketKey(bx, bz)
        let list = buckets.get(key)
        if (!list) buckets.set(key, (list = []))
        list.push(crown)
      }
    }
  }

  /**
   * Is this point inside the wood of a tree — leaf or bole?
   *
   * Exact against the drawn voxels rather than against a bounding cylinder. An
   * elder oak's bounding cylinder is twenty metres across and almost all air;
   * refusing the camera that whole volume would shove the lens across a clearing
   * to escape a tree it was standing comfortably under.
   */
  const inWood = (x: number, y: number, z: number) => {
    if (y < 0) return false
    const list = buckets.get(bucketKey(Math.floor(x / CROWN_BUCKET), Math.floor(z / CROWN_BUCKET)))
    if (!list) return false
    for (const crown of list) {
      if (y > crown.top) continue
      const distance = Math.hypot(x - crown.x, z - crown.z) / crown.squash
      if (distance > crown.reach) continue
      const metrics = treeMetrics(crown.id)
      if (distance < metrics.solidRadiusBelow(y / crown.scale) * crown.scale) return true
      if (y >= crown.base && inFoliage(crown.id, crown.scale, distance, y)) return true
    }
    return false
  }

  /**
   * Slide `eye` along the line toward `anchor` until it is out of the leaves,
   * and leave it where it first comes clear. `anchor` is the point the camera is
   * looking at, which sits inside a trunk corridor by construction, so this
   * always terminates somewhere sensible.
   */
  const clearOfWood = (eye: THREE.Vector3, anchor: THREE.Vector3) => {
    const dx = anchor.x - eye.x
    const dy = anchor.y - eye.y
    const dz = anchor.z - eye.z
    const span = Math.hypot(dx, dy, dz)
    if (span < 1e-4) return eye
    /* Stepped in metres rather than in fractions of the boom. A fixed fraction
     * sampled a 35m boom every 1.75m, which walks straight past the gaps between
     * trunks that the camera wants to sit in and collapses the whole boom onto
     * the player's head instead. */
    const steps = Math.max(8, Math.min(96, Math.round(span / 0.45)))
    /* A lens whose centre is clear but whose near plane is buried still fills the
     * screen with leaf, so the point a little further along has to be clear too. */
    const lead = Math.min(0.7 / span, 0.4)
    for (let step = 0; step <= steps; step++) {
      const t = step / steps
      const x = eye.x + dx * t
      const y = eye.y + dy * t
      const z = eye.z + dz * t
      if (inWood(x, y, z)) continue
      const ahead = Math.min(1, t + lead)
      if (inWood(eye.x + dx * ahead, eye.y + dy * ahead, eye.z + dz * ahead)) continue
      return eye.set(x, y, z)
    }
    return eye.copy(anchor)
  }

  /* ------------------------------------------------------------------- *
   * The spring arm.
   *
   * `clearOfWood` above only ever slides the lens ALONG the boom, which is one
   * axis of the three it could use: in a wood that drags the camera onto the
   * player's back (measured: 13.7% of vantage points, median 38% shorter, worst
   * 96%, and 2.1m of boom standing beside a titan pine). A boom that short is
   * not a camera, it is the inside of a head.
   *
   * So the arm searches the whole neighbourhood of the requested pose instead —
   * elevation up (over the crowns), elevation down (into the leaf-free trunk
   * corridor every tree keeps), yaw either way (round a bole) and only then
   * length — and picks the cheapest clear pose under a fixed price list:
   *
   *   lifting  0.85 / rad     ducking  1.00 / rad
   *   sliding  1.15 / rad     SHORTENING 7.00 per unit of boom lost
   *
   * Shortening is priced an order of magnitude above the angles on purpose, so
   * it is what happens when nothing else works rather than what happens first.
   * Below `BOOM_FLOOR` it cannot happen at all.
   * ------------------------------------------------------------------- */

  /** Never below the street, and never inside the wayfinder's own hat. */
  const EYE_FLOOR = 1.4
  /**
   * The boom may never be shortened below this, whatever the wood does.
   *
   * The 2.1m collapse is impossible by construction rather than by luck because
   * of this line. A request SHORTER than the floor is honoured as-is — minimum
   * zoom asks for 3.8m and that is a framing, not a failure — it simply cannot
   * then be shortened at all, and has to escape sideways.
   */
  const BOOM_FLOOR = 6.5
  const LIFT_COST = 0.85
  const DUCK_COST = 1
  /**
   * A surcharge on the square of the duck, so a small one stays cheap.
   *
   * Dipping the lens under the edge of a crown is the best move the arm has:
   * every tree keeps a leaf-free corridor, so a duck of a few degrees very
   * often finds clear air at full boom. Diving from a 21m overhead request all
   * the way to the corridor is the same move taken too far — it is a 16m
   * reframe, and when the wood closes over that position the lens has to cut
   * back up through the crowns. Measured: two such cuts in a 22s walk with this
   * term at 0, none with it at 1.6.
   */
  const DIVE_COST = 1.6
  const SLIDE_COST = 1.15
  const SHORTEN_COST = 7
  /**
   * Price of the player being hidden behind wood, per unit of the boom that is
   * inside a tree. Only ever paid when the requested pose is already blocked:
   * a clear request is returned untouched, so nothing in the open moves.
   *
   * Without it the arm happily ducks a 35m boom to eye level in a wood, which
   * is clear of leaves and a view of eleven trunks.
   */
  const OCCLUDE_COST = 3
  /**
   * How much wood may stand between the lens and the wayfinder before the arm
   * treats a pose as needing work, even though the lens itself is in clear air.
   *
   * Without this the arm only ever answers "is the lens inside a tree", and
   * beside a titan pine the honest answer is yes, the lens is fine — it is
   * three metres off the bark of a two-metre bole, looking at a wall of it.
   * Measured off a plate: 60% of the frame was trunk. A quarter of the boom is
   * about where a trunk stops being scenery and starts being the view.
   */
  const OCCLUDE_TOLERANCE = 0.25
  /**
   * A surcharge on ending up steep, whatever the lift that got there cost.
   *
   * The price list above is scale-free on purpose, but one thing about a lift is
   * not: the same 0.9rad on a 35m boom is a climb over the treetops, and at
   * minimum zoom — where the orbit already sits at 0.55rad — it is the camera
   * ending up directly over the wayfinder's hat looking down at it. Measured off
   * a plate beside a titan pine: the arm preferred straight up to sliding round
   * the bole, and straight up at 5m of boom is not a camera angle.
   *
   * Fades out entirely as the boom grows, because at 35m a steep lens is not a
   * surprise — it is the framing the game's own maximum zoom asks for, and the
   * long boom's answer to a wood should stay the climb over the crowns. Applied
   * at full strength everywhere it pushed the long booms into deep dives
   * instead: the worst single-frame cut on a max-zoom walk went from 1.9m to
   * 12m, and the lens spent the walk at head height looking through trunks.
   */
  const STEEP_FROM = 1
  const STEEP_COST = 4
  const STEEP_NEAR = 5
  const STEEP_FAR = 15
  /**
   * Price of MOVING the lens away from the pose the arm chose last frame.
   *
   * Priced in the same units as everything above — fractions of the requested
   * boom, which is what makes the list scale-free — so on a 24m boom this is
   * about 1.4 per boom-length of travel.
   *
   * This is the hysteresis, and it is not a nicety. Ducking into the corridor
   * and lifting over the crowns are both cheap, and at a long boom they are
   * thirty metres apart: without a price on the trip between them the search
   * swaps one for the other as the player walks and the lens teleports. With
   * it, whichever was chosen first is kept until it stops being clear.
   */
  const MOVE_COST = 1.4
  /**
   * How fast the hysteresis lets go when the player changes the framing.
   *
   * The price of travel is there to stop the arm re-deciding because the WORLD
   * moved — the wayfinder took a step and the pose the lens is in stopped being
   * clear. It is not there to stop it re-deciding when the PLAYER moves: a zoom
   * from 5m of boom to 35m is a different question, and the answer that was
   * right at 5m (duck into the corridor) is wrong at 35m (climb over the
   * crowns). Without this the arm held the duck all the way out and the live
   * max-zoom plate came out as a wall of trunks at head height with the
   * wayfinder invisible behind them, while the same vantage point solved from
   * cold chose a clean overhead.
   *
   * So: the more the request changed since last frame, the cheaper it is to
   * move. Walking does not change the request at all, so walking keeps the
   * whole of the hysteresis.
   */
  const CHURN_RELEASE = 8

  type ArmCandidate = { lift: number; slide: number; keep: number; cost: number }
  const LIFTS = [0, 0.12, 0.26, 0.42, 0.6, 0.8, 1.02]
  const DUCKS = [-0.16, -0.34, -0.56, -0.82, -1.1]
  const SLIDES = [0, 0.14, -0.14, 0.3, -0.3, 0.5, -0.5, 0.74, -0.74, 1, -1]
  const KEEPS = [1, 0.86, 0.72, 0.58, 0.44, 0.3]
  /**
   * Every pose the arm will consider, cheapest first, built once.
   *
   * Sorted so the search can stop at the first clear pose whose price is below
   * the next candidate's: occlusion and the cost of travel are both
   * non-negative, so nothing further down the list can beat what is in hand.
   * That bound is what keeps this cheap — 6.5 poses tested per solve over the
   * whole world — so the list is kept whole rather than truncated. Truncating
   * it to the cheapest 220 sorted the deepest ducks off the end and sent 142
   * vantage points to the last-resort climb instead.
   */
  /** What a pose costs, in fractions of the requested boom. */
  const armCost = (lift: number, slide: number, keep: number) =>
    (lift > 0 ? lift * LIFT_COST : -lift * DUCK_COST + lift * lift * DIVE_COST) +
    Math.abs(slide) * SLIDE_COST +
    Math.max(0, 1 - keep) * SHORTEN_COST
  const armCandidates: ArmCandidate[] = []
  for (const keep of KEEPS) {
    for (const slide of SLIDES) {
      for (const lift of [...LIFTS, ...DUCKS]) {
        armCandidates.push({ lift, slide, keep, cost: armCost(lift, slide, keep) })
      }
    }
  }
  armCandidates.sort((a, b) => a.cost - b.cost)

  /** How high the leaves reach over this ground, 0 where there is no tree. */
  const canopyTopAt = (x: number, z: number) => {
    const list = buckets.get(bucketKey(Math.floor(x / CROWN_BUCKET), Math.floor(z / CROWN_BUCKET)))
    let top = 0
    if (!list) return top
    for (const crown of list) {
      if (Math.hypot(x - crown.x, z - crown.z) / crown.squash > crown.reach) continue
      if (crown.top > top) top = crown.top
    }
    return top
  }

  /**
   * Radius of the ball around the lens that has to be clear, not just the point.
   *
   * A point test accepts poses that are clear by a centimetre, and it is what a
   * spring arm is not: the lens has a near plane and the player has a stride.
   */
  const LENS_BALL = 0.45
  /**
   * And the ball the arm would LIKE to have, priced rather than required.
   *
   * This is the second half of the anti-flicker story, and it is about time
   * rather than space: a pose clear by 5cm is enclosed by the wood one stride
   * later, and then the lens has to cut to wherever is clear now. Preferring
   * poses with a metre of air around them buys about a third of a second of
   * walking before the same decision has to be taken again.
   */
  const ROOM_BALL = 1.3
  const TIGHT_COST = 0.55

  /**
   * Is a lens here clear? The ball around it, and a point 0.7m along the line of
   * sight, because a lens whose centre is clear but whose near plane is buried
   * still fills the screen with leaf.
   */
  const lensClear = (x: number, y: number, z: number, ax: number, ay: number, az: number) => {
    if (y < EYE_FLOOR) return false
    if (inWood(x, y, z)) return false
    if (inWood(x + LENS_BALL, y, z) || inWood(x - LENS_BALL, y, z)) return false
    if (inWood(x, y, z + LENS_BALL) || inWood(x, y, z - LENS_BALL)) return false
    if (inWood(x, y + LENS_BALL, z) || inWood(x, y - LENS_BALL, z)) return false
    const dx = ax - x
    const dy = ay - y
    const dz = az - z
    const span = Math.hypot(dx, dy, dz)
    if (span < 1e-4) return true
    const lead = Math.min(0.7 / span, 0.4)
    return !inWood(x + dx * lead, y + dy * lead, z + dz * lead)
  }

  /** Is there room to spare around the lens, or is it wedged in a gap? */
  const lensRoomy = (x: number, y: number, z: number) =>
    !inWood(x + ROOM_BALL, y, z) && !inWood(x - ROOM_BALL, y, z) &&
    !inWood(x, y, z + ROOM_BALL) && !inWood(x, y, z - ROOM_BALL) &&
    !inWood(x, y + ROOM_BALL, z) && !inWood(x, y - ROOM_BALL, z)

  /**
   * Fraction of the line from lens to aim point that is inside wood.
   *
   * Sampled every 1.2m rather than a fixed number of times along the line. A
   * fixed count is a trap here: eight samples on a 32m boom is one every four
   * metres, which walks straight past the metre-wide boles it is looking for, so
   * a lens ducked to head height 32m away through a wood measured as 13%
   * occluded when the plate was most of the wayfinder behind trunks. The arm
   * then thought ducking was cheap.
   */
  const OCCLUDE_STEP = 1.2
  const occlusionOf = (x: number, y: number, z: number, ax: number, ay: number, az: number) => {
    const span = Math.hypot(ax - x, ay - y, az - z)
    const samples = Math.max(6, Math.min(28, Math.round(span / OCCLUDE_STEP)))
    let hits = 0
    for (let i = 1; i <= samples; i++) {
      const t = i / (samples + 1)
      if (inWood(x + (ax - x) * t, y + (ay - y) * t, z + (az - z) * t)) hits += 1
    }
    return hits / samples
  }

  /**
   * Where the arm wants the lens, and the scratch it is worked out in. Both are
   * reused rather than allocated: this runs twice a frame over a few hundred
   * candidate poses, and a Vector3 per candidate is 60,000 a second of garbage.
   */
  const armPlace = { x: 0, y: 0, z: 0, yaw: 0, elevation: 0, boom: 0 }
  const armResult = { yaw: 0, elevation: 0, boom: 0, mode: 'clear' as ArmMode, cost: 0 }
  /** Cheap instrumentation, read by scripts/verify-springarm.ts. */
  const armCounters = { calls: 0, candidates: 0, over: 0 }

  /**
   * Solve the arm: the cheapest clear pose near the requested one.
   *
   * `prev` is last frame's answer, which is tried first and priced at a
   * discount. That is the whole of the anti-flicker story on the search side —
   * two poses of near-equal price stop trading places frame to frame — and the
   * slew limiter in `springArm` is the other half.
   */
  const solveArm = (
    ax: number,
    ay: number,
    az: number,
    yaw: number,
    elevation: number,
    boom: number,
    prev?: { lift: number; slide: number; keep: number },
    stick = 1,
  ) => {
    armCounters.calls += 1
    const floor = Math.min(boom, BOOM_FLOOR)
    const at = (lift: number, slide: number, length: number) => {
      const el = THREE.MathUtils.clamp(elevation + lift, -1, 1.45)
      const flat = Math.cos(el) * length
      armPlace.yaw = yaw + slide
      armPlace.elevation = el
      armPlace.boom = length
      armPlace.x = ax + Math.sin(armPlace.yaw) * flat
      armPlace.y = ay + Math.sin(el) * length
      armPlace.z = az + Math.cos(armPlace.yaw) * flat
      return armPlace
    }
    /* The overwhelmingly common case, and it must stay cheap: a clear request
     * with a clear view down it is returned exactly as asked, so open ground
     * never moves. */
    armCounters.candidates += 1
    let pose = at(0, 0, boom)
    if (lensClear(pose.x, pose.y, pose.z, ax, ay, az)) {
      if (occlusionOf(pose.x, pose.y, pose.z, ax, ay, az) <= OCCLUDE_TOLERANCE) {
        armResult.yaw = yaw
        armResult.elevation = elevation
        armResult.boom = boom
        armResult.mode = 'clear'
        armResult.cost = 0
        return armResult
      }
    }
    /** What it costs to get from last frame's pose to this one. Zero with no
     * memory, which is what the sweep in the harness measures. */
    const moved = (lift: number, slide: number, keep: number) =>
      prev
        ? MOVE_COST * stick * (Math.abs(lift - prev.lift) + Math.abs(slide - prev.slide) + 2 * Math.abs(keep - prev.keep))
        : 0
    /** What ending up at this elevation costs on top of getting there. */
    const steepRate =
      STEEP_COST * THREE.MathUtils.clamp((STEEP_FAR - boom) / (STEEP_FAR - STEEP_NEAR), 0, 1)
    const steep = (lift: number) => {
      const el = THREE.MathUtils.clamp(elevation + lift, -1, 1.45)
      return el > STEEP_FROM ? (el - STEEP_FROM) * steepRate : 0
    }
    let best: ArmCandidate | null = null
    let bestCost = Infinity
    const bestPose = { yaw: 0, elevation: 0, boom: 0 }
    if (prev && (prev.lift !== 0 || prev.slide !== 0 || prev.keep !== 1)) {
      armCounters.candidates += 1
      pose = at(prev.lift, prev.slide, Math.max(floor, boom * prev.keep))
      if (lensClear(pose.x, pose.y, pose.z, ax, ay, az)) {
        const raw = armCost(prev.lift, prev.slide, prev.keep) + steep(prev.lift)
        bestCost =
          raw +
          OCCLUDE_COST * occlusionOf(pose.x, pose.y, pose.z, ax, ay, az) +
          (lensRoomy(pose.x, pose.y, pose.z) ? 0 : TIGHT_COST)
        best = { ...prev, cost: raw }
        bestPose.yaw = pose.yaw
        bestPose.elevation = pose.elevation
        bestPose.boom = pose.boom
      }
    }
    let lastLength = -1
    for (const candidate of armCandidates) {
      /* Admissible: occlusion and the cost of moving are both non-negative, so
       * nothing further down a list sorted by the pose's own price can beat
       * what is already in hand. */
      if (candidate.cost >= bestCost) break
      const length = Math.max(floor, boom * candidate.keep)
      // Below the floor every `keep` lands on the same length; test it once.
      if (candidate.slide === 0 && candidate.lift === 0 && length === lastLength) continue
      lastLength = length
      const total = candidate.cost + moved(candidate.lift, candidate.slide, candidate.keep) + steep(candidate.lift)
      if (total >= bestCost) continue
      armCounters.candidates += 1
      pose = at(candidate.lift, candidate.slide, length)
      if (!lensClear(pose.x, pose.y, pose.z, ax, ay, az)) continue
      const priced =
        total +
        OCCLUDE_COST * occlusionOf(pose.x, pose.y, pose.z, ax, ay, az) +
        (lensRoomy(pose.x, pose.y, pose.z) ? 0 : TIGHT_COST)
      if (priced >= bestCost) continue
      bestCost = priced
      best = candidate
      bestPose.yaw = pose.yaw
      bestPose.elevation = pose.elevation
      bestPose.boom = pose.boom
    }
    if (best) {
      armResult.yaw = bestPose.yaw
      armResult.elevation = bestPose.elevation
      armResult.boom = bestPose.boom
      armResult.mode =
        best.keep === 1 && best.lift === 0 && best.slide === 0
          ? 'clear'
          : best.keep < 1
            ? 'short'
            : best.lift > 0
              ? 'lift'
              : best.lift < 0
                ? 'duck'
                : 'slide'
      armResult.cost = best.cost
      return armResult
    }
    /* Nothing in 220 poses was clear. Straight up over the crowns is clear by
     * construction — `inWood` is false above every crown's top — so the hard
     * guarantee never rests on the search finding something. If this fires in
     * play the price list is wrong; the harness counts it for that reason. */
    armCounters.over += 1
    armResult.yaw = yaw
    armResult.elevation = Math.PI / 2
    armResult.boom = Math.max(floor, canopyTopAt(ax, az) + 1.2 - ay)
    armResult.mode = 'over'
    armResult.cost = Infinity
    return armResult
  }

  /* ---- the damper ----
   *
   * A lens that pops over the treetops every few steps is worse than a short
   * boom, so the arm's answer is slewed rather than applied. Two rules:
   *
   *   - a solved pose is reached at 2.6 rad/s, not instantly, and any eased
   *     position is re-tested: if the ease passes through leaf the solved pose
   *     is taken whole that frame. So the guarantee is never traded for smooth.
   *   - coming BACK is the flickery direction, so it waits RELEASE_S after the
   *     request first comes clear and then unwinds at 1.1 rad/s. Walking a wood
   *     edge cannot therefore lift and drop the lens once a step.
   */
  const RELEASE_S = 0.35
  const GRAB_RATE = 2.6
  const RELAX_RATE = 1.1
  /**
   * Metres a second the lens may travel, which at a given boom is a limit on
   * radians a second — the same angular rate is a stroll at 4m of boom and a
   * lurch at 35m, so the cap has to be expressed where the player sees it.
   */
  const TRAVEL_CAP = 7
  const RETURN_CAP = 4.5
  /** `live` is where the lens is being eased to; `chosen` is the last solve. */
  const live = { lift: 0, slide: 0, keep: 1 }
  const chosen = { lift: 0, slide: 0, keep: 1 }
  /** Last frame's request, to tell a zoom or a drag from a walk. */
  const asked = { yaw: 0, elevation: 0, boom: 0, seen: false }
  let clearFor = 0
  const slew = (from: number, to: number, rate: number, cap: number, dt: number) => {
    const eased = from + (to - from) * (1 - Math.exp(-dt * rate))
    const limit = cap * dt
    return THREE.MathUtils.clamp(eased, from - limit, from + limit)
  }
  const resetArm = () => {
    live.lift = 0
    live.slide = 0
    live.keep = 1
    chosen.lift = 0
    chosen.slide = 0
    chosen.keep = 1
    asked.seen = false
    clearFor = 0
    armCounters.calls = 0
    armCounters.candidates = 0
    armCounters.over = 0
  }

  /**
   * Move `eye` to a clear vantage point near the one it is asking for, damped
   * across frames. Same contract as `clearOfWood` — it writes `eye` and returns
   * it — so the camera rig in `src/main.tsx` reads the same.
   */
  const springArm = (eye: THREE.Vector3, anchor: THREE.Vector3, dt: number) => {
    const dx = eye.x - anchor.x
    const dy = eye.y - anchor.y
    const dz = eye.z - anchor.z
    const boom = Math.hypot(dx, dy, dz)
    if (boom < 1e-4) return eye
    const yaw = Math.atan2(dx, dz)
    const elevation = Math.asin(THREE.MathUtils.clamp(dy / boom, -1, 1))
    /* The pose that is priced at a discount is the last one SOLVED, not the
     * eased one the lens is currently at: mid-ease the lens is between two
     * poses and may be in leaf, which would fail the test and let the search
     * re-decide from scratch every frame — the flicker this is here to stop. */
    const held = chosen.lift !== 0 || chosen.slide !== 0 || chosen.keep !== 1
    /* How much of the change since last frame is the player's doing. Yaw is
     * compared the long way round so the ±pi seam is not a drag. */
    const churn = asked.seen
      ? Math.abs(boom - asked.boom) / Math.max(boom, 1) +
        Math.abs(elevation - asked.elevation) +
        Math.abs(Math.atan2(Math.sin(yaw - asked.yaw), Math.cos(yaw - asked.yaw)))
      : 1
    asked.yaw = yaw
    asked.elevation = elevation
    asked.boom = boom
    asked.seen = true
    const arm = solveArm(
      anchor.x, anchor.y, anchor.z, yaw, elevation, boom,
      held ? chosen : undefined,
      THREE.MathUtils.clamp(1 - churn * CHURN_RELEASE, 0, 1),
    )
    const want = {
      lift: arm.elevation - elevation,
      slide: arm.yaw - yaw,
      keep: arm.boom / boom,
    }
    if (arm.mode !== 'clear') {
      chosen.lift = want.lift
      chosen.slide = want.slide
      chosen.keep = want.keep
    }
    if (arm.mode === 'clear') {
      clearFor += dt
      // Hold what we have while the dwell runs, then unwind it slowly.
      if (clearFor < RELEASE_S && held) {
        want.lift = chosen.lift
        want.slide = chosen.slide
        want.keep = chosen.keep
      }
      live.lift = slew(live.lift, want.lift, RELAX_RATE, RETURN_CAP / boom, dt)
      live.slide = slew(live.slide, want.slide, RELAX_RATE, RETURN_CAP / boom, dt)
      live.keep = slew(live.keep, want.keep, RELAX_RATE, RETURN_CAP / boom, dt)
      // Fully unwound: forget the held pose so it cannot be revived later.
      if (Math.abs(live.lift) < 1e-3 && Math.abs(live.slide) < 1e-3 && Math.abs(live.keep - 1) < 1e-3) {
        chosen.lift = 0
        chosen.slide = 0
        chosen.keep = 1
      }
    }
    else {
      clearFor = 0
      live.lift = slew(live.lift, want.lift, GRAB_RATE, TRAVEL_CAP / boom, dt)
      live.slide = slew(live.slide, want.slide, GRAB_RATE, TRAVEL_CAP / boom, dt)
      live.keep = slew(live.keep, want.keep, GRAB_RATE, TRAVEL_CAP / boom, dt)
    }
    /* The eased pose, and if the ease is passing through wood, the smallest
     * step from it towards the solved pose that comes clear. The last step is
     * the solved pose exactly, which the search has already proved clear, so
     * this always terminates and the guarantee is never traded for smoothness.
     * Stepping rather than snapping matters: a snap moves the lens up to twelve
     * metres in a frame, and the render loop's lerp then trails it through the
     * crown it was escaping. */
    /* Fine on purpose. At eight steps the smallest clear step off a blocked
     * ease was an eleven-metre move on a 24m boom, which the render loop's lerp
     * then trailed through the crown; at twenty-four it is a third of that, and
     * the extra tests are only paid on the frames where the ease is blocked. */
    const SETTLE_STEPS = 24
    for (let step = 0; step <= SETTLE_STEPS; step++) {
      const u = step / SETTLE_STEPS
      const lift = live.lift + (want.lift - live.lift) * u
      const slide = live.slide + (want.slide - live.slide) * u
      const keep = live.keep + (want.keep - live.keep) * u
      const el = THREE.MathUtils.clamp(elevation + lift, -1, 1.45)
      const length = Math.max(Math.min(boom, BOOM_FLOOR), boom * keep)
      const flat = Math.cos(el) * length
      const x = anchor.x + Math.sin(yaw + slide) * flat
      const y = anchor.y + Math.sin(el) * length
      const z = anchor.z + Math.cos(yaw + slide) * flat
      if (step < SETTLE_STEPS && !lensClear(x, y, z, anchor.x, anchor.y, anchor.z)) continue
      live.lift = lift
      live.slide = slide
      live.keep = keep
      return eye.set(x, y, z)
    }
    return eye
  }

  /**
   * Unit directions the lens may be nudged in to get out of a leaf, as a flat
   * x,y,z triple list: straight up first, then down, then eight compass
   * bearings, then the eight raised and the eight lowered ones.
   */
  const SETTLE_DIRS: number[] = [0, 1, 0, 0, -1, 0]
  for (const rise of [0, 0.7, -0.7]) {
    for (let step = 0; step < 8; step++) {
      const bearing = (step / 8) * Math.PI * 2
      const length = Math.hypot(1, rise)
      SETTLE_DIRS.push(Math.sin(bearing) / length, rise / length, Math.cos(bearing) / length)
    }
  }

  /**
   * The lens where it ACTUALLY ended up, after the render loop's own lerp.
   *
   * The lerp eases from wherever the camera was toward `goal`, which the arm has
   * already cleared, and that straight line can still clip a crown on the way.
   * So this walks the remainder of that same line — towards a point known to be
   * clear — and stops at the first clear metre.
   *
   * It deliberately does NOT re-run the search. A free solve here moves the lens
   * to the cheapest pose near where the lerp happened to be, which is a
   * different pose every frame: measured over a walk into the wildwood that was
   * 678m/s of vertical lens speed against 12m/s for this. Resolving along the
   * direction the camera is already travelling can only ever shorten the ease.
   */
  const settle = (eye: THREE.Vector3, goal: THREE.Vector3, anchor: THREE.Vector3) => {
    if (lensClear(eye.x, eye.y, eye.z, anchor.x, anchor.y, anchor.z)) return eye
    const dx = goal.x - eye.x
    const dy = goal.y - eye.y
    const dz = goal.z - eye.z
    const span = Math.hypot(dx, dy, dz)
    if (span < 1e-4) return eye.copy(goal)
    /* How far along the ease the lens has to go to come clear. This always
     * finds something — the goal itself is clear — but it can be several
     * metres, and several metres in one frame is a cut. */
    let reach = span
    const steps = Math.max(4, Math.min(48, Math.round(span / 0.3)))
    for (let step = 1; step <= steps; step++) {
      const t = step / steps
      if (!lensClear(eye.x + dx * t, eye.y + dy * t, eye.z + dz * t, anchor.x, anchor.y, anchor.z)) continue
      reach = span * t
      break
    }
    /* So look for somewhere nearer first, straight out of the leaf in any
     * direction. Sliding 40cm sideways off a crown as the player walks past it
     * is not a cut; finishing a four-metre ease in one frame is. */
    /* A nudge must not do what the whole exercise is about stopping: the lens
     * may leave the leaf in any direction except towards the wayfinder's head,
     * and never past the boom floor. */
    const keepOut = Math.min(BOOM_FLOOR, span + eye.distanceTo(anchor), eye.distanceTo(anchor))
    for (const radius of [0.4, 0.8, 1.3, 2, 3]) {
      if (radius >= reach) break
      for (let ring = 0; ring < SETTLE_DIRS.length; ring += 3) {
        const x = eye.x + SETTLE_DIRS[ring] * radius
        const y = eye.y + SETTLE_DIRS[ring + 1] * radius
        const z = eye.z + SETTLE_DIRS[ring + 2] * radius
        if (Math.hypot(x - anchor.x, y - anchor.y, z - anchor.z) < keepOut) continue
        if (lensClear(x, y, z, anchor.x, anchor.y, anchor.z)) return eye.set(x, y, z)
      }
    }
    const t = reach / span
    return eye.set(eye.x + dx * t, eye.y + dy * t, eye.z + dz * t)
  }

  root.userData.canopy = {
    corridor: TRUNK_CORRIDOR,
    crowns,
    inWood,
    clearOfWood,
    canopyTopAt,
    springArm,
    settle,
    solveArm,
    resetArm,
    armCounters,
    boomFloor: BOOM_FLOOR,
  }

  root.userData.stats = {
    propMeshes: welded.meshes.length,
    propBoxes: welded.boxes,
    propTriangles: welded.triangles,
    signBoards: signMeshes.length,
    groundPatches: wildRegions.length,
    pointLights: 2,
    trees: trees.stats,
    /** Trees planted outside every region: what "a bit of everywhere" cost. */
    country,
    corridor: TRUNK_CORRIDOR,
    obstacles: obstacles.length,
    regionArea: [...areas.entries()].map(([id, area]) => ({ id, area })),
  }
  /**
   * Hand back everything this function allocated: the instanced forest, the
   * welded props, and the handful of meshes that own their own geometry. Used
   * to free only the trees, which left the props, the seven ground patches, the
   * water and eight canvas-textured sign boards resident.
   */
  root.userData.dispose = () => {
    trees.dispose()
    welded.dispose()
    for (const mesh of loose) {
      mesh.geometry.dispose()
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        disposeMaterial(material)
      }
    }
  }
  return root
}

function woodSign(lines: string[], accent: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#26190f'
  ctx.fillRect(0, 0, 320, 128)
  ctx.fillStyle = '#3c2a19'
  ctx.fillRect(6, 6, 308, 116)
  ctx.strokeStyle = accent
  ctx.lineWidth = 4
  ctx.strokeRect(12, 12, 296, 104)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  lines.forEach((line, index) => {
    const centre = 64 + (index - (lines.length - 1) / 2) * 34
    ctx.font = index === 0 ? '700 30px monospace' : '500 21px monospace'
    ctx.fillStyle = index === 0 ? '#f0dcb0' : accent
    ctx.fillText(line, 160, centre)
  })
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.75, emissive: '#2a1d10', emissiveIntensity: 0.55 })
}

/** Cheap life for the camp fire and the lamps. */
export function animateWildscape(wildscape: THREE.Object3D, time: number) {
  const flicker = wildscape.userData.flicker as
    | { fire: THREE.Mesh; fireLight: THREE.PointLight; lampMaterials: THREE.MeshStandardMaterial[] }
    | undefined
  if (!flicker) return
  const pulse = 0.82 + Math.sin(time * 0.009) * 0.1 + Math.sin(time * 0.021) * 0.06
  flicker.fire.scale.set(pulse, 0.9 + pulse * 0.24, pulse)
  flicker.fireLight.intensity = 2.6 + pulse * 0.9
  // Every lamp shares one material per tone now, so they breathe together
  // rather than each carrying its own phase. Nobody can see the difference,
  // and it costs one assignment instead of twenty.
  const lampPulse = 2.0 + Math.sin(time * 0.004) * 0.35
  flicker.lampMaterials.forEach(material => { material.emissiveIntensity = lampPulse })
}
