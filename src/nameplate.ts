import * as THREE from 'three'

/* ------------------------------------------------------------------ *
 * Discreet in-world nameplates.
 *
 * Building signs in main.tsx are 3.6 units wide and NPC shop plates use
 * placeNpcLabel() at 2.4. This helper is the quieter mark for a wayfinder:
 * a small ink chip, no brass stroke, sized so a player never outshouts a shop.
 * Remote players can reuse the same object later.
 * ------------------------------------------------------------------ */

/** World width of the sprite. Keep well under the 2.4-unit NPC plates. */
const PLATE_WIDTH = 1.32
const CANVAS_W = 256
const CANVAS_H = 72
const PLATE_ASPECT = CANVAS_H / CANVAS_W
/** Clearance from the crown (userData.height) to the centre of the plate. */
const PLATE_GAP = 0.28

export type NameplateOptions = {
  maxed?: boolean
  accent?: string
}

export type CharacterNameplate = {
  object: THREE.Sprite
  setLabel: (name: string, level: number, opts?: NameplateOptions) => void
  attachTo: (character: THREE.Object3D) => void
  dispose: () => void
}

function fitName(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxSize: number) {
  let size = maxSize
  ctx.font = `700 ${size}px monospace`
  while (size > 10 && ctx.measureText(text).width > maxWidth) {
    size -= 1
    ctx.font = `700 ${size}px monospace`
  }
  return size
}

function paint(canvas: HTMLCanvasElement, name: string, levelText: string, accent: string) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  const nameSize = fitName(ctx, name, w - 36, 20)
  ctx.font = `700 ${nameSize}px monospace`
  const nameW = ctx.measureText(name).width
  ctx.font = '700 14px monospace'
  const levelW = ctx.measureText(levelText).width
  const chipW = Math.min(w - 8, Math.max(nameW, levelW) + 28)
  const chipH = 52
  const chipX = (w - chipW) / 2
  const chipY = (h - chipH) / 2
  // A quiet ink chip, no brass stroke — shop signs and NPC plates already shout.
  ctx.fillStyle = '#0b1017c4'
  ctx.fillRect(chipX, chipY, chipW, chipH)
  ctx.font = `700 ${nameSize}px monospace`
  ctx.fillStyle = '#e6dcc4'
  ctx.fillText(name, w / 2, h * 0.4)
  ctx.font = '700 14px monospace'
  ctx.fillStyle = accent
  ctx.fillText(levelText, w / 2, h * 0.68)
}

/**
 * A billboarded name + level that sits above a character's hat.
 *
 * Placement reads `userData.height` (feet-to-crown, already scaled) and
 * the named `head` anchor when present, so a short LOAM and a tall WICK
 * both carry the plate just above the crown. The sprite itself has no
 * raycast, so looking at it never selects or attacks the wearer.
 */
export function createCharacterNameplate(): CharacterNameplate {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    sizeAttenuation: true,
  })
  const sprite = new THREE.Sprite(material)
  sprite.name = 'nameplate'
  sprite.userData.nameplate = true
  sprite.raycast = () => {}
  sprite.scale.set(PLATE_WIDTH, PLATE_WIDTH * PLATE_ASPECT, 1)

  let drawn = ''
  const setLabel = (name: string, level: number, opts?: NameplateOptions) => {
    const trimmed = name.trim() || '—'
    const levelText = opts?.maxed ? 'MAX' : String(Math.max(1, Math.round(level)))
    const accent = opts?.accent ?? '#d5a64b'
    const key = `${trimmed}|${levelText}|${accent}`
    if (key === drawn) return
    drawn = key
    paint(canvas, trimmed, levelText, accent)
    texture.needsUpdate = true
    sprite.userData.caption = { name: trimmed, level: opts?.maxed ? 0 : Math.max(1, Math.round(level)), levelText }
  }

  const attachTo = (character: THREE.Object3D) => {
    sprite.removeFromParent()
    const groupScale = character.scale.x || 1
    const height = (character.userData.height as number | undefined) ?? 3.2
    let localY = (height + PLATE_GAP) / groupScale
    const head = character.getObjectByName('head')
    if (head) {
      const local = character.worldToLocal(head.getWorldPosition(new THREE.Vector3()))
      // Head sits inside the cowl; keep the plate above whichever is taller.
      localY = Math.max(localY, local.y + 0.48 / groupScale)
    }
    sprite.scale.set(PLATE_WIDTH / groupScale, (PLATE_WIDTH * PLATE_ASPECT) / groupScale, 1)
    sprite.position.set(0, localY, 0)
    character.add(sprite)
  }

  const dispose = () => {
    sprite.removeFromParent()
    material.dispose()
    texture.dispose()
  }

  return { object: sprite, setLabel, attachTo, dispose }
}

/** Resolve what a wayfinder should read as: typed name, else archetype. */
export function displayNameFor(playerName: string | undefined, archetypeName: string) {
  const trimmed = playerName?.trim() ?? ''
  return trimmed || archetypeName
}
