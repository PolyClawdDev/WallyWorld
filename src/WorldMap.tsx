import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ambientNpcs, buildingSpecs, districtAt, districts, huntingRegions, perimeterTrees, serviceNpcs, townLayout } from './townData'
import { SAFE_ZONE, speciesSpecs, trailWaypoints, wildRegions, wildlifeMarkers } from './wildlife'
import { playerPose } from './worldBridge'
import type { PlayerPose } from './worldBridge'

/* ------------------------------------------------------------------ *
 * Town map. Every shape is drawn from src/townData.ts, the same data
 * createTown() builds the district from, so the map is a projection of
 * the real world rather than a hand-drawn picture of it. World x maps to
 * map x and world z maps to map y, both in metres, so the SVG user unit
 * is one metre and nothing needs scaling by hand.
 * ------------------------------------------------------------------ */

const FIT = { x: -104, z: -104, size: 208 }
const NEAR = 84
const fitBox = `${FIT.x} ${FIT.z} ${FIT.size} ${FIT.size}`

/** Heading names read clockwise from +z, which is south in this town. */
const compass = ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW']
const headingOf = (facing: number) => compass[((Math.round(facing / (Math.PI / 4)) % 8) + 8) % 8]

/** Matches the 12-sided cylinders the plaza and fountain are built from. */
function polygon(cx: number, cz: number, radius: number, sides = 12) {
  return Array.from({ length: sides }, (_, i) => {
    const angle = (i / sides) * Math.PI * 2 + Math.PI / sides
    return `${(cx + Math.cos(angle) * radius).toFixed(2)},${(cz + Math.sin(angle) * radius).toFixed(2)}`
  }).join(' ')
}

const metres = (value: number) => `${value >= 0 ? '' : '−'}${Math.abs(Math.round(value))}m`

function Swatch({ kind, color }: { kind: string; color: string }) {
  return <svg className="mp-swatch" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">
    {kind === 'building' && <>
      <rect x="1" y="1" width="10" height="10" fill="#4b4145" />
      <rect x="2" y="2" width="8" height="8" fill={color} />
      <rect x="5" y="0" width="2" height="2" fill="#d5a64b" />
    </>}
    {kind === 'service' && <polygon points="6,1 11,6 6,11 1,6" fill={color} stroke="#10141f" strokeWidth="1" />}
    {kind === 'resident' && <rect x="4" y="4" width="4" height="4" fill={color} />}
    {kind === 'player' && <polygon points="6,11 1,1 6,4 11,1" fill={color} stroke="#10141f" strokeWidth="0.8" />}
    {kind === 'water' && <><rect x="0" y="0" width="12" height="12" fill="#1b5660" /><rect x="0" y="4" width="12" height="1" fill="#4ca7ae" /><rect x="0" y="8" width="8" height="1" fill="#4ca7ae" /></>}
    {kind === 'bridge' && <><rect x="0" y="3" width="12" height="6" fill="#765b4a" /><rect x="3" y="3" width="1" height="6" fill="#a07752" /><rect x="7" y="3" width="1" height="6" fill="#a07752" /></>}
    {kind === 'street' && <><rect x="0" y="0" width="12" height="12" fill="#3a4645" /><rect x="4" y="0" width="4" height="12" fill={color} /></>}
    {kind === 'tree' && <><rect x="5" y="7" width="2" height="4" fill="#4d3d35" /><rect x="2" y="1" width="8" height="6" fill={color} /></>}
    {kind === 'plaza' && <polygon points={polygon(6, 6, 5)} fill={color} stroke="#7f8a83" strokeWidth="0.6" />}
    {kind === 'region' && <polygon points={polygon(6, 6, 5, 14)} fill={`${color}33`} stroke={color} strokeWidth="1" strokeDasharray="2 2" />}
    {kind === 'trail' && <><rect x="0" y="5" width="12" height="2" fill="#5b4834" /><rect x="1" y="5" width="3" height="2" fill={color} /><rect x="7" y="5" width="3" height="2" fill={color} /></>}
    {kind === 'animal' && <rect x="3" y="3" width="6" height="6" fill={color} stroke="#10141f" strokeWidth="1" />}
  </svg>
}

