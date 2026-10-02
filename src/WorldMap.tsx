import React, { useEffect, useMemo, useRef, useState } from 'react'
import { SHIELDED_NOTICE, ambientNpcs, buildingSpecs, districtAt, districts, huntingRegions, perimeterTrees, serviceNpcs, townLayout } from './townData'
import { emblems, isEmblemId } from './emblems'
import type { EmblemId } from './emblems'
import { SAFE_ZONE, huntTrails, speciesSpecs, wildRegions, wildlifeMarkers } from './wildlife'
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

/** Legend keys use the same ink and parchment tones as the chart itself. */
function Swatch({ kind, color }: { kind: string; color: string }) {
  return <svg className="mp-swatch" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">
    {kind === 'building' && <>
      <rect x="1" y="1" width="10" height="10" fill="#9c7f52" stroke="#4a3826" strokeWidth="0.8" />
      <rect x="3" y="3" width="6" height="6" fill="#e0cda2" />
      <rect x="5" y="0" width="2" height="2" fill="#d5a64b" />
    </>}
    {kind === 'service' && <polygon points="6,1 11,6 6,11 1,6" fill={color} stroke="#3a2b1c" strokeWidth="1" />}
    {kind === 'resident' && <rect x="3" y="3" width="6" height="6" fill="#9a9a86" stroke="#3a2b1c" strokeWidth="0.8" />}
    {kind === 'player' && <polygon points="6,11 1,1 6,4 11,1" fill={color} stroke="#3a2b1c" strokeWidth="0.8" />}
    {kind === 'water' && <><rect x="0" y="0" width="12" height="12" fill="#a8c9c6" stroke="#4d7f80" strokeWidth="0.8" /><rect x="0" y="4" width="12" height="0.8" fill="#6f9c9c" /><rect x="0" y="8" width="8" height="0.8" fill="#6f9c9c" /></>}
    {kind === 'bridge' && <><rect x="0" y="3" width="12" height="6" fill="#b08e5c" stroke="#5b4433" strokeWidth="0.6" /><rect x="3" y="3" width="1" height="6" fill="#7a5c39" /><rect x="7" y="3" width="1" height="6" fill="#7a5c39" /></>}
    {kind === 'street' && <><rect x="0" y="0" width="12" height="12" fill="#e0cda2" /><rect x="4" y="0" width="4" height="12" fill="#d3bb8d" stroke="#a98c5e" strokeWidth="0.5" /></>}
    {kind === 'tree' && <rect x="2" y="2" width="8" height="8" fill="#7d8a5e" stroke="#4a3826" strokeWidth="0.8" />}
    {kind === 'plaza' && <polygon points={polygon(6, 6, 5)} fill="#cdb689" stroke="#8a6c43" strokeWidth="0.8" />}
    {kind === 'region' && <polygon points={polygon(6, 6, 5, 14)} fill={`${color}33`} stroke={color} strokeWidth="1" strokeDasharray="2 2" />}
    {kind === 'mark' && <><polygon points={polygon(6, 6, 5.4, 12)} fill="none" stroke={color} strokeWidth="1.1" strokeDasharray="1.8 1.4" /><polygon points="6,3 9,6 6,9 3,6" fill="#7bc9ce" stroke="#3a2b1c" strokeWidth="0.8" /></>}
    {kind === 'trail' && <><rect x="0" y="5" width="12" height="2.4" fill="#7a5c33" /><rect x="1" y="5.7" width="3" height="1" fill="#e0cda2" /><rect x="7" y="5.7" width="3" height="1" fill="#e0cda2" /></>}
    {kind === 'animal' && <rect x="3" y="3" width="6" height="6" fill={color} stroke="#3a2b1c" strokeWidth="1" />}
  </svg>
}

/** Zcash's own gold, and the ink the chart warns in. Kept apart from the parchment palette. */
const MARK_GOLD = '#b8860b'
const MARK_WARN = '#8a3a1e'

