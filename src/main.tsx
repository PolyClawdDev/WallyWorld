/// <reference types="vite/client" />
// First, before anything reaches @solana/web3.js: give the browser a Buffer.
import './solana/bufferPolyfill'
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { animateCharacter, createWizard, cycleStyle, defaultMothStyle, styleLabel, styleSlots, wizards } from './characters'
import type { MothStyle, WizardId } from './characters'
import { createTownsfolk, npcAccent, placeNpcLabel } from './npcs'
import { Popup } from './Popup'
import { WalletPouch } from './Wallet'
import { WorldMap } from './WorldMap'
import { ambientNpcs, buildingSpecs, perimeterTrees, serviceNpcs, townLayout } from './townData'
import type { BuildingSpec } from './townData'
import { registerWorld } from './worldBridge'
import { compassHuntRegion, createWildlife, highHuntArea, isInTown, isSafeZone, speciesSpecs } from './wildlife'
import { animateWildscape, createWildscape } from './wildscape'
import { createVitals } from './combat'
import { huntState, pingHunt, resetHuntState } from './huntStore'
import { HuntHud } from './huntHud'
import { creditPickup, debitDeath, recordKill } from './rewards'
import { JournalPanel, SettingsPanel } from './panels'
import { FundsBadge, MainnetWarningBanner } from './solana/FundsBadge'
import { WalletSolanaPanel } from './solana/WalletPanel'
import { registerPlayer } from './solana/playerBridge'
import { createBattle } from './battle/engine'
import type { BattleSystem } from './battle/engine'
import { createNavGrid } from './battle/nav'
import type { Obstacle } from './battle/nav'
import { killXp } from './battle/huntXp'
import { primeAudio } from './battle/audio'
import {
  battleState,
  escapeWasConsumed,
  markEscapeConsumed,
  onKeyboardMoveChange,
  readKeyboardMove,
  registerBattleCommands,
} from './battle/store'
import { progressFor } from './battle/progression'
import { CombatHud } from './combatHud'
import { PvpOverlay } from './pvp/ui'
import { refreshPvpIdentity, send, startPvp, stopPvp } from './pvp/net'
import { isDuelLocked, pvpState } from './pvp/store'
import { applyDuelPose, disposePvpWorld, inspectRemote, pickRemote, updatePvpWorld } from './pvp/world'
import { createCharacterNameplate, displayNameFor } from './nameplate'

import './styles.css'
// Loads last on purpose: the UI kit restyles the panels and HUD chrome that
// styles.css and hunt.css set up, so it has to win on equal specificity.
import './worldUi.css'

type Panel = 'journal' | 'wallet' | 'settings' | 'map' | null

// Prompts and the F action must share one radius, otherwise F silently does nothing.
const INTERACT_RANGE = 5
/**
 * Movement is mouse-only by default, which leaves Q/W/E/R/A/S free for combat.
 * Keyboard walking is still available behind a setting for people who prefer
 * it; when it is on, W, A and S carry two jobs and a quick tap means the
 * combat command while a hold means the step.
 */
const TAP_MS = 200
/** Camera distance limits. Closer than the minimum puts the lens in the hat. */
const ZOOM_MIN = 3.2
const ZOOM_MAX = 32
const ZOOM_STEP = 0.0024

const buildings = [
  { name: 'THE HEARTH', sub: 'Your home', x: -15, z: 11, color: '#765b52', npc: '' },
  { name: 'THE ARCHIVE', sub: 'Research & records', x: -16, z: -13, color: '#586979', npc: 'LYRA' },
  { name: 'THE EXCHANGE', sub: 'Quotes · DEMO MODE', x: 15, z: -13, color: '#626873', npc: 'VELLUM' },
  { name: 'THE WORKSHOP', sub: 'Creative services', x: 15, z: 11, color: '#735a48', npc: 'SPARK' },
  { name: 'POST OFFICE', sub: 'Requests & receipts', x: 0, z: -22, color: '#6e5650', npc: 'PIP' },
]

function material(color: string, roughness = 0.8) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: color === '#d5a64b' ? 0.55 : 0 })
}

function box(scene: THREE.Group, size: [number, number, number], pos: [number, number, number], color: string, bevel = 0) {
  const geo = new THREE.BoxGeometry(...size)
  const mesh = new THREE.Mesh(geo, material(color))
  mesh.position.set(...pos)
  if (bevel) mesh.geometry = new THREE.BoxGeometry(...size, 1, 1, 1)
  mesh.castShadow = true
  mesh.receiveShadow = true
  scene.add(mesh)
  return mesh
}

function addPart(parent: THREE.Group, geometry: THREE.BufferGeometry, color: string, position: [number, number, number], rotation?: [number, number, number], roughness = 0.78) {
  const mesh = new THREE.Mesh(geometry, material(color, roughness))
  mesh.position.set(...position)
  if (rotation) mesh.rotation.set(...rotation)
  mesh.castShadow = true
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

function voxel(parent: THREE.Group, size: [number, number, number], position: [number, number, number], color: string, rotation?: [number, number, number], roughness = 0.78) {
  return addPart(parent, new THREE.BoxGeometry(...size), color, position, rotation, roughness)
}

function glowingPart(parent: THREE.Group, size: [number, number, number], position: [number, number, number], color: string, intensity = 2) {
  const mesh = voxel(parent, size, position, color, undefined, 0.25)
  mesh.material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.25 })
  return mesh
}

function makeLabel(text: string, color = '#d5a64b') {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#101923e8'
  ctx.fillRect(4, 4, 248, 56)
  ctx.strokeStyle = color
  ctx.lineWidth = 3
  ctx.strokeRect(5, 5, 246, 54)
  ctx.font = '700 19px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#e5ddc8'
  ctx.fillText(text, 128, 32)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false }))
  sprite.scale.set(3.6, 0.9, 1)
  return sprite
}

