/// <reference types="vite/client" />
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { animateCharacter, createWizard, defaultMothStyle, mothStyleOptions, wizards } from './characters'
import type { MothStyle, WizardId } from './characters'
import { createTownsfolk, npcAccent, placeNpcLabel } from './npcs'
import { Popup } from './Popup'
import { WalletPouch } from './Wallet'
import { WorldMap } from './WorldMap'
import { ambientNpcs, buildingSpecs, perimeterTrees, serviceNpcs, townLayout } from './townData'
import type { BuildingSpec } from './townData'
import { registerWorld } from './worldBridge'
import { createWildlife, huntingArea, isInTown, isSafeZone, speciesSpecs } from './wildlife'
import { animateWildscape, createWildscape } from './wildscape'
import { createCombat, createVitals } from './combat'
import { huntState, pingHunt, resetHuntState } from './huntStore'
import { HuntHud } from './huntHud'
import { creditPickup, debitDeath, recordKill } from './rewards'

import './styles.css'

type Panel = 'journal' | 'wallet' | 'settings' | 'map' | null

// Prompts and the E action must share one radius, otherwise E silently does nothing.
const INTERACT_RANGE = 5

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
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.12, 12), material('#263848'))
    floor.position.y = -0.08
    floor.receiveShadow = true
    scene.add(floor)
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