/**
 * A trade emblem, drawn from the same pixel grid src/emblems.ts extrudes into
 * cubes for the boards in the world.
 *
 * The point of reusing the grid rather than picking map icons is that the badge
 * a player reads off a shop wall is the badge the map lists beside that
 * person's name, with no second opinion about who does what.
 *
 * Cells are coalesced into horizontal runs first. The Zcash mark alone is 421
 * filled cells, and eight of these in a sidebar is not the place to spend two
 * thousand DOM nodes on detail that is three pixels wide.
 */
function EmblemMark({ id, size = 17 }: { id: EmblemId; size?: number }) {
  const art = emblems[id]
  const runs = useMemo(() => {
    const out: Array<{ x: number; y: number; width: number; color: string }> = []
    art.rows.forEach((row, y) => {
      let start = 0
      while (start < row.length) {
        const color = art.palette[row[start]]?.color
        let end = start + 1
        while (end < row.length && art.palette[row[end]]?.color === color) end += 1
        if (color) out.push({ x: start, y, width: end - start, color })
        start = end
      }
    })
    return out
  }, [art])
  return <svg
    className="mp-emblem"
    viewBox={`0 0 ${art.width} ${art.rows.length}`}
    width={size}
    height={size}
    shapeRendering="crispEdges"
    aria-hidden="true"
  >
    {runs.map((run, index) => <rect key={index} x={run.x} y={run.y} width={run.width} height="1" fill={run.color} />)}
  </svg>
}