function createBuilding(root: THREE.Group, spec: BuildingSpec) {
  const g = new THREE.Group()
  const { x, z, width, depth, height } = spec
  voxel(g, [width + 0.5, 0.5, depth + 0.5], [x, 0.25, z], '#394247')
  voxel(g, [width, height, depth], [x, height / 2 + 0.5, z], spec.wall)
  voxel(g, [width + 0.3, 0.22, depth + 0.25], [x, height + 0.62, z], '#30353a')
  const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(width, depth) * 0.72, 2.8, 4), material(spec.roof))
  roof.rotation.y = Math.PI / 4
  roof.position.set(x, height + 2.0, z)
  roof.scale.z = depth / width
  roof.castShadow = true
  g.add(roof)
  // timber frame and recessed front details
  const front = z - depth / 2 - 0.06
  voxel(g, [0.18, height - 0.8, 0.18], [x - width / 2 + 0.35, (height + 0.5) / 2, front], '#4b4037')
  voxel(g, [0.18, height - 0.8, 0.18], [x + width / 2 - 0.35, (height + 0.5) / 2, front], '#4b4037')
  voxel(g, [width - 0.5, 0.18, 0.18], [x, height - 0.1, front], '#4b4037')
  voxel(g, [1.35, 2.35, 0.18], [x, 1.68, front - 0.03], '#20252d')
  for (const wx of [-width * 0.28, width * 0.28]) {
    const win = glowingPart(g, [1.05, 0.85, 0.12], [x + wx, height * 0.63, front - 0.05], spec.accent ?? '#d5a64b', 0.7)
    win.material = new THREE.MeshStandardMaterial({ color: spec.accent ?? '#d5a64b', emissive: spec.accent ?? '#d5a64b', emissiveIntensity: 0.7 })
  }
  voxel(g, [width * 0.78, 0.10, 1.15], [x, height * 0.72, front - 0.13], '#6b5544')
  const sign = makeLabel(spec.sign, spec.accent ?? '#d5a64b')
  sign.position.set(x, height + 0.6, front - 0.32)
  g.add(sign)
  // asymmetrical chimney, awning, crates, and a lantern sell scale and purpose
  voxel(g, [0.48, 1.6, 0.48], [x + width * 0.28, height + 1.7, z + depth * 0.12], '#4a4a4c')
  voxel(g, [width * 0.6, 0.15, 1.05], [x, height * 0.68, front - 0.65], spec.accent ?? '#765b42')
  for (const dx of [-width * 0.42, width * 0.42]) voxel(g, [0.18, 1.8, 0.18], [x + dx, height * 0.55, front - 0.55], '#594533')
  voxel(g, [0.48, 0.48, 0.48], [x - width * 0.36, 0.52, front - 0.62], '#70543c')
  voxel(g, [0.42, 0.32, 0.42], [x + width * 0.38, 0.42, front - 0.62], '#8a6848')
  root.add(g)
}

function createTown() {
  const root = new THREE.Group()
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(townLayout.ground, townLayout.ground), material('#344541'))
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  root.add(ground)
  // authored street ribbons and an elevated upper quarter, shared with the map
  townLayout.streets.forEach(street => voxel(root, [street.width, 0.18, street.depth], [street.x, street.y, street.z], street.color))
  const plaza = new THREE.Mesh(new THREE.CylinderGeometry(townLayout.plaza.radius, townLayout.plaza.radius, 0.24, 12), material(townLayout.plaza.color))
  plaza.position.set(townLayout.plaza.x, 0.2, townLayout.plaza.z)
  root.add(plaza)
  // canal with banks, animated-looking segmented surface, and two bridges
  const bank = material('#58635e')
  const canal = townLayout.canal
  voxel(root, [canal.bankWidth, 0.2, canal.bankLength], [canal.x, 0.2, canal.z], canal.bank)
  const water = new THREE.Mesh(new THREE.PlaneGeometry(canal.waterWidth, canal.waterLength), new THREE.MeshStandardMaterial({ color: canal.water, roughness: 0.2, metalness: 0.1 }))
  water.rotation.x = -Math.PI / 2
  water.position.set(canal.x, 0.34, canal.z)
  root.add(water)
  for (const bridgeZ of townLayout.bridges) {
    voxel(root, [15, 0.5, 5.5], [canal.x, 0.55, bridgeZ], '#765b4a')
    for (let i = -3; i <= 3; i++) voxel(root, [0.35, 0.85, 5.8], [canal.x + i * 2, 0.9, bridgeZ], '#a07752')
    voxel(root, [15, 0.5, 0.25], [canal.x, 1.35, bridgeZ - 2.25], '#4b4037')
    voxel(root, [15, 0.5, 0.25], [canal.x, 1.35, bridgeZ + 2.25], '#4b4037')
  }
  // fountain landmark, notice board, market awnings and stair terrace
  const fountain = new THREE.Mesh(new THREE.CylinderGeometry(townLayout.fountain.radius - 0.6, townLayout.fountain.radius, 0.7, 12), material('#68777b'))
  fountain.position.set(townLayout.fountain.x, 0.45, townLayout.fountain.z)
  root.add(fountain)
  const fountainWater = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 0.16, 12), new THREE.MeshStandardMaterial({ color: '#4ca7ae', emissive: '#1b5d66', emissiveIntensity: 0.5 }))
  fountainWater.position.set(0, 0.85, 0)
  root.add(fountainWater)
  const board = townLayout.noticeBoard
  voxel(root, [4.5, 2.8, 0.22], [board.x, 1.5, board.z], '#765b42')
  voxel(root, [0.16, 3.3, 0.16], [board.x - 2, 1.65, board.z], '#4c3b2d')
  voxel(root, [0.16, 3.3, 0.16], [board.x + 2, 1.65, board.z], '#4c3b2d')
  const stalls = townLayout.marketStalls
  for (let i = 0; i < stalls.count; i++) voxel(root, [1.8, 0.2, 0.7], [stalls.x + i * stalls.step, 0.3, stalls.z], '#896746')
  for (let i = 0; i < 5; i++) voxel(root, [1.8, 0.2, 0.7], [-15 + i * 4, 0.5 + i * 0.18, 31 + i * 0.4], '#70736a')
  buildingSpecs.forEach(spec => createBuilding(root, spec))
  // perimeter vegetation and hand-placed story props
  for (const { x, z, alt } of perimeterTrees()) {
    voxel(root, [0.45, 2.4, 0.45], [x, 1.2, z], '#4d3d35')
    const crown = new THREE.Mesh(new THREE.DodecahedronGeometry(2.3, 0), material(alt ? '#385847' : '#49624d'))
    crown.position.set(x, 3.3, z)
    crown.castShadow = true
    root.add(crown)
  }
  return root
}

function createNpc(name: string, x: number, z: number, interactive = true, color?: string) {
  const npc = createTownsfolk(name)
  // Named NPCs keep their town-data colour so the world and the map agree;
  // residents fall back to their own design accent instead of one shared grey.
  const accent = color ?? npcAccent(name)
  npc.position.set(x, 0, z)
  npc.userData.npc = interactive ? name : undefined
  npc.userData.homeY = 0
  npc.userData.phase = (x + z) * 0.13
  npc.userData.interactive = interactive
  const label = makeLabel(name, accent)
  label.visible = interactive
  // Sized and raised from the model's own height, not a fixed offset.
  placeNpcLabel(npc, label)
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.38, 8), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.8, side: THREE.DoubleSide }))
  marker.rotation.x = -Math.PI / 2
  marker.position.y = 0.04
  npc.add(marker)
  return npc
}

function createGoldDrop(x: number, y: number, z: number, goldBaseUnits = 1) {
  const drop = new THREE.Group()
  drop.position.set(x, y, z)
  drop.userData.goldDrop = true
  // Integer base units, carried on the drop so a bear pays out like a bear.
  drop.userData.gold = Math.max(1, Math.trunc(goldBaseUnits))
  const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.08, 8), new THREE.MeshStandardMaterial({ color: '#f0b84d', emissive: '#9f6429', emissiveIntensity: 1.2, metalness: 0.7, roughness: 0.25 }))
  coin.rotation.z = Math.PI / 2
  coin.castShadow = true
  drop.add(coin)
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.34, 12), new THREE.MeshBasicMaterial({ color: '#d5a64b', transparent: true, opacity: 0.8, side: THREE.DoubleSide }))
  ring.rotation.x = -Math.PI / 2
  ring.position.y = -0.18
  drop.add(ring)
  return drop
}