function WorldCanvas({ wizard, style = defaultMothStyle, paused, onNear, onGold, onAction }: { wizard: WizardId; style?: MothStyle; paused: boolean; onNear: (target: string | null) => void; onGold: (amount: number) => void; onAction: (target: string) => void }) {
  const mount = useRef<HTMLDivElement>(null)
  const keysRef = useRef(new Set<string>())
  const firstPerson = useRef(false)
  const pausedRef = useRef(paused)
  const handlers = useRef({ onNear, onGold, onAction })
  // The render loop reads changing props through refs: rebuilding the scene would
  // teleport the player back to spawn and drop their loot.
  useEffect(() => { handlers.current = { onNear, onGold, onAction } })
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
    serviceNpcs.forEach(({ name, x, z, color }) => scene.add(createNpc(name, x, z, true, color)))
    ambientNpcs.forEach(({ x, z }) => scene.add(createNpc(`townsperson-${x}-${z}`, x, z, false)))
    const wildscape = createWildscape()
    scene.add(wildscape)
    // Lets the pouch raycast drops onto NPCs and the map read the player's pose.
    const unregisterWorld = registerWorld({ scene, camera, canvas: renderer.domElement, player })
    const keys = keysRef.current
    keys.clear()
    let yaw = 0.25
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
      player.position.set(0, 0, 8)
      vitals.reset(performance.now())
    })
    const wildlife = createWildlife(scene, {
      onKill: kill => {
        recordKill(kill.label, kill.goldBaseUnits)
        dropGold(kill.position, kill.coins, 0.55 + kill.coins.length * 0.12)
        huntState.kills += 1
        pingHunt()
      },
      onPlayerDamage: (amount, species, from) => {
        const away = player.position.clone().sub(from)
        vitals.damage(amount, away, species.label, performance.now())
        huntState.hurtAt = performance.now()
      },
    })
    const combat = createCombat(scene, wizard, {
      applyDamage: (centre, radius, damage) => wildlife.damageIn(centre, radius, damage, performance.now()),
      pull: (centre, radius, strength) => wildlife.pull(centre, radius, strength),
    })
    resetHuntState(wizard, vitals.maxHp)
    const pointer = new THREE.Vector2(0, 0)
    const raycaster = new THREE.Raycaster()
    let aimed: ReturnType<typeof wildlife.nearest> = null
    let aimedKey: string | null = null
    /**
     * Aim follows the free cursor: an exact hit first, then a forgiving cone.
     * Distances are budgeted from the camera, which sits well behind the
     * player, so a short-range ability can still inspect what it is pointing
     * at. Reach is enforced later, when the ability resolves.
     */
    const INSPECT_RANGE = 46
    let aimHeldUntil = 0
    const resolveAim = () => {
      raycaster.setFromCamera(pointer, camera)
      const behind = camera.position.distanceTo(player.position)
      const found =
        wildlife.pick(raycaster, INSPECT_RANGE + behind) ??
        wildlife.aimAssist(raycaster.ray.origin, raycaster.ray.direction, combat.spec.range + behind, 0.12)
      if (found) {
        aimHeldUntil = performance.now() + 1500
        return found
      }
      // Animals move, and a plate that vanishes the moment your quarry steps
      // aside makes the hunt feel like a fight with the cursor. Hold briefly.
      if (aimed && aimed.state !== 'dead' && performance.now() < aimHeldUntil) return aimed
      return null
    }
    const attack = () => {
      if (pausedRef.current || vitals.hp <= 0) return false
      const now = performance.now()
      if (!combat.ready(now)) return false
      const target = aimed && aimed.state !== 'dead' ? aimed.group.position.clone().setY(aimed.species.height * 0.55) : null
      // No target under the cursor: fire along the camera's forward axis, which
      // is the opposite of the orbit angle the camera sits at.
      const facing = target ? Math.atan2(target.x - player.position.x, target.z - player.position.z) : yaw + Math.PI
      player.rotation.y = facing
      return combat.attack(player.position, facing, target, now)
    }
    const huntNearby = () => {
      const near = wildlife.nearest(player.position, INTERACT_RANGE + 1)
      if (near) aimed = near
      return attack()
    }
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    }
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      // Releases are always honoured, otherwise a key can stay latched down forever.
      if (e.type === 'keyup') { keys.delete(key); return }
      if (isTyping(e.target) || pausedRef.current) return
      keys.add(key)
      if (e.repeat) return
      if (key === 'v') { firstPerson.current = !firstPerson.current; player.visible = !firstPerson.current }
      // F attacks whatever the cursor is on; it never touches the pointer lock.
      if (key === 'f') attack()
      if (key === 'e' && nearbyNpc) {
        if (nearbyNpc.startsWith('ANIMAL:')) huntNearby()
        else handlers.current.onAction(nearbyNpc)
      }
    }
    const releaseKeys = () => keys.clear()
    const onMouse = (e: MouseEvent) => { if (e.buttons === 2) yaw -= e.movementX * 0.003 }
    // Aim tracks the free cursor in NDC. No pointer lock anywhere in the hunt.
    const onAim = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    }
    const onAttackClick = (e: MouseEvent) => { if (e.button === 0) attack() }
    const blockMenu = (e: MouseEvent) => e.preventDefault()
    window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKey)
    window.addEventListener('blur', releaseKeys); document.addEventListener('visibilitychange', releaseKeys)
    document.addEventListener('mousemove', onMouse); renderer.domElement.addEventListener('contextmenu', blockMenu)
    document.addEventListener('mousemove', onAim); renderer.domElement.addEventListener('mousedown', onAttackClick)
    const resize = () => { if (!mount.current) return; const { width, height } = mount.current.getBoundingClientRect(); camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height) }
    resize(); window.addEventListener('resize', resize)
    let raf = 0
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05); last = now
      const held = (...names: string[]) => !pausedRef.current && names.some(name => keys.has(name))
      const speed = held('shift') ? 6 : 3.2
      const dir = new THREE.Vector3(
        (held('d', 'arrowright') ? 1 : 0) - (held('a', 'arrowleft') ? 1 : 0),
        0,
        (held('s', 'arrowdown') ? 1 : 0) - (held('w', 'arrowup') ? 1 : 0),
      )
      walking = dir.lengthSq() > 0
      if (walking) { dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw); player.position.addScaledVector(dir, speed * dt); player.rotation.y = Math.atan2(dir.x, dir.z); }
      player.position.x = THREE.MathUtils.clamp(player.position.x, -96, 96); player.position.z = THREE.MathUtils.clamp(player.position.z, -96, 96)
      player.position.y = walking ? Math.abs(Math.sin(now * 0.012 * (speed / 3.2))) * 0.045 : Math.sin(now * 0.002) * 0.012
      // A hit shoves you: the impulse decays inside vitals.update.
      if (vitals.impulse.lengthSq() > 0.0004) player.position.addScaledVector(vitals.impulse, dt)
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
        const desired = target.clone().add(new THREE.Vector3(Math.sin(yaw) * 6.8, 2.9, Math.cos(yaw) * 6.8))
        const streetLook = target.clone().add(new THREE.Vector3(-Math.sin(yaw) * 5.5, 0.1, -Math.cos(yaw) * 5.5))
        camera.position.lerp(desired, 0.12)
        camera.lookAt(streetLook)
      }
      drops.forEach(drop => {
        drop.rotation.y += dt * 2
        drop.position.y = 0.22 + Math.sin(now * 0.004 + drop.position.x) * 0.06
        if (drop.visible && drop.position.distanceTo(player.position) < 2.3) {
          drop.visible = false
          const gold = creditPickup((drop.userData.gold as number) ?? 1)
          combat.floatText(`+${gold}`, drop.position.clone().setY(1.4), '#f0b84d')
          handlers.current.onGold(gold)
          scene.remove(drop)
        }
      })

      /* --- hunt: wildlife, abilities, vitals, HUD ------------------------- */
      const safe = isSafeZone(player.position.x, player.position.z)
      vitals.update(dt, now, safe)
      wildlife.update(dt, now, player.position, camera, vitals.hp > 0 && !vitals.isInvulnerable(now))
      combat.update(dt, now, camera)
      animateWildscape(wildscape, now)
      if (!pausedRef.current) aimed = resolveAim()
      const spotted = aimed && aimed.state !== 'dead' ? aimed : null
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
      if (plateKey !== aimedKey) { aimedKey = plateKey; pingHunt() }
      huntState.hp = vitals.hp
      huntState.safe = safe
      huntState.invulnerable = vitals.isInvulnerable(now)
      huntState.aggro = wildlife.aggroCount()
      huntState.cooldownRatio = combat.cooldownRatio(now)
      const toHunt = new THREE.Vector3(huntingArea.x - player.position.x, 0, huntingArea.z - player.position.z)
      huntState.compassDistance = toHunt.length()
      const view = camera.getWorldDirection(new THREE.Vector3())
      // Negated: bearings measured from +z grow the opposite way round to CSS
      // rotation, so without this the needle points away from the wildwood.
      huntState.compassDegrees = -THREE.MathUtils.radToDeg(Math.atan2(toHunt.x, toHunt.z) - Math.atan2(view.x, view.z))

      const animal = wildlife.nearest(player.position, INTERACT_RANGE)
      const found = animal ? `ANIMAL:${animal.species.label}` : scene.children.find(o => o.userData.npc && o.position.distanceTo(player.position) < INTERACT_RANGE)?.userData.npc ?? null
      if (found !== nearbyNpc) { nearbyNpc = found; handlers.current.onNear(found) }
      renderer.render(scene, camera); raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const probe = window as unknown as { __wally?: unknown }
    if (import.meta.env.DEV) probe.__wally = { player, camera, renderer, keys, isFirstPerson: () => firstPerson.current, wildlife, vitals, combat, attack, speciesSpecs, isInTown, isSafeZone, huntState, resolveAim, getAimed: () => aimed }
    return () => {
      cancelAnimationFrame(raf); keys.clear(); if (import.meta.env.DEV) delete probe.__wally; unregisterWorld()
      window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', releaseKeys); document.removeEventListener('visibilitychange', releaseKeys)
      window.removeEventListener('resize', resize); document.removeEventListener('mousemove', onMouse)
      document.removeEventListener('mousemove', onAim); renderer.domElement.removeEventListener('mousedown', onAttackClick)
      renderer.domElement.removeEventListener('contextmenu', blockMenu)
      huntState.active = false; wildlife.dispose(); combat.dispose()
      renderer.dispose(); mount.current?.removeChild(renderer.domElement)
    }
  }, [wizard, style])
  return <div ref={mount} className="world-canvas" aria-label="Wally World explorable town" />
}