/** The emblem a service NPC's trade is drawn with, if it is one this build draws. */
const emblemOf = (id: string | undefined) => (id && isEmblemId(id) ? id : null)

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
    <div className="mp">
    <div className="mp-stage">
      <svg ref={svg} viewBox={fitBox} shapeRendering="crispEdges" role="img" aria-label="Map of Voxels, drawn from the live town layout">
        <defs>
          {/* surveyor's grid ruled straight onto the parchment */}
          <pattern id="mp-grid" width="8" height="8" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill="#e0cda2" />
            <rect width="8" height="0.5" fill="#b89f73" />
            <rect width="0.5" height="8" fill="#b89f73" />
          </pattern>
          {/* open country: stipple, the way an inked chart shades rough ground */}
          <pattern id="mp-wild" width="6" height="6" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="#d9c69b" />
            <rect x="1" y="1" width="1" height="1" fill="#a98c5e" />
            <rect x="4" y="3" width="1" height="1" fill="#a98c5e" />
          </pattern>
          {/* buildings are hatched blocks, not filled shapes */}
          <pattern id="mp-hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="3" height="3" fill="#c9ab74" />
            <rect width="1" height="3" fill="#9c7f52" />
          </pattern>
          <pattern id="mp-water" width="4" height="4" patternUnits="userSpaceOnUse">
            <rect width="4" height="4" fill="#a8c9c6" />
            <rect y="1" width="4" height="0.6" fill="#6f9c9c" />
          </pattern>
        </defs>
        <rect x={FIT.x} y={FIT.z} width={FIT.size} height={FIT.size} fill="url(#mp-wild)" />
        <rect x={-townLayout.ground / 2} y={-townLayout.ground / 2} width={townLayout.ground} height={townLayout.ground} fill="url(#mp-grid)" />
        <rect x={-townLayout.bounds} y={-townLayout.bounds} width={townLayout.bounds * 2} height={townLayout.bounds * 2} fill="none" stroke="#8a6c4366" strokeWidth="1" strokeDasharray="6 4" />

        {/* hunting grounds and the lit trail, published by the wildlife module */}
        {/* the real footprint, not a stand-in circle: the same outline the ground
            is cut to and the same one the animals are fenced by */}
        {huntingRegions.map(region => <polygon key={region.name} points={region.outline.map(([x, z]) => `${x.toFixed(1)},${z.toFixed(1)}`).join(' ')} fill={`${region.accent}26`} stroke={region.accent} strokeWidth="1.1" strokeDasharray="5 3" />)}
        {huntTrails.map((trail, index) => (
          <g key={`trail-${index}`}>
            <polyline points={trail.map(([x, z]) => `${x},${z}`).join(' ')} fill="none" stroke="#7a5c33" strokeWidth="2.6" strokeLinejoin="round" />
            <polyline points={trail.map(([x, z]) => `${x},${z}`).join(' ')} fill="none" stroke="#e0cda2" strokeWidth="1" strokeLinejoin="round" strokeDasharray="3 3" />
          </g>
        ))}

        {/* streets, plaza, canal, bridges: the same numbers the world is built from */}
        {townLayout.streets.map((street, index) => <rect key={index} x={street.x - street.width / 2} y={street.z - street.depth / 2} width={street.width} height={street.depth} fill="#d3bb8d" stroke="#a98c5e" strokeWidth="0.6" />)}
        <polygon points={polygon(plaza.x, plaza.z, plaza.radius)} fill="#cdb689" stroke="#8a6c43" strokeWidth="0.9" />
        <rect x={canal.x - canal.bankWidth / 2} y={canal.z - canal.bankLength / 2} width={canal.bankWidth} height={canal.bankLength} fill="#c3bb8f" stroke="#8a6c43" strokeWidth="0.6" />
        <rect x={canal.x - canal.waterWidth / 2} y={canal.z - canal.waterLength / 2} width={canal.waterWidth} height={canal.waterLength} fill="url(#mp-water)" stroke="#4d7f80" strokeWidth="0.7" />
        {townLayout.bridges.map(bridgeZ => <g key={bridgeZ}>
          <rect x={canal.x - 7.5} y={bridgeZ - 2.75} width="15" height="5.5" fill="#b08e5c" stroke="#5b4433" strokeWidth="0.8" />
          {Array.from({ length: 7 }, (_, i) => <rect key={i} x={canal.x - 6.3 + i * 2} y={bridgeZ - 2.75} width="0.7" height="5.5" fill="#7a5c39" />)}
        </g>)}
        <polygon points={polygon(fountain.x, fountain.z, fountain.radius)} fill="#c0b48d" stroke="#5b4433" strokeWidth="0.7" />
        <polygon points={polygon(fountain.x, fountain.z, 3.2)} fill="#a8c9c6" stroke="#4d7f80" strokeWidth="0.5" />
        {Array.from({ length: marketStalls.count }, (_, i) => <rect key={i} x={marketStalls.x + i * marketStalls.step - 0.9} y={marketStalls.z - 0.35} width="1.8" height="0.7" fill="#8a6c43" />)}
        <rect x={noticeBoard.x - 2.25} y={noticeBoard.z - 0.4} width="4.5" height="0.8" fill="#8a6c43" />

        {/* woodland ring: inked tufts */}
        {trees.map((tree, index) => <rect key={index} x={tree.x - 1.3} y={tree.z - 1.3} width="2.6" height="2.6" fill={tree.alt ? '#6d7d4e' : '#7d8a5e'} stroke="#4a3826" strokeWidth="0.4" />)}

        {/* the wildlife safe zone, so the chart says where animals leave you alone */}
        <polygon points={polygon(SAFE_ZONE.x, SAFE_ZONE.z, SAFE_ZONE.r, 24)} fill="none" stroke="#4d7f8099" strokeWidth="1" strokeDasharray="4 4" />
        <text className="mp-label" x={SAFE_ZONE.x} y={SAFE_ZONE.z + SAFE_ZONE.r - 3} fill="#37696b" textAnchor="middle">SAFE ZONE</text>

        {/* buildings, straight from the BuildingSpec list */}
        {buildingSpecs.map(spec => {
          const left = spec.x - spec.width / 2
          const top = spec.z - spec.depth / 2
          return <g key={spec.name}>
            <rect x={left} y={top} width={spec.width} height={spec.depth} fill="url(#mp-hatch)" stroke="#4a3826" strokeWidth="0.9" />
            <rect x={left + 1.6} y={top + 1.6} width={spec.width - 3.2} height={spec.depth - 3.2} fill="#e0cda2" stroke="none" />
            {/* the entrance sits on the -z face, exactly as createBuilding places it */}
            <rect x={spec.x - 1.2} y={top - 0.9} width="2.4" height="2" fill={spec.accent ?? '#d5a64b'} stroke="#4a3826" strokeWidth="0.4" />
            <text className="mp-label mp-sign" x={spec.x} y={spec.z + spec.depth / 2 + 4.2} fill="#3a2b1c" textAnchor="middle">{spec.sign}</text>
          </g>
        })}

        {/* region names sit inside the northern edge of their own footprint */}
        {huntingRegions.map(region => {
          const north = Math.min(...region.outline.map(([, z]) => z))
          return <text key={`${region.name}-label`} className="mp-region" x={region.x} y={north + 4.5} fill={region.accent} textAnchor="middle">{region.name}</text>
        })}

        {/* live animals, polled from the wildlife module */}
        {animals.filter(animal => animal.alive).map((animal, index) => <rect
          key={index}
          x={animal.x - 1.1}
          y={animal.z - 1.1}
          width="2.2"
          height="2.2"
          fill={speciesSpecs[animal.species].mapColor}
          stroke="#3a2b1c"
          strokeWidth="0.5"
        />)}

        {/* residents */}
        {ambientNpcs.map((npc, index) => <rect className="mp-resident" key={index} x={npc.x - 1.3} y={npc.z - 1.3} width="2.6" height="2.6" fill="#9a9a86" stroke="#3a2b1c" strokeWidth="0.6" />)}

        {/* named service NPCs.
            The diamond says where somebody is standing; the line under the name
            says what they do, which is the whole reason for finding them. Anyone
            whose desk names an external network gets a gold ring as well, and
            the standing of that desk written under it — the ring marks WHICH
            network, and the line says how far the desk goes. Neither is allowed
            to travel without the other, the same rule as the board in the world. */}
        {serviceNpcs.map(npc => <g key={npc.name}>
          {npc.integrates && <polygon
            points={polygon(npc.x, npc.z, 5.4, 12)}
            fill="none"
            stroke={MARK_GOLD}
            strokeWidth="1.2"
            strokeDasharray="3 2.2"
          />}
          <polygon points={polygon(npc.x, npc.z, 2.9, 4)} fill={npc.color} stroke="#3a2b1c" strokeWidth="0.9" />
          <rect x={npc.x - 0.6} y={npc.z - 0.6} width="1.2" height="1.2" fill="#3a2b1c" />
          <text className="mp-npc" x={npc.x + 4.4} y={npc.z + 0.2} fill="#3a2b1c">{npc.name.split('·')[0].trim()}</text>
          <text className="mp-trade" x={npc.x + 4.4} y={npc.z + 3.4} fill="#6b5233">{npc.trade}</text>
          {npc.integrates && <>
            <text className="mp-mark-name" x={npc.x} y={npc.z + 9} fill={MARK_GOLD} textAnchor="middle">{npc.integrates}</text>
            <text className="mp-mark-state" x={npc.x} y={npc.z + 12.4} fill={MARK_WARN} textAnchor="middle">{SHIELDED_NOTICE.headline}</text>
          </>}
        </g>)}

        {/* district tags, keyed to the ground their own buildings occupy */}
        {grouped.map(group => <text key={group.district.id} className="mp-district" x={group.x} y={group.z} fill="#6b5640">{group.district.name}</text>)}

        {/* compass rose and scale bar, drawn with the same ink as the chart */}
        <g className="mp-rose" transform="translate(80 -82)">
          <polygon points={polygon(0, 0, 11, 16)} fill="#e0cda2" stroke="#8a6c43" strokeWidth="0.7" />
          <polygon points="0,-11 2.4,-2.4 11,0 2.4,2.4 0,11 -2.4,2.4 -11,0 -2.4,-2.4" fill="#e7d7b0" stroke="#4a3826" strokeWidth="0.6" />
          <polygon points="0,-11 2.4,-2.4 0,0 -2.4,-2.4" fill="#8a5a1e" stroke="#4a3826" strokeWidth="0.5" />
          <polygon points="0,11 2.4,2.4 0,0 -2.4,2.4" fill="#4a3826" />
          <text x="0" y="-12.6" fill="#4a3826" textAnchor="middle">N</text>
        </g>
        <g transform="translate(-96 94)">
          {[0, 1, 2, 3, 4].map(i => <rect key={i} x={i * 10} y="0" width="10" height="2.4" fill={i % 2 ? '#e7d7b0' : '#4a3826'} stroke="#4a3826" strokeWidth="0.4" />)}
          <text className="mp-label" x="0" y="-2" fill="#4a3826" textAnchor="start">0</text>
          <text className="mp-label" x="50" y="-2" fill="#4a3826" textAnchor="end">50M</text>
        </g>

        {/* live player marker: position and facing are read from the running scene */}
        <g ref={marker} className="mp-player" transform={`translate(${pose?.x ?? 0} ${pose?.z ?? 8}) rotate(${(-(pose?.facing ?? 0) * 180) / Math.PI})`}>
          <polygon points={polygon(0, 0, 6.4, 12)} fill="#8a5a1e26" stroke="#8a5a1e99" strokeWidth="0.7" />
          <polygon points="0,5.2 -3.6,-4.4 0,-1.6 3.6,-4.4" fill="#d5a64b" stroke="#3a2b1c" strokeWidth="0.9" />
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
          <li><Swatch kind="service" color="#7bc9ce" />Service townsfolk ({serviceNpcs.length}) · trade named under each</li>
          {serviceNpcs.some(npc => npc.integrates) && <li className="mp-legend-mark">
            <Swatch kind="mark" color={MARK_GOLD} />
            <span>Gold ring · this desk names an <b>external network</b>, drawn with that
            network&rsquo;s own mark. It is a label, not a working service: Zcash
            shielded transfer is <b>unavailable here</b> and nothing in this build can
            send ZEC.</span>
          </li>}
          <li><Swatch kind="resident" color="#849394" />Residents ({ambientNpcs.length})</li>
          <li><Swatch kind="building" color="#795c50" />Building · gold notch is the door</li>
          <li><Swatch kind="plaza" color="#65706a" />Fountain plaza</li>
          <li><Swatch kind="street" color="#555d59" />Streets and the upper terrace</li>
          <li><Swatch kind="water" color="#1b5660" />Canal</li>
          <li><Swatch kind="bridge" color="#765b4a" />Bridges ({townLayout.bridges.length})</li>
          <li><Swatch kind="tree" color="#49624d" />Woodland ring</li>
          <li><Swatch kind="region" color="#e35e35" />Hunting ground ({huntingRegions.length})</li>
          <li><Swatch kind="trail" color="#8a6c4a" />Lit trails to the hunting grounds</li>
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
        <div className="task-head"><span>{group.district.name}</span><b>{group.members.length}</b></div>
        <ul>
          {group.members.map(spec => <li key={spec.name}><i style={{ background: spec.accent ?? '#d5a64b' }} />{spec.name}<em>{metres(spec.x)} {metres(spec.z)}</em></li>)}
        </ul>
      </div>)}

      {/* Who does what, with the badge each one actually hangs on their premises,
          so the list and the world cannot drift apart. The external mark sits in
          its own block under the row that owns it, carrying the same caption and
          the same status lines as the board in the world — it is never shown as
          a bare logo beside a name. */}
      <div className="mp-places">
        <div className="task-head"><span>TOWNSFOLK</span><b>{serviceNpcs.length}</b></div>
        <ul>
          {serviceNpcs.map(npc => {
            const trade = emblemOf(npc.emblem)
            const mark = emblemOf(npc.integrates)
            return <li key={npc.name} className="mp-folk">
              {trade ? <EmblemMark id={trade} /> : <i style={{ background: npc.color }} />}
              <strong>{npc.name}</strong>
              <em>{metres(npc.x)} {metres(npc.z)}</em>
              <span>{npc.trade}</span>
              {mark && npc.status?.length && <div className="mp-folk-mark">
                <EmblemMark id={mark} size={30} />
                <div>
                  <b>{SHIELDED_NOTICE.markCaption} {npc.integrates}</b>
                  {npc.status.map(line => <small key={line}>{line}</small>)}
                </div>
              </div>}
            </li>
          })}
        </ul>
      </div>
      <small className="mp-seam">Single-player demo. The map reads the running scene for your position only; it changes nothing in the world.</small>
    </aside>
    </div>
  </>
}