/** Soft circular falloff used for the preview halo and its drifting motes. */
function radialGlow(color: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, color)
  gradient.addColorStop(0.35, `${color}66`)
  gradient.addColorStop(1, `${color}00`)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(canvas)
}

function CharacterPreview({ wizard, style = defaultMothStyle }: { wizard: WizardId; style?: MothStyle }) {
  const mount = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!mount.current) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#152231')
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 40)
    camera.position.set(3.4, 2.4, 7.4)
    camera.lookAt(0, 1.45, 0)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    mount.current.appendChild(renderer.domElement)
    const key = new THREE.HemisphereLight('#b9c8df', '#192333', 2.4)
    scene.add(key)
    const warm = new THREE.DirectionalLight('#ffd48a', 3.2)
    warm.position.set(-4, 7, 5)
    warm.castShadow = true
    scene.add(warm)
    const fill = new THREE.PointLight('#7bc9ce', 1.2, 8)
    fill.position.set(2, 2, 2)
    scene.add(fill)
    // Behind the character, so the voxel silhouette catches a bright edge.
    const rim = new THREE.DirectionalLight('#9fd7ff', 2.6)
    rim.position.set(1.5, 3.2, -6)
    scene.add(rim)
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.12, 12), material('#263848'))
    floor.position.y = -0.08
    floor.receiveShadow = true
    scene.add(floor)

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: radialGlow('#8fd0e8'),
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    halo.scale.set(7.2, 7.2, 1)
    halo.position.set(0, 1.5, -1.6)
    scene.add(halo)

    const moteTexture = radialGlow('#ffe9b8')
    const motes = Array.from({ length: 14 }, (_, index) => {
      const mote = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: moteTexture,
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      )
      const size = 0.06 + (index % 4) * 0.025
      mote.scale.set(size, size, 1)
      mote.userData.radius = 1.05 + (index % 5) * 0.2
      mote.userData.phase = (index / 14) * Math.PI * 2
      mote.userData.speed = 0.00012 + (index % 3) * 0.00005
      mote.userData.baseY = 0.35 + (index % 7) * 0.36
      scene.add(mote)
      return mote
    })

    const character = createWizard(wizard, 0.84, style)
    character.position.y = 0
    scene.add(character)
    const resize = () => {
      if (!mount.current) return
      const { width, height } = mount.current.getBoundingClientRect()
      camera.aspect = width / Math.max(height, 1)
      camera.updateProjectionMatrix()
      renderer.setSize(width, height)
    }
    resize()
    window.addEventListener('resize', resize)
    let frame = 0
    const animate = (time: number) => {
      character.rotation.y = Math.sin(time * 0.00025) * 0.45
      animateCharacter(character, time)
      halo.material.opacity = 0.26 + Math.sin(time * 0.0008) * 0.06
      for (const mote of motes) {
        const { radius, phase, speed, baseY } = mote.userData
        const angle = time * speed + phase
        mote.position.set(Math.cos(angle) * radius, baseY + Math.sin(time * 0.0009 + phase) * 0.22, Math.sin(angle) * radius)
        mote.material.opacity = 0.28 + (Math.sin(time * 0.0016 + phase) + 1) * 0.22
      }
      renderer.render(scene, camera)
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      renderer.dispose()
      mount.current?.removeChild(renderer.domElement)
    }
  }, [wizard, style])
  return <div ref={mount} className="character-preview" aria-label={`${wizard} 3D character preview`} />
}

const CAST = Object.keys(wizards) as WizardId[]

/** Landing-only hop / sway so the four wayfinders look alive without changing world idle. */
function danceWayfinder(id: WizardId, slot: THREE.Group, time: number) {
  const phase = slot.userData.phase as number
  const restX = slot.userData.restX as number
  const restZ = slot.userData.restZ as number
  const t = time * 0.001 + phase
  if (id === 'MOTH') {
    const hop = Math.abs(Math.sin(t * 4.6))
    slot.position.set(restX + Math.sin(t * 1.4) * 0.08, hop * hop * 0.2, restZ)
    slot.rotation.set(0, 0.18 + Math.sin(t * 1.7) * 0.42, Math.sin(t * 2.1) * 0.07)
    slot.scale.set(1, 1 - (1 - hop) * 0.04, 1)
    return
  }
  if (id === 'BRAMBLE') {
    const hop = Math.abs(Math.sin(t * 6.4))
    slot.position.set(restX, hop * hop * 0.32, restZ)
    slot.rotation.set(0, -0.12 + Math.sin(t * 2.2) * 0.22, Math.sin(t * 3.1) * 0.05)
    slot.scale.set(1 + (1 - hop) * 0.07, 1 - (1 - hop) * 0.08, 1 + (1 - hop) * 0.07)
    return
  }
  if (id === 'CINDER') {
    const beat = (t * 2.4) % (Math.PI * 2)
    const jump = Math.max(0, Math.sin(beat))
    slot.position.set(restX + Math.sin(t * 1.1) * 0.05, jump * jump * 0.46, restZ)
    slot.rotation.set(0, 0.1 + Math.sin(t * 1.5) * 0.28, Math.sin(t * 2.6) * 0.1)
    slot.scale.set(1 + (1 - jump) * 0.05, 1 - (1 - jump) * 0.06, 1)
    return
  }
  slot.position.set(restX + Math.sin(t * 1.3) * 0.1, 0.14 + Math.sin(t * 3.2) * 0.2, restZ)
  slot.rotation.set(Math.sin(t * 1.6) * 0.04, -0.16 + Math.sin(t * 1.15) * 0.58, Math.sin(t * 1.9) * 0.06)
  slot.scale.setScalar(1)
}