function App() {
  const [entered, setEntered] = useState(false)
  const [wizard, setWizard] = useState<WizardId>('MOTH')
  const [playerName, setPlayerName] = useState('Moth')
  const [style, setStyle] = useState<MothStyle>(defaultMothStyle)
  const [panel, setPanel] = useState<Panel>(null)
  const [npc, setNpc] = useState<string | null>(null)
  const [task, setTask] = useState<'idle' | 'queued' | 'running' | 'delivered'>('idle')
  const [receipt, setReceipt] = useState(false)
  const [toast, setToast] = useState('')
  const [gold, setGold] = useState(0)
  const [tab, setTab] = useState<'select' | 'preview' | 'world'>('select')
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!entered) return
      const el = event.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const key = event.key.toLowerCase()
      if (key === 'escape') { setPanel(null); return }
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
  const cycle = <K extends keyof MothStyle>(key: K, options: readonly { id: MothStyle[K]; label: string; note: string }[], step: number) => {
    const index = options.findIndex(option => option.id === style[key])
    const next = options[(index + step + options.length) % options.length]
    setStyle(current => ({ ...current, [key]: next.id }))
  }
  const doTask = () => {
    setTask('queued'); setToast('Budget reserved · 2 demo credits')
    window.setTimeout(() => setTask('running'), 900)
    window.setTimeout(() => { setTask('delivered'); setReceipt(true); localStorage.setItem('wally-receipt', 'true'); setToast('Report delivered · receipt saved to your journal') }, 2500)
  }
  if (!entered && tab === 'select') return <main className="entry">
    <div className="entry-scene"><div className="moon" /><div className="mountain m1" /><div className="mountain m2" /><div className="entry-town"><i /><i /><i /><i /><i /></div><div className="lantern"><span /></div><div className="bridge" /></div>
    <div className="entry-copy"><div className="eyebrow">A SMALL WORLD FOR USEFUL AGENTS</div><h1>WALLY<br /><em>WORLD</em></h1><p>Your wallet has a world.</p><button className="primary" onClick={() => setEntered(true)}>Enter the world <span>→</span></button><div className="entry-foot"><span>Single-player demo</span><span>Demo mode · no real funds</span></div></div>
  </main>
  if (entered && tab === 'select') return <main className="select"><header><div className="brand">WALLY <span>WORLD</span></div><div className="status-dot">DEMO MODE · NO REAL FUNDS</div></header><div className="select-layout"><section className="menu-panel"><div className="eyebrow">CREATE YOUR WAYFINDER</div><h2>Name your<br />character.</h2><p className="muted">Start with {wizard}, the selected wayfinder. Shape the details,<br />then carry your look into the town.</p><label className="name-label" htmlFor="wayfinder-name">NAME YOUR CHARACTER:</label><input id="wayfinder-name" className="name-input" value={playerName} onChange={event => setPlayerName(event.target.value.slice(0, 24))} placeholder="Write any name" autoComplete="off" /><div className="arrow-options"><div className="arrow-choice character-choice"><label>CHARACTER</label><button onClick={() => cycleWizard(-1)} aria-label="Previous character">←</button><div><strong>{wizard}</strong><small>{wizards[wizard].role}</small></div><button onClick={() => cycleWizard(1)} aria-label="Next character">→</button></div><div className="arrow-choice"><label>HAT</label><button onClick={() => cycle('hat', mothStyleOptions.hat, -1)} aria-label="Previous hat">←</button><div><strong>{mothStyleOptions.hat.find(option => option.id === style.hat)?.label}</strong><small>{mothStyleOptions.hat.find(option => option.id === style.hat)?.note}</small></div><button onClick={() => cycle('hat', mothStyleOptions.hat, 1)} aria-label="Next hat">→</button></div><div className="arrow-choice"><label>ROBE</label><button onClick={() => cycle('robe', mothStyleOptions.robe, -1)} aria-label="Previous robe">←</button><div><strong>{mothStyleOptions.robe.find(option => option.id === style.robe)?.label}</strong><small>{mothStyleOptions.robe.find(option => option.id === style.robe)?.note}</small></div><button onClick={() => cycle('robe', mothStyleOptions.robe, 1)} aria-label="Next robe">→</button></div><div className="arrow-choice"><label>FAMILIAR</label><button onClick={() => cycle('familiar', mothStyleOptions.familiar, -1)} aria-label="Previous familiar">←</button><div><strong>{mothStyleOptions.familiar.find(option => option.id === style.familiar)?.label}</strong><small>{mothStyleOptions.familiar.find(option => option.id === style.familiar)?.note}</small></div><button onClick={() => cycle('familiar', mothStyleOptions.familiar, 1)} aria-label="Next familiar">→</button></div><div className="arrow-choice"><label>ACCESSORY</label><button onClick={() => cycle('accessory', mothStyleOptions.accessory, -1)} aria-label="Previous accessory">←</button><div><strong>{mothStyleOptions.accessory.find(option => option.id === style.accessory)?.label}</strong><small>{mothStyleOptions.accessory.find(option => option.id === style.accessory)?.note}</small></div><button onClick={() => cycle('accessory', mothStyleOptions.accessory, 1)} aria-label="Next accessory">→</button></div></div><button className="primary" onClick={() => setTab('preview')}>Continue with {playerName || 'Moth'} <span>→</span></button></section><section className="selection-art"><div className="selection-grid" /><CharacterPreview wizard={wizard} style={style} /><div className="art-caption"><span>WAYFINDER 01 / 01</span><strong>{playerName || 'MOTH'}</strong><small>{wizard} · {wizards[wizard].role}</small></div></section></div></main>
  if (entered && tab === 'preview') return <main className="preview"><div className="preview-left"><button className="back" onClick={() => setTab('select')}>← Back to archetypes</button><div className="eyebrow">WAYFINDER SELECTED</div><h2>{playerName || 'Moth'}</h2><p>MOTH · {wizards.MOTH.desc}</p><div className="preview-facts"><span><b>01</b> Equal permissions</span><span><b>02</b> Cosmetic identity</span><span><b>03</b> Demo-ready</span></div><button className="primary" onClick={() => { setEntered(true); setTab('world') }}>Enter Wally World <span>→</span></button></div><div className="preview-stage"><div className="stage-stars" /><CharacterPreview wizard={wizard} style={style} /><div className="preview-label"><span>ARCHETYPE {Object.keys(wizards).indexOf(wizard) + 1} / 4</span><strong>{wizards[wizard].role}</strong></div></div></main>
  if (!entered) return null
  const action = (target: string) => { if (target.startsWith('ANIMAL:')) { setToast('E or left click to attack · loot drops on the ground for anyone') } else if (target.startsWith('LYRA')) setPanel('journal'); else setToast(`${target} is preparing a demo service.`) }
  return <main className="game"><WorldCanvas wizard={wizard} style={style} paused={panel !== null} onNear={setNpc} onGold={amount => setGold(value => Math.max(0, value + amount))} onAction={action} /><HuntHud wizard={wizard} /><div className="hud"><div className="topbar"><div className="avatar-chip"><span style={{ background: wizards[wizard].accent }} />{playerName || wizard}<small>{wizard} WAYFINDER</small></div><div className="gold-chip">✦ {gold} GOLD <small>DEMO LOOT</small></div><div className="demo-chip">DEMO · NO REAL FUNDS</div><div className="fps-chip">WORLD 01 <span>●</span></div></div><div className="minimap"><div className="map-ring"><i /><b /><em /></div><small>OLD TOWN LOOP</small></div><div className="controls">WASD move · SHIFT run · Right-drag look · E interact · V view · cursor unlocked</div><div className="bottom-nav">{[['map','Map'],['journal','Journal'],['wallet','Wallet'],['settings','Settings']].map(([id, label]) => <button key={id} onClick={() => setPanel(id as Panel)}><span>{id === 'map' ? '⌖' : id === 'journal' ? '▤' : id === 'wallet' ? '◇' : '⚙'}</span>{label}</button>)}</div>{npc && <button className="interact" onClick={() => { if (npc.startsWith('ANIMAL:')) action(npc); else if (npc.startsWith('LYRA')) setPanel('journal'); else setToast(`${npc} is preparing a demo service.`) }}>{npc.startsWith('ANIMAL:') ? 'E' : 'E'} <span>{npc.startsWith('ANIMAL:') ? 'Hunt' : 'Talk to'}</span> {npc.replace('ANIMAL:', '')}</button>}{panel === 'wallet' && <Popup label="Your pouch" onClose={() => setPanel(null)}><WalletPouch gold={gold} onGoldChange={setGold} nearbyNpc={npc} onToast={setToast} /></Popup>}{panel === 'map' && <Popup label="Map of Wally World" size="wide" onClose={() => setPanel(null)}><WorldMap /></Popup>}{(panel === 'journal' || panel === 'settings') && <div className="panel-backdrop" onClick={() => setPanel(null)}><section className="side-panel" onClick={e => e.stopPropagation()}><button className="close" onClick={() => setPanel(null)}>×</button>{panel === 'journal' && <><div className="eyebrow">THE ARCHIVE · LYRA</div><h2>Research,<br />made tangible.</h2><p>“I can map the quiet history of any place in town. Shall I make a sample report?”</p><div className="task-card"><div className="task-head"><span>DEMO SERVICE</span><b>{task === 'idle' ? 'READY' : task.toUpperCase()}</b></div><h3>Town history brief</h3><p>One-page summary of Wally World landmarks, delivered as a simulated artifact.</p><div className="task-meta"><span>2 demo credits</span><span>~ 3 seconds</span><span>Scripted demo</span></div><button className="primary full" disabled={task !== 'idle'} onClick={doTask}>{task === 'idle' ? 'Approve task · 2 credits' : task === 'delivered' ? 'Delivered ✓' : 'Task ' + task + '…'}</button></div>{receipt && <div className="receipt">✓ <div><strong>Receipt saved</strong><small>Simulated · no real funds · Journal</small></div></div>}</>}{panel === 'settings' && <><div className="eyebrow">PREFERENCES</div><h2>Make it<br />yours.</h2><label className="setting">Camera sensitivity <input type="range" defaultValue="40" /></label><label className="setting">Audio <input type="range" defaultValue="60" /></label><label className="toggle"><input type="checkbox" defaultChecked /> Reduced motion</label><p className="muted">The normal cursor stays available for Wallet, Journal, and Settings. Right-drag the world to look around.</p></>}</section></div>}{toast && <div className="toast" onClick={() => setToast('')}>{toast}</div>}</div></main>
}

createRoot(document.getElementById('root')!).render(<App />)