export function WorldMap() {
  const svg = useRef<SVGSVGElement>(null)
  const marker = useRef<SVGGElement>(null)
  const [pose, setPose] = useState<PlayerPose | null>(() => playerPose())
  const [animals, setAnimals] = useState(() => wildlifeMarkers())
  const [follow, setFollow] = useState(false)
  const followRef = useRef(follow)
  useEffect(() => { followRef.current = follow }, [follow])

  // The marker and viewBox are written straight to the DOM every frame so the
  // map tracks movement smoothly; React state only carries the slower readout.
  useEffect(() => {
    let raf = 0
    let lastRead = 0
    const tick = (now: number) => {
      const next = playerPose()
      if (next) {
        marker.current?.setAttribute('transform', `translate(${next.x.toFixed(2)} ${next.z.toFixed(2)}) rotate(${(-next.facing * 180 / Math.PI).toFixed(1)})`)
        if (followRef.current) svg.current?.setAttribute('viewBox', `${(next.x - NEAR / 2).toFixed(1)} ${(next.z - NEAR / 2).toFixed(1)} ${NEAR} ${NEAR}`)
        if (now - lastRead > 150) { lastRead = now; setPose(next); setAnimals(wildlifeMarkers()) }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  useEffect(() => { if (!follow) svg.current?.setAttribute('viewBox', fitBox) }, [follow])

  const trees = useMemo(() => perimeterTrees(), [])
  // District tags hang off the top-left of the ground each district actually covers.
  const grouped = useMemo(() => districts.map(district => {
    const members = buildingSpecs.filter(spec => districtAt(spec.x, spec.z).id === district.id)
    const edges = members.map(spec => ({ x: spec.x - spec.width / 2, z: spec.z - spec.depth / 2 }))
    return {
      district,
      members,
      x: Math.max(-98, Math.min(...edges.map(edge => edge.x))),
      z: Math.max(-96, Math.min(...edges.map(edge => edge.z)) - 4.5),
    }
  }), [])
  const here = pose ? districtAt(pose.x, pose.z) : null
  const { canal, plaza, fountain, marketStalls, noticeBoard } = townLayout

  return <>
    <header className="mp-head">
      <div>
        <div className="eyebrow">WALLY WORLD · DISTRICT 01</div>
        <h2>Old Town Loop.</h2>
      </div>
      <span className="mp-scale">{townLayout.ground}m × {townLayout.ground}m · one grid square is 8m · drawn live from the town layout</span>
    </header>
    <div className="mp">
    <div className="mp-stage">
      <svg ref={svg} viewBox={fitBox} shapeRendering="crispEdges" role="img" aria-label="Map of Wally World, drawn from the live town layout">
        <defs>
          <pattern id="mp-grid" width="8" height="8" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill="#26332f" />
            <rect width="8" height="1" fill="#2d3b36" />
            <rect width="1" height="8" fill="#2d3b36" />
          </pattern>
          <pattern id="mp-wild" width="6" height="6" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="#2b3a33" />
            <rect x="0" y="0" width="2" height="2" fill="#32463c" />
            <rect x="3" y="3" width="2" height="2" fill="#32463c" />
          </pattern>
        </defs>
        <rect x={FIT.x} y={FIT.z} width={FIT.size} height={FIT.size} fill="url(#mp-wild)" />
        <rect x={-townLayout.ground / 2} y={-townLayout.ground / 2} width={townLayout.ground} height={townLayout.ground} fill="url(#mp-grid)" />
        <rect x={-townLayout.bounds} y={-townLayout.bounds} width={townLayout.bounds * 2} height={townLayout.bounds * 2} fill="none" stroke="#d5a64b33" strokeWidth="1" strokeDasharray="6 4" />

        {/* hunting grounds and the lit trail, published by the wildlife module */}
        {huntingRegions.map(region => <polygon key={region.name} points={polygon(region.x, region.z, region.radius, 14)} fill={`${region.accent}1f`} stroke={region.accent} strokeWidth="0.9" strokeDasharray="5 3" />)}
        <polyline points={trailWaypoints.map(([x, z]) => `${x},${z}`).join(' ')} fill="none" stroke="#5b4834" strokeWidth="3" strokeLinejoin="round" />
        <polyline points={trailWaypoints.map(([x, z]) => `${x},${z}`).join(' ')} fill="none" stroke="#8a6c4a" strokeWidth="1.2" strokeLinejoin="round" strokeDasharray="4 3" />

        {/* streets, plaza, canal, bridges: the same numbers the world is built from */}
        {townLayout.streets.map((street, index) => <rect key={index} x={street.x - street.width / 2} y={street.z - street.depth / 2} width={street.width} height={street.depth} fill={street.color} />)}
        <polygon points={polygon(plaza.x, plaza.z, plaza.radius)} fill={plaza.color} stroke="#828d85" strokeWidth="0.8" />
        <rect x={canal.x - canal.bankWidth / 2} y={canal.z - canal.bankLength / 2} width={canal.bankWidth} height={canal.bankLength} fill={canal.bank} />
        <rect x={canal.x - canal.waterWidth / 2} y={canal.z - canal.waterLength / 2} width={canal.waterWidth} height={canal.waterLength} fill={canal.water} />
        {Array.from({ length: 30 }, (_, i) => <rect key={i} x={canal.x - canal.waterWidth / 2 + (i % 2 ? 0.8 : 2.6)} y={canal.z - canal.waterLength / 2 + 3 + i * 4} width="3.4" height="1" fill="#4ca7ae" opacity="0.5" />)}
        {townLayout.bridges.map(bridgeZ => <g key={bridgeZ}>
          <rect x={canal.x - 7.5} y={bridgeZ - 2.75} width="15" height="5.5" fill="#765b4a" stroke="#4b4037" strokeWidth="0.6" />
          {Array.from({ length: 7 }, (_, i) => <rect key={i} x={canal.x - 6.3 + i * 2} y={bridgeZ - 2.75} width="0.7" height="5.5" fill="#a07752" />)}
        </g>)}
        <polygon points={polygon(fountain.x, fountain.z, fountain.radius)} fill="#68777b" stroke="#8a9799" strokeWidth="0.5" />
        <polygon points={polygon(fountain.x, fountain.z, 3.5)} fill="#4ca7ae" />
        {Array.from({ length: marketStalls.count }, (_, i) => <rect key={i} x={marketStalls.x + i * marketStalls.step - 0.9} y={marketStalls.z - 0.35} width="1.8" height="0.7" fill="#896746" />)}
        <rect x={noticeBoard.x - 2.25} y={noticeBoard.z - 0.4} width="4.5" height="0.8" fill="#765b42" />

        {/* woodland ring */}
        {trees.map((tree, index) => <rect key={index} x={tree.x - 1.4} y={tree.z - 1.4} width="2.8" height="2.8" fill={tree.alt ? '#385847' : '#49624d'} />)}

        {/* the wildlife safe zone, so the map says where animals leave you alone */}
        <polygon points={polygon(SAFE_ZONE.x, SAFE_ZONE.z, SAFE_ZONE.r, 24)} fill="none" stroke="#7bc9ce4d" strokeWidth="0.9" strokeDasharray="4 4" />
        <text className="mp-label" x={SAFE_ZONE.x} y={SAFE_ZONE.z + SAFE_ZONE.r - 3} fill="#7bc9ce" textAnchor="middle">SAFE ZONE</text>

        {/* buildings, straight from the BuildingSpec list */}
        {buildingSpecs.map(spec => {
          const left = spec.x - spec.width / 2
          const top = spec.z - spec.depth / 2
          return <g key={spec.name}>
            <rect x={left} y={top} width={spec.width} height={spec.depth} fill={spec.roof} stroke="#10141f" strokeWidth="0.8" />
            <rect x={left + 1.4} y={top + 1.4} width={spec.width - 2.8} height={spec.depth - 2.8} fill={spec.wall} />
            {/* the entrance sits on the -z face, exactly as createBuilding places it */}
            <rect x={spec.x - 1.2} y={top - 0.8} width="2.4" height="1.9" fill={spec.accent ?? '#d5a64b'} />
            <text className="mp-label" x={spec.x} y={spec.z + spec.depth / 2 + 4.2} fill="#e5ddc8" textAnchor="middle">{spec.sign}</text>
          </g>
        })}

        {/* region names sit inside the top of their own circle */}
        {huntingRegions.map(region => <text key={`${region.name}-label`} className="mp-region" x={region.x} y={region.z - region.radius + 4} fill={region.accent} textAnchor="middle">{region.name}</text>)}

        {/* live animals, polled from the wildlife module */}
        {animals.filter(animal => animal.alive).map((animal, index) => <rect
          key={index}
          x={animal.x - 1.1}
          y={animal.z - 1.1}
          width="2.2"
          height="2.2"
          fill={speciesSpecs[animal.species].mapColor}
          stroke="#10141f"
          strokeWidth="0.5"
        />)}

        {/* residents */}
        {ambientNpcs.map((npc, index) => <rect key={index} x={npc.x - 1.3} y={npc.z - 1.3} width="2.6" height="2.6" fill="#849394" stroke="#10141f" strokeWidth="0.6" />)}

        {/* named service NPCs */}
        {serviceNpcs.map(npc => <g key={npc.name}>
          <polygon points={polygon(npc.x, npc.z, 2.9, 4)} fill={npc.color} stroke="#10141f" strokeWidth="0.9" />
          <rect x={npc.x - 0.6} y={npc.z - 0.6} width="1.2" height="1.2" fill="#10141f" />
          <text className="mp-npc" x={npc.x + 4} y={npc.z + 1.1} fill={npc.color}>{npc.name.split('·')[0].trim()}</text>
        </g>)}

        {/* district tags, keyed to the ground their own buildings occupy */}
        {grouped.map(group => <text key={group.district.id} className="mp-district" x={group.x} y={group.z} fill={group.district.accent}>{group.district.name}</text>)}

        {/* live player marker: position and facing are read from the running scene */}
        <g ref={marker} className="mp-player" transform={`translate(${pose?.x ?? 0} ${pose?.z ?? 8}) rotate(${(-(pose?.facing ?? 0) * 180) / Math.PI})`}>
          <polygon points={polygon(0, 0, 6.4, 12)} fill="#d5a64b18" stroke="#d5a64b66" strokeWidth="0.6" />
          <polygon points="0,5.2 -3.6,-4.4 0,-1.6 3.6,-4.4" fill="#d5a64b" stroke="#10141f" strokeWidth="0.8" />
        </g>
      </svg>
      {!pose && <div className="mp-offline">The world is not running, so no live position is available.</div>}
    </div>

    <aside className="mp-side">
      <div className="mp-readout">
        <div className="task-head"><span>YOUR POSITION</span><b>{pose ? 'LIVE' : 'OFFLINE'}</b></div>
        <strong>{pose ? `${metres(pose.x)} · ${metres(pose.z)}` : '— · —'}</strong>
        <small>{pose ? `FACING ${headingOf(pose.facing)} · ${here?.name ?? ''}` : 'Enter the world to track movement'}</small>
        <div className="mp-zoom">
          <button className={follow ? '' : 'on'} onClick={() => setFollow(false)}>FIT TOWN</button>
          <button className={follow ? 'on' : ''} onClick={() => setFollow(true)}>FOLLOW ME</button>
        </div>
      </div>

      <div className="mp-legend">
        <div className="task-head"><span>LEGEND</span><b>{buildingSpecs.length} BUILDINGS</b></div>
        <ul>
          <li><Swatch kind="player" color="#d5a64b" />You · live position and facing</li>
          <li><Swatch kind="service" color="#7bc9ce" />Service townsfolk ({serviceNpcs.length})</li>
          <li><Swatch kind="resident" color="#849394" />Residents ({ambientNpcs.length})</li>
          <li><Swatch kind="building" color="#795c50" />Building · gold notch is the door</li>
          <li><Swatch kind="plaza" color="#65706a" />Fountain plaza</li>
          <li><Swatch kind="street" color="#555d59" />Streets and the upper terrace</li>
          <li><Swatch kind="water" color="#1b5660" />Canal</li>
          <li><Swatch kind="bridge" color="#765b4a" />Bridges ({townLayout.bridges.length})</li>
          <li><Swatch kind="tree" color="#49624d" />Woodland ring</li>
          <li><Swatch kind="region" color="#e35e35" />Hunting ground ({huntingRegions.length})</li>
          <li><Swatch kind="trail" color="#8a6c4a" />Lit trail to the wildwood</li>
          {Object.values(speciesSpecs).map(species => <li key={species.id}>
            <Swatch kind="animal" color={species.mapColor} />{species.label} · {species.threat}
          </li>)}
        </ul>
        <small className="mp-seam">{huntingRegions.length > 0
          ? `Hunting grounds, the trail, and the ${animals.filter(animal => animal.alive).length} live animals are read from the wildlife module.`
          : 'Hunting grounds are not drawn: no wildlife module is publishing spawn regions in this build, and nothing here is guessed.'}</small>
      </div>

      {wildRegions.length > 0 && <div className="mp-places">
        <div className="task-head"><span>HUNTING GROUNDS</span><b>{wildRegions.length}</b></div>
        <ul>
          {wildRegions.map(region => <li key={region.id} className="mp-region-row">
            <strong>{region.label}</strong>
            <em>{metres(region.x)} {metres(region.z)}</em>
            <small>{region.note}</small>
            <span>{Object.entries(region.counts).map(([species, count]) => `${count}× ${species}`).join(' · ')}</span>
          </li>)}
        </ul>
      </div>}

      {grouped.map(group => <div key={group.district.id} className="mp-places">
        <div className="task-head"><span style={{ color: group.district.accent }}>{group.district.name}</span><b>{group.members.length}</b></div>
        <ul>
          {group.members.map(spec => <li key={spec.name}><i style={{ background: spec.accent ?? '#d5a64b' }} />{spec.name}<em>{metres(spec.x)} {metres(spec.z)}</em></li>)}
        </ul>
      </div>)}

      <div className="mp-places">
        <div className="task-head"><span>TOWNSFOLK</span><b>{serviceNpcs.length}</b></div>
        <ul>
          {serviceNpcs.map(npc => <li key={npc.name}><i style={{ background: npc.color }} />{npc.name}<em>{metres(npc.x)} {metres(npc.z)}</em></li>)}
        </ul>
      </div>
      <small className="mp-seam">Single-player demo. The map reads the running scene for your position only; it changes nothing in the world.</small>
    </aside>
    </div>
  </>
}