function EntryStage() {
  const mount = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!mount.current) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#141c28')
    scene.fog = new THREE.Fog('#141c28', 18, 36)
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    mount.current.appendChild(renderer.domElement)

    scene.add(new THREE.HemisphereLight('#c5d2e2', '#1a2430', 2.2))
    const warm = new THREE.DirectionalLight('#ffd48a', 3.0)
    warm.position.set(-5, 8, 6)
    warm.castShadow = true
    warm.shadow.mapSize.set(512, 512)
    scene.add(warm)
    const fill = new THREE.PointLight('#7bc9ce', 1.05, 16)
    fill.position.set(3, 2.4, 3)
    scene.add(fill)
    const rim = new THREE.DirectionalLight('#9fd7ff', 2.2)
    rim.position.set(2, 3.4, -7)
    scene.add(rim)

    const ground = new THREE.Mesh(new THREE.BoxGeometry(28, 0.08, 16), material('#1c2834'))
    ground.position.y = -0.06
    ground.receiveShadow = true
    scene.add(ground)
    const dais = new THREE.Mesh(new THREE.BoxGeometry(12.6, 0.16, 5.2), material('#263848'))
    dais.position.y = 0.06
    dais.receiveShadow = true
    scene.add(dais)

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: radialGlow('#8fd0e8'),
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    halo.scale.set(16, 10, 1)
    halo.position.set(0, 2.1, -2.4)
    scene.add(halo)

    const moteTexture = radialGlow('#ffe9b8')
    const motes = Array.from({ length: 16 }, (_, index) => {
      const mote = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: moteTexture,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      )
      const size = 0.08 + (index % 4) * 0.03
      mote.scale.set(size, size, 1)
      mote.userData.radius = 2.2 + (index % 6) * 0.45
      mote.userData.phase = (index / 16) * Math.PI * 2
      mote.userData.speed = 0.0001 + (index % 3) * 0.00004
      mote.userData.baseY = 0.4 + (index % 8) * 0.32
      scene.add(mote)
      return mote
    })

    const spacing = 2.15
    const slots = CAST.map((id, index) => {
      const slot = new THREE.Group()
      const x = (index - 1.5) * spacing
      const z = index === 0 || index === 3 ? 0.28 : 0
      slot.position.set(x, 0, z)
      slot.userData.phase = index * 0.85
      slot.userData.restX = x
      slot.userData.restZ = z
      const character = createWizard(id, 0.72)
      character.position.y = 0.08
      slot.add(character)
      scene.add(slot)
      return { id, slot, character }
    })

    const frameCamera = () => {
      if (!mount.current) return
      const { width, height } = mount.current.getBoundingClientRect()
      const aspect = width / Math.max(height, 1)
      camera.aspect = aspect
      camera.position.set(0, aspect < 1.05 ? 2.85 : 2.55, aspect < 1.05 ? 18.6 : 13.4)
      camera.lookAt(0, 1.15, 0)
      camera.updateProjectionMatrix()
      renderer.setSize(width, height)
    }
    frameCamera()
    window.addEventListener('resize', frameCamera)

    let frame = 0
    const animate = (time: number) => {
      for (const { id, slot, character } of slots) {
        danceWayfinder(id, slot, time)
        animateCharacter(character, time, slot.userData.phase)
      }
      halo.material.opacity = 0.22 + Math.sin(time * 0.0007) * 0.05
      for (const mote of motes) {
        const { radius, phase, speed, baseY } = mote.userData
        const angle = time * speed + phase
        mote.position.set(Math.cos(angle) * radius, baseY + Math.sin(time * 0.0009 + phase) * 0.2, Math.sin(angle) * radius * 0.55)
        mote.material.opacity = 0.22 + (Math.sin(time * 0.0015 + phase) + 1) * 0.2
      }
      renderer.render(scene, camera)
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', frameCamera)
      renderer.dispose()
      mount.current?.removeChild(renderer.domElement)
    }
  }, [])
  return <div ref={mount} className="entry-stage" aria-label="Four voxel wayfinders on the Voxels stage" />
}

function WorldCanvas({ wizard, style = defaultMothStyle, playerName = '', paused, onNear, onGold, onAction }: { wizard: WizardId; style?: MothStyle; playerName?: string; paused: boolean; onNear: (target: string | null) => void; onGold: (amount: number) => void; onAction: (target: string) => void }) {
  const mount = useRef<HTMLDivElement>(null)
  const keysRef = useRef(new Set<string>())
  const firstPerson = useRef(false)
  const pausedRef = useRef(paused)
  const nameRef = useRef(playerName)
  const handlers = useRef({ onNear, onGold, onAction })
  // The render loop reads changing props through refs: rebuilding the scene would
  // teleport the player back to spawn and drop their loot.
  useEffect(() => { handlers.current = { onNear, onGold, onAction } })
  useEffect(() => { nameRef.current = playerName }, [playerName])
  useEffect(() => { pausedRef.current = paused; if (paused) keysRef.current.clear() }, [paused])
  useEffect(() => {
    if (!mount.current) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#5d7180')
    scene.fog = new THREE.Fog('#5d7180', 58, 190)
    const camera = new THREE.PerspectiveCamera(66, 1, 0.1, 220)
    camera.position.set(6, 4.1, 13)
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    mount.current.appendChild(renderer.domElement)
    const hemi = new THREE.HemisphereLight('#d7e2df', '#263238', 3.4)
    scene.add(hemi)
    const moon = new THREE.DirectionalLight('#ffe0a2', 4.2)
    moon.position.set(-20, 30, 10)
    moon.castShadow = true
    moon.shadow.mapSize.set(1024, 1024)
    scene.add(moon)
    scene.add(createTown())
    const player = createWizard(wizard, 1.05, style)
    player.position.set(0, 0, 8)
    player.visible = !firstPerson.current
    scene.add(player)
    const nameplate = createCharacterNameplate()
    const refreshNameplate = () => {
      nameplate.setLabel(displayNameFor(nameRef.current, wizards[wizard].name), battleState.level, {
        maxed: battleState.maxed,
        accent: wizards[wizard].accent,
      })
    }
    player.updateMatrixWorld(true)
    refreshNameplate()
    nameplate.attachTo(player)
    serviceNpcs.forEach(({ name, x, z, color }) => scene.add(createNpc(name, x, z, true, color)))
    ambientNpcs.forEach(({ x, z }) => scene.add(createNpc(`townsperson-${x}-${z}`, x, z, false)))
    const wildscape = createWildscape()
    scene.add(wildscape)
    // The town's own footprints plus whatever the wildscape registered for its
    // pines and boulders. Click-to-move paths and shots are resolved against it.
    const nav = createNavGrid((wildscape.userData.obstacles as Obstacle[] | undefined) ?? [])
    nav.resolve(player.position)
    // Lets the pouch raycast drops onto NPCs and the map read the player's pose.
    const unregisterWorld = registerWorld({ scene, camera, canvas: renderer.domElement, player })
    const keys = keysRef.current
    keys.clear()
    let yaw = 0.25
    /* Camera distance. The wheel moves `zoomWanted`; `zoom` chases it so the
     * view glides instead of snapping, and both stay inside the clamp so the
     * camera can never end up inside the wayfinder or under the street. */
    let zoom = 9.5
    let zoomWanted = zoom
    let last = performance.now()
    let nearbyNpc: string | null = null
    let walking = false
    const drops: THREE.Group[] = []

    /* --- hunting ------------------------------------------------------------
     * Wildlife, abilities and the player's health live in their own modules;
     * this block is only the wiring between them and the render loop. */
    const dropGold = (at: THREE.Vector3, coins: number[], spread: number) => {
      coins.forEach((gold, index) => {
        const angle = (index / coins.length) * Math.PI * 2 + Math.random()
        const drop = createGoldDrop(
          at.x + Math.cos(angle) * spread,
          0.22,
          at.z + Math.sin(angle) * spread,
          gold,
        )
        scene.add(drop)
        drops.push(drop)
      })
    }
    // Assigned once the wildlife it damages exists; the callbacks below only
    // ever run inside the render loop, long after that.
    let battle: BattleSystem | null = null
    const vitals = createVitals(killer => {
      // Death forfeits a slice of carried gold onto the ground, where anyone
      // can pick it up again — the same rule as every other drop in town.
      const lost = debitDeath(killer)
      if (lost > 0) {
        const count = Math.min(6, lost)
        const coins = Array.from({ length: count }, (_, index) =>
          Math.floor(lost / count) + (index < lost % count ? 1 : 0),
        )
        dropGold(player.position.clone(), coins, 1.1)
        handlers.current.onGold(-lost)
      }
      huntState.death = { killer, goldDroppedBaseUnits: lost, at: Date.now() }
      pingHunt()
      wildlife.clearAggro()
      battle?.onPlayerDied()
      player.position.set(0, 0, 8)
      vitals.reset(performance.now())
      battle?.onRespawn()
    })
    const wildlife = createWildlife(scene, {
      onKill: kill => {
        // wildlife.kill() is reachable only once per animal, so gold, the
        // ledger entry and the XP award below all happen exactly once.
        recordKill(kill.label, kill.goldBaseUnits)
        dropGold(kill.position, kill.coins, 0.55 + kill.coins.length * 0.12)
        battle?.awardXp(killXp(kill.species, progressFor(wizard).level))
        huntState.kills += 1
        pingHunt()
      },
      onPlayerDamage: (amount, species, from) => {
        const away = player.position.clone().sub(from)
        vitals.damage(amount, away, species.label, performance.now())
        battle?.onPlayerHurt()
        huntState.hurtAt = performance.now()
      },
    })
    battle = createBattle({ scene, camera, player, wizard, wildlife, nav, vitals })
    const unregisterCommands = registerBattleCommands({
      upgrade: slot => battle?.upgrade(slot) ?? false,
      setQuickCast: on => battle?.setQuickCast(on),
      cancelAim: () => battle?.cancel(),
    })
    resetHuntState(wizard, vitals.maxHp)

    /* --- pointing ------------------------------------------------------
     * Everything the player aims at comes from one free cursor: no pointer
     * lock anywhere. Each frame the cursor is resolved into a ground point
     * (for move orders and ground-targeted spells) and, separately, into the
     * animal under it (for attack orders and unit-targeted spells). */
    const pointer = new THREE.Vector2(0, 0)
    const raycaster = new THREE.Raycaster()
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const INSPECT_RANGE = 60
    let cursorGround: THREE.Vector3 | null = null
    let hover: ReturnType<typeof wildlife.nearest> = null
    let hoverKey: string | null = null

    const resolveCursor = () => {
      raycaster.setFromCamera(pointer, camera)
      const behind = camera.position.distanceTo(player.position)
      // An exact hit first, then a small forgiving cone, which is what makes
      // clicking a chicken at range possible at all. The cone is what keeps
      // "right-click the enemy" reliable when it is standing against a wall
      // or half off the edge of the screen.
      hover =
        wildlife.pick(raycaster, INSPECT_RANGE + behind) ??
        wildlife.aimAssist(raycaster.ray.origin, raycaster.ray.direction, 26 + behind, 0.045)
      const point = new THREE.Vector3()
      // A ray aimed at the sky never meets the ground plane, and a move order
      // to nowhere is worse than no order at all.
      cursorGround = raycaster.ray.intersectPlane(groundPlane, point) ? point : null
      if (cursorGround && Math.abs(cursorGround.x) > 120) cursorGround = null
      if (cursorGround && Math.abs(cursorGround.z) > 120) cursorGround = null
    }

    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    }

    /* --- input ---------------------------------------------------------
     * The mouse moves you. Right-click walkable ground walks there, right-click
     * an enemy attacks it, left-click selects or confirms an aimed spell,
     * Q/W/E/R are abilities, A then click is attack-move, S stops, F interacts.
     * The wheel zooms, middle-drag or shift-drag or the arrow keys turn the
     * camera, and Space swings it back behind the wayfinder. The cursor is
     * never captured. */
    const pressedAt = new Map<string, number>()
    let orbiting = false
    let keyboardMove = readKeyboardMove()
    const castSlot = (slot: 'Q' | 'W' | 'E' | 'R') => battle?.pressSlot(slot, { cursorGround, hover })
    const command = (key: string) => {
      if (key === 'w') castSlot('W')
      else if (key === 'a') battle?.armAttackMove()
      else if (key === 's') battle?.pressStop()
    }
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (e.type === 'keyup') {
        keys.delete(key)
        const down = pressedAt.get(key)
        pressedAt.delete(key)
        if (!keyboardMove) return
        // Only while keyboard walking is switched on do W, A and S carry two
        // jobs: a flick is the command, a hold was the step.
        if (down === undefined || performance.now() - down > TAP_MS) return
        if (isTyping(e.target) || pausedRef.current) return
        command(key)
        return
      }
      if (isTyping(e.target) || pausedRef.current) return
      keys.add(key)
      if (e.repeat) return
      if (!pressedAt.has(key)) pressedAt.set(key, performance.now())
      primeAudio()
      if (key === 'v') { firstPerson.current = !firstPerson.current; player.visible = !firstPerson.current }
      const liveDuel = pvpState.duel
      if (liveDuel && liveDuel.phase === 'active' && (key === 'q' || key === 'w' || key === 'e' || key === 'r')) {
        const seq = (window as unknown as { __pvpSeq?: number }).__pvpSeq = ((window as unknown as { __pvpSeq?: number }).__pvpSeq ?? 0) + 1
        send({ t: 'input', duelId: liveDuel.duelId, seq, kind: 'cast', slot: key.toUpperCase() as 'Q' | 'W' | 'E' | 'R', x: cursorGround?.x, z: cursorGround?.z, sprinting: keys.has('shift') })
      } else if (!(liveDuel && liveDuel.phase !== 'ended')) {
        if (key === 'q') castSlot('Q')
        if (key === 'e') castSlot('E')
        if (key === 'r') castSlot('R')
        if (!keyboardMove) command(key)
      }
      // Arrow keys are the no-middle-button way to work the camera.
      if (key === 'arrowleft') yaw += 0.12
      if (key === 'arrowright') yaw -= 0.12
      if (key === 'arrowup') zoomWanted = Math.max(ZOOM_MIN, zoomWanted - 1.4)
      if (key === 'arrowdown') zoomWanted = Math.min(ZOOM_MAX, zoomWanted + 1.4)
      if (key === ' ') {
        // Recentre: swing the orbit round to sit behind whichever way the
        // character is actually facing.
        e.preventDefault()
        yaw = player.rotation.y + Math.PI
      }
      if (key === 'escape' && battle?.cancel()) markEscapeConsumed()
      if (key === 'f' && nearbyNpc && !nearbyNpc.startsWith('ANIMAL:')) handlers.current.onAction(nearbyNpc)
    }
    const releaseKeys = () => { keys.clear(); pressedAt.clear(); orbiting = false }
    const onMouseMove = (e: MouseEvent) => {
      // Shift-drag is the alternative to the middle button, which plenty of
      // mice and every trackpad make awkward.
      if (orbiting || (e.buttons === 1 && e.shiftKey)) yaw -= e.movementX * 0.004
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    }
    // Bound to the canvas, never to the document: a click on the HUD, a panel
    // or the pouch can therefore never also issue a world command, and a pouch
    // drag that ends over the world never fires one either, because only the
    // press is listened for and that press happened on the pouch.
    const onCanvasDown = (e: MouseEvent) => {
      if (pausedRef.current) return
      primeAudio()
      if (e.button === 1) {
        e.preventDefault()
        orbiting = true
        return
      }
      // Shift plus the left button is a camera drag, not a selection.
      if (e.button === 0 && e.shiftKey) return
      resolveCursor()
      const remoteId = pickRemote(raycaster)
      if (e.button === 0 && remoteId && !isDuelLocked()) {
        inspectRemote(remoteId)
        return
      }
      const duel = pvpState.duel
      if (duel && duel.phase !== 'ended') {
        if (duel.phase !== 'active') return
        const seq = (window as unknown as { __pvpSeq?: number }).__pvpSeq = ((window as unknown as { __pvpSeq?: number }).__pvpSeq ?? 0) + 1
        if (e.button === 2 && cursorGround) {
          send({ t: 'input', duelId: duel.duelId, seq, kind: 'move', x: cursorGround.x, z: cursorGround.z, sprinting: keys.has('shift') })
        } else if (e.button === 0) {
          send({ t: 'input', duelId: duel.duelId, seq, kind: 'attack', sprinting: keys.has('shift') })
        }
        return
      }
      const target = hover && hover.state !== 'dead' ? hover : null
      if (e.button === 0) {
        battle?.primaryClick(cursorGround, target)
      } else if (e.button === 2) {
        battle?.secondaryClick(cursorGround, target)
      }
    }
    const onMouseUp = (e: MouseEvent) => { if (e.button === 1) orbiting = false }
    // Canvas-only and non-passive: the wheel over the pouch, the journal or the
    // map scrolls that panel and the world never hears about it.
    const onWheel = (e: WheelEvent) => {
      if (pausedRef.current) return
      e.preventDefault()
      const step = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaY
      zoomWanted = THREE.MathUtils.clamp(zoomWanted + step * ZOOM_STEP * zoomWanted, ZOOM_MIN, ZOOM_MAX)
    }
    const blockMenu = (e: MouseEvent) => e.preventDefault()
    window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKey)
    window.addEventListener('blur', releaseKeys); document.addEventListener('visibilitychange', releaseKeys)
    document.addEventListener('mousemove', onMouseMove); document.addEventListener('mouseup', onMouseUp)
    renderer.domElement.addEventListener('contextmenu', blockMenu)
    renderer.domElement.addEventListener('mousedown', onCanvasDown)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false })
    const unregisterKeyboardMove = onKeyboardMoveChange(on => { keyboardMove = on })
    const resize = () => { if (!mount.current) return; const { width, height } = mount.current.getBoundingClientRect(); camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height) }
    resize(); window.addEventListener('resize', resize)
    let raf = 0
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05); last = now
      const held = (...names: string[]) => !pausedRef.current && names.some(name => keys.has(name))
      const kit = battle?.kit
      const speed = held('shift') ? kit?.stats.runSpeed ?? 5.6 : kit?.stats.moveSpeed ?? 3.2
      // Off by default: the world is walked with the mouse. The arrow keys are
      // camera controls now, so they are deliberately not movement aliases.
      const dir = keyboardMove
        ? new THREE.Vector3((held('d') ? 1 : 0) - (held('a') ? 1 : 0), 0, (held('s') ? 1 : 0) - (held('w') ? 1 : 0))
        : new THREE.Vector3()
      const manual = dir.lengthSq() > 0 && vitals.hp > 0
      if (manual) {
        dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
        // Slide rather than step: walking into a wall at an angle now runs
        // along it instead of straight through it.
        nav.slide(player.position, dir.x * speed * dt, dir.z * speed * dt)
        player.rotation.y = Math.atan2(dir.x, dir.z)
      }
      // A hit shoves you: the impulse decays inside vitals.update.
      if (vitals.impulse.lengthSq() > 0.0004) {
        nav.slide(player.position, vitals.impulse.x * dt, vitals.impulse.z * dt)
      }
      if (!pausedRef.current) resolveCursor()
      const dueling = isDuelLocked()
      const advanced = dueling ? undefined : battle?.update(dt, now, {
        cursorGround,
        hover: hover && hover.state !== 'dead' ? hover : null,
        manualMove: manual,
        // Same live key set the WASD branch already reads — a ref, not a
        // captured boolean — so Shift mid-path switches walk ↔ run this frame.
        sprinting: held('shift'),
        safe: isSafeZone(player.position.x, player.position.z),
        paused: pausedRef.current,
      })
      walking = manual || !!advanced?.moved
      refreshNameplate()
      nav.resolve(player.position)
      player.position.x = THREE.MathUtils.clamp(player.position.x, -96, 96); player.position.z = THREE.MathUtils.clamp(player.position.z, -96, 96)
      player.position.y = walking ? Math.abs(Math.sin(now * 0.012 * (speed / 3.2))) * 0.045 : Math.sin(now * 0.002) * 0.012
      animateCharacter(player, now)
      scene.children.forEach(o => {
        if (o.userData.phase === undefined) return
        o.position.y = Math.sin(now * 0.0018 + o.userData.phase) * (o.userData.interactive ? 0.018 : 0.035)
        o.rotation.y += Math.sin(now * 0.001 + o.userData.phase) * 0.0007
        animateCharacter(o, now, o.userData.phase)
      })
      const target = player.position.clone().add(new THREE.Vector3(0, 1.6, 0))
      if (firstPerson.current) { camera.position.copy(target); camera.position.y += 1.1; camera.rotation.set(0, yaw, 0) }
      else {
        // Ease toward the wanted distance rather than snapping to it, and lift
        // the lens as it pulls back so the far end of the range reads as a
        // tactical overhead rather than a view of the rooftops edge-on.
        zoom += (zoomWanted - zoom) * Math.min(1, dt * 9)
        const height = 0.6 + zoom * 0.43
        const ahead = Math.min(zoom * 0.81, 7)
        const desired = target.clone().add(new THREE.Vector3(Math.sin(yaw) * zoom, height, Math.cos(yaw) * zoom))
        // Never below the street, and never inside the wayfinder's own hat.
        desired.y = Math.max(desired.y, 1.4)
        const streetLook = target.clone().add(new THREE.Vector3(-Math.sin(yaw) * ahead, 0.1, -Math.cos(yaw) * ahead))
        camera.position.lerp(desired, 0.18)
        camera.position.y = Math.max(camera.position.y, 1.4)
        camera.lookAt(streetLook)
      }
      drops.forEach(drop => {
        drop.rotation.y += dt * 2
        drop.position.y = 0.22 + Math.sin(now * 0.004 + drop.position.x) * 0.06
        if (drop.visible && drop.position.distanceTo(player.position) < 2.3) {
          drop.visible = false
          const gold = creditPickup((drop.userData.gold as number) ?? 1)
          battle?.floatText(`+${gold}`, drop.position.clone().setY(1.4), '#f0b84d')
          handlers.current.onGold(gold)
          scene.remove(drop)
        }
      })

      /* --- hunt: wildlife, abilities, vitals, HUD ------------------------- */
      const safe = isSafeZone(player.position.x, player.position.z)
      if (!isDuelLocked()) vitals.update(dt, now, safe)
      wildlife.update(dt, now, player.position, camera, !isDuelLocked() && vitals.hp > 0 && !vitals.isInvulnerable(now))
      updatePvpWorld(scene, dt, now, {
        x: player.position.x,
        z: player.position.z,
        facing: player.rotation.y,
        anim: walking ? (held('shift') ? 'run' : 'walk') : 'idle',
        sprinting: held('shift'),
      })
      if (pvpState.playerId) applyDuelPose(player, pvpState.playerId)
      animateWildscape(wildscape, now)
      // The plate follows the committed target first and the cursor second, so
      // it stops flickering the moment you actually pick a fight.
      const engaged = battle?.attackOrderTarget() ?? battle?.selectedTarget() ?? null
      const spotted = engaged && engaged.state !== 'dead' ? engaged : hover && hover.state !== 'dead' ? hover : null
      if (spotted) {
        huntState.target = {
          species: spotted.species.id,
          label: spotted.species.label,
          threat: spotted.species.threat,
          hp: spotted.hp,
          maxHp: spotted.species.maxHp,
          goldBaseUnits: spotted.species.goldBaseUnits,
          distance: spotted.group.position.distanceTo(player.position),
        }
      }
      else huntState.target = null
      // Only re-render the HUD when the plate's identity changes; the numbers
      // inside it are read from this same object on the HUD's own frame.
      const plateKey = spotted ? spotted.species.id : null
      if (plateKey !== hoverKey) { hoverKey = plateKey; pingHunt() }
      huntState.hp = vitals.hp
      huntState.maxHp = vitals.maxHp
      huntState.safe = safe
      huntState.invulnerable = vitals.isInvulnerable(now)
      huntState.aggro = wildlife.aggroCount()
      const huntDest = compassHuntRegion(progressFor(wizard).level)
      const toHunt = new THREE.Vector3(huntDest.x - player.position.x, 0, huntDest.z - player.position.z)
      huntState.compassDistance = toHunt.length()
      huntState.compassLabel = huntDest.label
      const view = camera.getWorldDirection(new THREE.Vector3())
      // Negated: bearings measured from +z grow the opposite way round to CSS
      // rotation, so without this the needle points away from the destination.
      huntState.compassDegrees = -THREE.MathUtils.radToDeg(Math.atan2(toHunt.x, toHunt.z) - Math.atan2(view.x, view.z))

      const animal = wildlife.nearest(player.position, INTERACT_RANGE)
      const found = animal ? `ANIMAL:${animal.species.label}` : scene.children.find(o => o.userData.npc && o.position.distanceTo(player.position) < INTERACT_RANGE)?.userData.npc ?? null
      if (found !== nearbyNpc) { nearbyNpc = found; handlers.current.onNear(found) }
      renderer.render(scene, camera); raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const probe = window as unknown as { __wally?: unknown }
    if (import.meta.env.DEV) {
      probe.__wally = {
        player, camera, renderer, keys, isFirstPerson: () => firstPerson.current,
        wildlife, vitals, speciesSpecs, isInTown, isSafeZone, huntState,
        killXp, compassHuntRegion, highHuntArea,
        nav, battle, battleState, progress: () => progressFor(wizard),
        nameplate: nameplate.object,
        resolveCursor, getHover: () => hover, getCursorGround: () => cursorGround,
        // Drives the camera-relative pointer without a real mouse, so the
        // verification scripts can aim at a world point directly.
        setPointer: (x: number, y: number) => { pointer.set(x, y); resolveCursor() },
        camState: () => ({ zoom, zoomWanted, yaw, keyboardMove }),
        aimAt: (target: THREE.Vector3 | { x: number; z: number }) => {
          const v = target instanceof THREE.Vector3 ? target : new THREE.Vector3(target.x, 0.6, target.z)
          const projected = v.clone().project(camera)
          pointer.set(projected.x, projected.y)
          resolveCursor()
          return { hover: hover?.species.id ?? null, ground: cursorGround?.toArray() ?? null }
        },
      }
    }
    return () => {
      cancelAnimationFrame(raf); keys.clear(); if (import.meta.env.DEV) delete probe.__wally; unregisterWorld()
      window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', releaseKeys); document.removeEventListener('visibilitychange', releaseKeys)
      window.removeEventListener('resize', resize)
      document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp)
      renderer.domElement.removeEventListener('mousedown', onCanvasDown)
      renderer.domElement.removeEventListener('wheel', onWheel)
      renderer.domElement.removeEventListener('contextmenu', blockMenu)
      unregisterCommands(); unregisterKeyboardMove()
      huntState.active = false; wildlife.dispose(); battle?.dispose(); nameplate.dispose(); disposePvpWorld(scene)
      renderer.dispose(); mount.current?.removeChild(renderer.domElement)
    }
  }, [wizard, style])
  return <div ref={mount} className="world-canvas" aria-label="Voxels explorable town" />
}

function App() {
  const [entered, setEntered] = useState(false)
  const [wizard, setWizard] = useState<WizardId>('MOTH')
  const [playerName, setPlayerName] = useState(wizards.MOTH.name)
  const [style, setStyle] = useState<MothStyle>(defaultMothStyle)
  const [panel, setPanel] = useState<Panel>(null)
  const [npc, setNpc] = useState<string | null>(null)
  const [task, setTask] = useState<'idle' | 'queued' | 'running' | 'delivered'>('idle')
  const [receipt, setReceipt] = useState(false)
  const [toast, setToast] = useState('')
  const [gold, setGold] = useState(0)
  const [tab, setTab] = useState<'select' | 'preview' | 'world'>('select')
  // Lets the wallet panel read the live character and write a loaded save back,
  // without threading four setters through the popup. Re-registers on change so
  // `read` never returns a stale snapshot.
  useEffect(() => registerPlayer({
    read: () => ({ character: wizard, style, playerName, gold }),
    apply: saved => {
      if (isDuelLocked()) return false
      setWizard(saved.character)
      setStyle(saved.style)
      setPlayerName(saved.playerName)
      setGold(saved.gold)
    },
  }), [wizard, style, playerName, gold])
  useEffect(() => {
    const probe = window as unknown as { __pvpLocked?: () => boolean }
    probe.__pvpLocked = () => isDuelLocked()
    return () => { delete probe.__pvpLocked }
  }, [])
  useEffect(() => {
    if (tab !== 'world') return
    const progress = progressFor(wizard)
    startPvp(playerName || wizards[wizard].name, { character: wizard, style, level: progress.level, ranks: progress.ranks })
    return () => stopPvp()
  }, [tab])
  useEffect(() => {
    if (tab !== 'world' || isDuelLocked()) return
    const progress = progressFor(wizard)
    refreshPvpIdentity(playerName || wizards[wizard].name, { character: wizard, style, level: progress.level, ranks: progress.ranks })
  }, [tab, wizard, style, playerName])
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!entered) return
      const el = event.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const key = event.key.toLowerCase()
      // The world gets Escape first: it cancels an aim or an order, and only
      // when it had nothing to cancel does the key reach the panels.
      if (key === 'escape') { if (!escapeWasConsumed()) setPanel(null); return }
      const panels: Record<string, Panel> = { m: 'map', j: 'journal', k: 'wallet', o: 'settings' }
      if (panels[key]) { event.preventDefault(); setPanel(panels[key]) }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [entered])
  useEffect(() => { if (localStorage.getItem('wally-receipt')) setReceipt(true) }, [])
  const cycleWizard = (step: number) => {
    const ids = Object.keys(wizards) as WizardId[]
    const index = ids.indexOf(wizard)
    setWizard(ids[(index + step + ids.length) % ids.length])
  }
  // Each archetype names its own four slots, so the rows are driven by the
  // character rather than hard-coded to HAT / ROBE / FAMILIAR / ACCESSORY.
  const cycle = (key: ReturnType<typeof styleSlots>[number]['key'], step: number) =>
    setStyle(current => cycleStyle(wizard, current, key, step))
  const doTask = () => {
    setTask('queued'); setToast('Budget reserved · 2 demo credits')
    window.setTimeout(() => setTask('running'), 900)
    window.setTimeout(() => { setTask('delivered'); setReceipt(true); localStorage.setItem('wally-receipt', 'true'); setToast('Report delivered · receipt saved to your journal') }, 2500)
  }
  if (!entered && tab === 'select') return (
    <main className="entry">
      <div className="entry-copy">
        <div className="eyebrow">SINGLE-PLAYER DEMO</div>
        <h1>Voxels</h1>
        <p>Voxels is a playable wallet: walk a voxel town with the mouse, and the pouch holds your gold and tokens. Agents live there as a guide, shops, and services — useful, not flavor. You can hand items and gold to people in the world. Private transfers are the longer-term idea, not a live feature here.</p>
        <button className="primary" onClick={() => setEntered(true)}>Enter world <span>→</span></button>
        <div className="entry-foot">
          <span>No real funds</span>
          <FundsBadge variant="foot" />
        </div>
      </div>
      <div className="entry-scene">
        <EntryStage />
      </div>
    </main>
  )
  if (entered && tab === 'select') return <main className="select"><header><div className="brand">VOXELS</div><FundsBadge variant="dot" /></header><div className="select-layout"><section className="menu-panel"><div className="eyebrow">CREATE YOUR WAYFINDER</div><h2>Name your<br />character.</h2><p className="muted">Start with {wizards[wizard].name}, the selected wayfinder. Shape the details,<br />then carry your look into the town.</p><label className="name-label" htmlFor="wayfinder-name">NAME YOUR CHARACTER:</label><input id="wayfinder-name" className="name-input" value={playerName} onChange={event => setPlayerName(event.target.value.slice(0, 24))} placeholder="Write any name" autoComplete="off" /><div className="arrow-options"><div className="arrow-choice character-choice"><label>CHARACTER</label><button onClick={() => cycleWizard(-1)} aria-label="Previous character">←</button><div><strong>{wizards[wizard].name}</strong><small>{wizards[wizard].role}</small></div><button onClick={() => cycleWizard(1)} aria-label="Next character">→</button></div>{styleSlots(wizard).map(slot => <div className="arrow-choice" key={slot.key}><label>{slot.label}</label><button onClick={() => cycle(slot.key, -1)} aria-label={`Previous ${slot.key}`}>←</button><div><strong>{styleLabel(wizard, style, slot.key).label}</strong><small>{styleLabel(wizard, style, slot.key).note}</small></div><button onClick={() => cycle(slot.key, 1)} aria-label={`Next ${slot.key}`}>→</button></div>)}</div><button className="primary" onClick={() => setTab('preview')}>Continue with {playerName || wizards[wizard].name} <span>→</span></button></section><section className="selection-art"><div className="selection-grid" /><CharacterPreview wizard={wizard} style={style} /><div className="art-caption"><span>WAYFINDER {Object.keys(wizards).indexOf(wizard) + 1} / 4</span><strong>{playerName || wizards[wizard].name}</strong><small>{wizards[wizard].name} · {wizards[wizard].role}</small></div></section></div></main>
  if (entered && tab === 'preview') return <main className="preview"><div className="preview-left"><button className="back" onClick={() => setTab('select')}>← Back to archetypes</button><div className="eyebrow">WAYFINDER SELECTED</div><h2>{playerName || wizards[wizard].name}</h2><p>{wizards[wizard].name} · {wizards[wizard].desc}</p><div className="preview-facts"><span><b>01</b> Equal permissions</span><span><b>02</b> Cosmetic identity</span><span><b>03</b> Demo-ready</span></div><button className="primary" onClick={() => { setEntered(true); setTab('world') }}>Enter Voxels <span>→</span></button></div><div className="preview-stage"><div className="stage-stars" /><CharacterPreview wizard={wizard} style={style} /><div className="preview-label"><span>ARCHETYPE {Object.keys(wizards).indexOf(wizard) + 1} / 4</span><strong>{wizards[wizard].role}</strong></div></div></main>
  if (!entered) return null
  const action = (target: string) => { if (target.startsWith('ANIMAL:')) { setToast('Right-click the animal to attack it · loot drops on the ground for anyone') } else if (target.startsWith('LYRA')) setPanel('journal'); else setToast(`${target} is preparing a demo service.`) }
  const talkable = npc && !npc.startsWith('ANIMAL:') ? npc : null
  return <main className="game"><WorldCanvas wizard={wizard} style={style} playerName={playerName} paused={panel !== null} onNear={setNpc} onGold={amount => setGold(value => Math.max(0, value + amount))} onAction={action} /><HuntHud wizard={wizard} /><CombatHud wizard={wizard} style={style} /><PvpOverlay /><MainnetWarningBanner /><div className="hud"><div className="topbar"><div className="avatar-chip"><span style={{ background: wizards[wizard].accent }} />{playerName || wizards[wizard].name}<small>{wizards[wizard].name} WAYFINDER</small></div><div className="gold-chip">✦ {gold} GOLD <small>DEMO LOOT</small></div><FundsBadge variant="chip" /><div className="fps-chip">WORLD 01 <span>●</span></div></div><div className="minimap"><div className="map-ring"><i /><b /><em /></div><small>OLD TOWN LOOP</small></div><div className="bottom-nav">{[['map','Map'],['journal','Journal'],['wallet','Wallet'],['settings','Settings']].map(([id, label]) => <button key={id} onClick={() => setPanel(id as Panel)}><span>{id === 'map' ? '⌖' : id === 'journal' ? '▤' : id === 'wallet' ? '◇' : '⚙'}</span>{label}</button>)}</div>{talkable && <button className="interact" onClick={() => { if (talkable.startsWith('LYRA')) setPanel('journal'); else setToast(`${talkable} is preparing a demo service.`) }}>F <span>Talk to</span> {talkable}</button>}{panel === 'wallet' && <Popup variant="pouch" eyebrow="THE HEARTH · PRIVATE" title="Your pouch" onClose={() => setPanel(null)}><WalletPouch gold={gold} onGoldChange={setGold} nearbyNpc={npc} onToast={setToast} /><WalletSolanaPanel /></Popup>}{panel === 'map' && <Popup variant="chart" size="wide" eyebrow="VOXELS · DISTRICT 01" title="Old Town Loop" note={`${townLayout.ground}m × ${townLayout.ground}m · one grid square is 8m · surveyed from the live town layout`} onClose={() => setPanel(null)}><WorldMap /></Popup>}{panel === 'journal' && <Popup variant="book" eyebrow="THE ARCHIVE · LYRA" title="Your journal" onClose={() => setPanel(null)}><JournalPanel task={task} receipt={receipt} onApprove={doTask} /></Popup>}{panel === 'settings' && <Popup variant="plate" eyebrow="PREFERENCES" title="Control plate" onClose={() => setPanel(null)}><SettingsPanel /></Popup>}{toast && <div className="toast" onClick={() => setToast('')}>{toast}</div>}</div></main>
}

createRoot(document.getElementById('root')!).render(<App />)
