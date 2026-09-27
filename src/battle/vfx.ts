import * as THREE from 'three'

/* ------------------------------------------------------------------ *
 * Shared combat visuals.
 *
 * Every ability in kits.ts is built out of the primitives here rather
 * than growing its own particle code, which keeps the look coherent and
 * keeps disposal in one place. Geometries and the float-text pool are
 * allocated once; effects are lightweight wrappers with an `update`
 * that returns false when they are finished.
 *
 * The rule for readability, taken from the rest of the art direction:
 * hard flat colour, short lifetimes, and shapes that say what happened
 * (a ring on the ground is an area, a rising shell is an impact, a
 * thin ribbon is a beam). Nothing lasts long enough to hide the fight.
 * ------------------------------------------------------------------ */

type Tracked = {
  update: (dt: number, now: number) => boolean
  dispose: () => void
}

export type Handle = {
  end: () => void
  alive: () => boolean
}

const DEAD: Handle = { end: () => {}, alive: () => false }

export type Vfx = ReturnType<typeof createVfx>

export function createVfx(scene: THREE.Scene, camera: THREE.Camera) {
  const root = new THREE.Group()
  root.name = 'combat-vfx'
  scene.add(root)

  const sphere = new THREE.SphereGeometry(1, 14, 10)
  const ringFlat = new THREE.RingGeometry(0.78, 1, 32)
  const ringThin = new THREE.RingGeometry(0.93, 1, 32)
  const disc = new THREE.CircleGeometry(1, 32)
  const cube = new THREE.BoxGeometry(1, 1, 1)
  const spike = new THREE.ConeGeometry(0.2, 1, 5)
  spike.translate(0, 0.5, 0)
  const shard = new THREE.OctahedronGeometry(1, 0)
  const unitBeam = new THREE.BoxGeometry(1, 1, 1)
  unitBeam.translate(0, 0, 0.5)
  const geometries = [sphere, ringFlat, ringThin, disc, cube, spike, shard, unitBeam]

  const effects: Tracked[] = []
  const track = (effect: Tracked) => {
    effects.push(effect)
    return effect
  }

  const basic = (color: string, opacity: number) =>
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide })

  /* ----------------------- floating numbers ----------------------- */

  type Slot = {
    sprite: THREE.Sprite
    canvas: HTMLCanvasElement
    texture: THREE.CanvasTexture
    until: number
    life: number
    from: THREE.Vector3
    drift: number
  }
  const POOL = 16
  const slots: Slot[] = []
  for (let i = 0; i < POOL; i++) {
    const canvas = document.createElement('canvas')
    canvas.width = 192
    canvas.height = 96
    const texture = new THREE.CanvasTexture(canvas)
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }))
    sprite.scale.set(1.7, 0.85, 1)
    sprite.visible = false
    sprite.renderOrder = 30
    root.add(sprite)
    slots.push({ sprite, canvas, texture, until: 0, life: 850, from: new THREE.Vector3(), drift: 0 })
  }
  let cursor = 0
  // Damage numbers flood instantly with a tick effect running; one per target
  // per short window keeps them legible.
  const lastNumberAt = new Map<string, number>()

  function number(text: string, at: THREE.Vector3, color: string, options?: { key?: string; scale?: number; gapMs?: number }) {
    const now = performance.now()
    const key = options?.key
    if (key) {
      if (now - (lastNumberAt.get(key) ?? -1e9) < (options?.gapMs ?? 260)) return
      lastNumberAt.set(key, now)
    }
    const slot = slots[cursor++ % POOL]
    const ctx = slot.canvas.getContext('2d')!
    ctx.clearRect(0, 0, 192, 96)
    ctx.font = '800 54px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 9
    ctx.strokeStyle = '#0b1017'
    ctx.strokeText(text, 96, 48)
    ctx.fillStyle = color
    ctx.fillText(text, 96, 48)
    slot.texture.needsUpdate = true
    slot.from.copy(at)
    slot.life = 850
    slot.until = now + slot.life
    slot.drift = (Math.random() - 0.5) * 0.8
    const size = options?.scale ?? 1
    slot.sprite.scale.set(1.7 * size, 0.85 * size, 1)
    slot.sprite.position.copy(at)
    slot.sprite.visible = true
    ;(slot.sprite.material as THREE.SpriteMaterial).opacity = 1
  }

  function updateNumbers(now: number) {
    for (const slot of slots) {
      if (!slot.sprite.visible) continue
      const remaining = slot.until - now
      if (remaining <= 0) {
        slot.sprite.visible = false
        continue
      }
      const t = 1 - remaining / slot.life
      slot.sprite.position.set(slot.from.x + slot.drift * t, slot.from.y + t * 1.45, slot.from.z)
      ;(slot.sprite.material as THREE.SpriteMaterial).opacity = 1 - t * t
    }
  }

  /* --------------------------- primitives --------------------------- */

  /** A short shell-and-shockwave hit. The bread and butter of every impact. */
  function impact(at: THREE.Vector3, color: string, accent: string, radius = 1.6, life = 0.34) {
    const group = new THREE.Group()
    group.position.copy(at)
    const shell = new THREE.Mesh(sphere, basic(color, 0.62))
    const core = new THREE.Mesh(sphere, basic(accent, 0.95))
    const wave = new THREE.Mesh(ringFlat, basic(color, 0.85))
    wave.rotation.x = -Math.PI / 2
    wave.position.y = -Math.min(at.y, 1.2) + 0.08
    const light = new THREE.PointLight(color, 6, radius * 4)
    group.add(shell, core, wave, light)
    root.add(group)
    let t = 0
    track({
      update(dt) {
        t += dt / life
        if (t >= 1) return false
        shell.scale.setScalar(radius * (0.3 + 0.85 * Math.sqrt(t)))
        core.scale.setScalar(radius * 0.45 * (0.2 + Math.sqrt(t)))
        wave.scale.setScalar(radius * (0.4 + 1.8 * t))
        ;(shell.material as THREE.MeshBasicMaterial).opacity = 0.62 * (1 - t)
        ;(core.material as THREE.MeshBasicMaterial).opacity = 0.95 * Math.max(0, 1 - t * 2.2)
        ;(wave.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t)
        light.intensity = 8 * (1 - t)
        return true
      },
      dispose() {
        root.remove(group)
        ;[shell, core, wave].forEach(mesh => (mesh.material as THREE.Material).dispose())
      },
    })
  }

  /**
   * The contract for every dangerous ground ability: a ring that fills before
   * anything happens, so standing in it is a decision.
   */
  function telegraph(at: THREE.Vector3, radius: number, color: string, duration: number): Handle {
    const group = new THREE.Group()
    group.position.copy(at).setY(0.06)
    const outline = new THREE.Mesh(ringThin, basic(color, 0.9))
    outline.rotation.x = -Math.PI / 2
    outline.scale.setScalar(radius)
    const fill = new THREE.Mesh(disc, basic(color, 0.2))
    fill.rotation.x = -Math.PI / 2
    fill.scale.setScalar(0.01)
    group.add(outline, fill)
    root.add(group)
    let t = 0
    let done = false
    track({
      update(dt) {
        if (done) return false
        t += dt / duration
        if (t >= 1) return false
        fill.scale.setScalar(radius * t)
        ;(outline.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.45 * Math.abs(Math.sin(t * 18))
        return true
      },
      dispose() {
        root.remove(group)
        ;[outline, fill].forEach(mesh => (mesh.material as THREE.Material).dispose())
      },
    })
    return { end: () => { done = true }, alive: () => !done && t < 1 }
  }

  /** A persistent ground area: ring, tinted floor, and a few rising motes. */
  function zone(at: THREE.Vector3, radius: number, color: string, accent: string, duration: number, options?: { motes?: number }) {
    const group = new THREE.Group()
    group.position.copy(at).setY(0.07)
    const rim = new THREE.Mesh(ringFlat, basic(accent, 0.8))
    rim.rotation.x = -Math.PI / 2
    rim.scale.setScalar(radius)
    const floor = new THREE.Mesh(disc, basic(color, 0.24))
    floor.rotation.x = -Math.PI / 2
    floor.scale.setScalar(radius)
    group.add(rim, floor)
    const moteCount = options?.motes ?? 10
    const moteMaterial = basic(accent, 0.9)
    const motes: THREE.Mesh[] = []
    for (let i = 0; i < moteCount; i++) {
      const mote = new THREE.Mesh(cube, moteMaterial)
      mote.scale.setScalar(0.18)
      mote.userData.angle = (i / moteCount) * Math.PI * 2
      mote.userData.radius = radius * (0.25 + Math.random() * 0.7)
      mote.userData.offset = Math.random()
      motes.push(mote)
      group.add(mote)
    }
    const light = new THREE.PointLight(accent, 2.4, radius * 3)
    light.position.y = 1
    group.add(light)
    root.add(group)
    let t = 0
    let ended = false
    track({
      update(dt, now) {
        if (ended) return false
        t += dt / duration
        if (t >= 1) return false
        const fade = t > 0.85 ? 1 - (t - 0.85) / 0.15 : 1
        ;(rim.material as THREE.MeshBasicMaterial).opacity = 0.8 * fade
        ;(floor.material as THREE.MeshBasicMaterial).opacity = 0.24 * fade
        moteMaterial.opacity = 0.9 * fade
        rim.scale.setScalar(radius * (1 + Math.sin(now * 0.006) * 0.012))
        motes.forEach(mote => {
          const phase = (now * 0.0008 + (mote.userData.offset as number)) % 1
          const angle = (mote.userData.angle as number) + now * 0.0004
          const r = mote.userData.radius as number
          mote.position.set(Math.cos(angle) * r, phase * 1.8, Math.sin(angle) * r)
        })
        light.intensity = 2.4 * fade
        return true
      },
      dispose() {
        root.remove(group)
        ;(rim.material as THREE.Material).dispose()
        ;(floor.material as THREE.Material).dispose()
        moteMaterial.dispose()
      },
    })
    return {
      end: () => { ended = true },
      alive: () => !ended && t < 1,
      move: (to: THREE.Vector3) => group.position.set(to.x, 0.07, to.z),
    }
  }

  /** A stretched ribbon between two points, re-aimable while it lives. */
  function beam(from: THREE.Vector3, to: THREE.Vector3, color: string, accent: string, width = 0.5) {
    const group = new THREE.Group()
    const outer = new THREE.Mesh(unitBeam, basic(color, 0.55))
    const inner = new THREE.Mesh(unitBeam, basic(accent, 0.95))
    group.add(outer, inner)
    const light = new THREE.PointLight(accent, 5, 10)
    group.add(light)
    root.add(group)
    let ended = false
    let pulse = 0
    const aim = (a: THREE.Vector3, b: THREE.Vector3) => {
      const length = a.distanceTo(b)
      group.position.copy(a)
      group.lookAt(b)
      outer.scale.set(width, width, Math.max(0.01, length))
      inner.scale.set(width * 0.42, width * 0.42, Math.max(0.01, length))
      light.position.set(0, 0, length * 0.5)
    }
    aim(from, to)
    track({
      update(dt) {
        if (ended) return false
        pulse += dt * 22
        ;(outer.material as THREE.MeshBasicMaterial).opacity = 0.45 + Math.sin(pulse) * 0.12
        return true
      },
      dispose() {
        root.remove(group)
        ;[outer, inner].forEach(mesh => (mesh.material as THREE.Material).dispose())
      },
    })
    return { aim, end: () => { ended = true }, alive: () => !ended }
  }

  /** A bubble welded to a moving object: the only shield visual in the game. */
  function shield(host: THREE.Object3D, radius: number, color: string) {
    const bubble = new THREE.Mesh(sphere, basic(color, 0.24))
    bubble.scale.setScalar(radius)
    bubble.position.y = radius * 0.75
    const band = new THREE.Mesh(ringThin, basic(color, 0.8))
    band.rotation.x = -Math.PI / 2
    band.scale.setScalar(radius)
    band.position.y = 0.1
    host.add(bubble, band)
    let ended = false
    let flash = 0
    track({
      update(dt, now) {
        if (ended) return false
        flash = Math.max(0, flash - dt * 4)
        const breathe = 1 + Math.sin(now * 0.005) * 0.03
        bubble.scale.setScalar(radius * breathe)
        ;(bubble.material as THREE.MeshBasicMaterial).opacity = 0.2 + flash * 0.5
        ;(band.material as THREE.MeshBasicMaterial).opacity = 0.6 + flash * 0.4
        return true
      },
      dispose() {
        host.remove(bubble, band)
        ;[bubble, band].forEach(mesh => (mesh.material as THREE.Material).dispose())
      },
    })
    return {
      end: () => { ended = true },
      alive: () => !ended,
      hit: () => { flash = 1 },
    }
  }

  /**
   * A small flag that sticks to an actor: burn embers, root thorns, a stun
   * halo. One per (host, kind) is enough; the engine ends the old one first.
   */
  function attach(host: THREE.Object3D, kind: 'burn' | 'root' | 'stun' | 'slow' | 'mark', color: string, height: number) {
    const group = new THREE.Group()
    const material = basic(color, 0.9)
    const pieces: THREE.Mesh[] = []
    if (kind === 'burn') {
      for (let i = 0; i < 5; i++) {
        const ember = new THREE.Mesh(cube, material)
        ember.scale.setScalar(0.14)
        ember.userData.offset = Math.random()
        ember.userData.angle = (i / 5) * Math.PI * 2
        pieces.push(ember)
      }
    } else if (kind === 'root') {
      for (let i = 0; i < 6; i++) {
        const thorn = new THREE.Mesh(spike, material)
        const angle = (i / 6) * Math.PI * 2
        thorn.position.set(Math.cos(angle) * 0.55, 0, Math.sin(angle) * 0.55)
        thorn.rotation.z = Math.cos(angle) * 0.4
        thorn.rotation.x = -Math.sin(angle) * 0.4
        thorn.scale.set(1, height * 0.5, 1)
        pieces.push(thorn)
      }
    } else if (kind === 'stun') {
      for (let i = 0; i < 3; i++) {
        const star = new THREE.Mesh(shard, material)
        star.scale.setScalar(0.16)
        star.userData.angle = (i / 3) * Math.PI * 2
        pieces.push(star)
      }
    } else if (kind === 'slow') {
      const band = new THREE.Mesh(ringThin, material)
      band.rotation.x = -Math.PI / 2
      band.scale.setScalar(0.85)
      band.position.y = 0.12
      pieces.push(band)
    } else {
      const glyph = new THREE.Mesh(shard, material)
      glyph.scale.setScalar(0.28)
      glyph.position.y = height + 0.55
      pieces.push(glyph)
    }
    pieces.forEach(piece => group.add(piece))
    host.add(group)
    let ended = false
    track({
      update(dt, now) {
        if (ended) return false
        if (kind === 'burn') {
          pieces.forEach(ember => {
            const phase = (now * 0.0012 + (ember.userData.offset as number)) % 1
            const angle = ember.userData.angle as number
            ember.position.set(Math.cos(angle) * 0.4, phase * height * 1.3, Math.sin(angle) * 0.4)
            ember.scale.setScalar(0.14 * (1 - phase))
          })
        } else if (kind === 'stun') {
          pieces.forEach(star => {
            const angle = (star.userData.angle as number) + now * 0.006
            star.position.set(Math.cos(angle) * 0.5, height + 0.5, Math.sin(angle) * 0.5)
            star.rotation.y += dt * 6
          })
        } else if (kind === 'mark') {
          pieces[0].rotation.y += dt * 3
          pieces[0].position.y = height + 0.55 + Math.sin(now * 0.005) * 0.08
        } else if (kind === 'slow') {
          pieces[0].rotation.z += dt * 1.5
        }
        return true
      },
      dispose() {
        host.remove(group)
        material.dispose()
      },
    })
    return { end: () => { ended = true }, alive: () => !ended }
  }

  /** Where a move order is going. Disappears on arrival or on a new order. */
  function marker(at: THREE.Vector3, color: string) {
    const group = new THREE.Group()
    group.position.copy(at).setY(0.09)
    const ring = new THREE.Mesh(ringThin, basic(color, 0.95))
    ring.rotation.x = -Math.PI / 2
    ring.scale.setScalar(0.5)
    group.add(ring)
    root.add(group)
    let ended = false
    let t = 0
    track({
      update(dt) {
        if (ended) return false
        t += dt
        const pop = t < 0.2 ? 0.5 + (t / 0.2) * 0.35 : 0.72 + Math.sin(t * 6) * 0.05
        ring.scale.setScalar(pop)
        ;(ring.material as THREE.MeshBasicMaterial).opacity = 0.95
        return true
      },
      dispose() {
        root.remove(group)
        ;(ring.material as THREE.Material).dispose()
      },
    })
    return { end: () => { ended = true }, alive: () => !ended }
  }

  /** The selected-target reticle. Follows its host until told to stop. */
  function reticle(color: string) {
    const group = new THREE.Group()
    const ring = new THREE.Mesh(ringThin, basic(color, 0.95))
    ring.rotation.x = -Math.PI / 2
    const inner = new THREE.Mesh(ringFlat, basic(color, 0.35))
    inner.rotation.x = -Math.PI / 2
    group.add(ring, inner)
    group.visible = false
    root.add(group)
    let ended = false
    track({
      update(dt, now) {
        if (ended) return false
        group.rotation.y = now * 0.0012
        return true
      },
      dispose() {
        root.remove(group)
        ;[ring, inner].forEach(mesh => (mesh.material as THREE.Material).dispose())
      },
    })
    return {
      show(at: THREE.Vector3, radius: number, hostile: boolean) {
        group.visible = true
        group.position.set(at.x, 0.1, at.z)
        ring.scale.setScalar(radius)
        inner.scale.setScalar(radius * 0.94)
        const tint = hostile ? '#e35e35' : color
        ;(ring.material as THREE.MeshBasicMaterial).color.set(tint)
        ;(inner.material as THREE.MeshBasicMaterial).color.set(tint)
      },
      hide() {
        group.visible = false
      },
      end: () => { ended = true },
      alive: () => !ended,
    }
  }

  /** The aiming preview: a line for skillshots, a circle for ground casts. */
  function preview(color: string) {
    const group = new THREE.Group()
    const line = new THREE.Mesh(unitBeam, basic(color, 0.28))
    const circle = new THREE.Mesh(ringThin, basic(color, 0.9))
    circle.rotation.x = -Math.PI / 2
    const fill = new THREE.Mesh(disc, basic(color, 0.14))
    fill.rotation.x = -Math.PI / 2
    const reach = new THREE.Mesh(ringThin, basic(color, 0.3))
    reach.rotation.x = -Math.PI / 2
    group.add(line, circle, fill, reach)
    group.visible = false
    root.add(group)
    let ended = false
    track({
      update() {
        return !ended
      },
      dispose() {
        root.remove(group)
        ;[line, circle, fill, reach].forEach(mesh => (mesh.material as THREE.Material).dispose())
      },
    })
    return {
      line(from: THREE.Vector3, to: THREE.Vector3, width: number, maxRange: number) {
        group.visible = true
        group.position.set(0, 0, 0)
        line.visible = true
        circle.visible = false
        fill.visible = false
        reach.visible = true
        const a = from.clone().setY(0.12)
        const b = to.clone().setY(0.12)
        line.position.copy(a)
        line.lookAt(b)
        const length = a.distanceTo(b)
        line.scale.set(width, 0.04, Math.max(0.01, length))
        reach.position.set(from.x, 0.08, from.z)
        reach.scale.setScalar(maxRange)
      },
      circle(at: THREE.Vector3, radius: number, from: THREE.Vector3, maxRange: number) {
        group.visible = true
        line.visible = false
        circle.visible = true
        fill.visible = true
        reach.visible = true
        circle.position.set(at.x, 0.12, at.z)
        circle.scale.setScalar(radius)
        fill.position.set(at.x, 0.11, at.z)
        fill.scale.setScalar(radius)
        reach.position.set(from.x, 0.08, from.z)
        reach.scale.setScalar(maxRange)
      },
      tint(next: string) {
        ;[line, circle, fill, reach].forEach(mesh => (mesh.material as THREE.MeshBasicMaterial).color.set(next))
      },
      hide() {
        group.visible = false
      },
      end: () => { ended = true },
      alive: () => !ended,
    }
  }

  /** A short vertical flare on the player: level up, empowered attack, recall. */
  function flare(host: THREE.Object3D, color: string, height = 3.6, life = 0.7) {
    const group = new THREE.Group()
    const column = new THREE.Mesh(cube, basic(color, 0.5))
    column.scale.set(1.5, height, 1.5)
    column.position.y = height / 2
    const ring = new THREE.Mesh(ringFlat, basic(color, 0.9))
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.1
    group.add(column, ring)
    host.add(group)
    const light = new THREE.PointLight(color, 8, 10)
    light.position.y = 2
    group.add(light)
    let t = 0
    track({
      update(dt) {
        t += dt / life
        if (t >= 1) return false
        column.scale.set(1.5 * (1 - t), height * (0.4 + t), 1.5 * (1 - t))
        column.position.y = (height * (0.4 + t)) / 2
        ring.scale.setScalar(0.6 + t * 3.4)
        ;(column.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - t)
        ;(ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t)
        light.intensity = 8 * (1 - t)
        return true
      },
      dispose() {
        host.remove(group)
        ;[column, ring].forEach(mesh => (mesh.material as THREE.Material).dispose())
      },
    })
  }

  /**
   * A moving body with a fading ribbon. Used by every projectile in the game;
   * the engine owns the travel logic and only asks this for the visual.
   */
  function bolt(color: string, accent: string, size = 0.34, shape: 'shard' | 'disc' | 'spike' = 'shard') {
    const group = new THREE.Group()
    const geometry = shape === 'disc' ? ringFlat : shape === 'spike' ? spike : shard
    const head = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: accent, side: THREE.DoubleSide }))
    head.scale.setScalar(size)
    const glow = new THREE.Mesh(sphere, basic(color, 0.45))
    glow.scale.setScalar(size * 1.9)
    const light = new THREE.PointLight(color, 3, 6)
    group.add(head, glow, light)
    root.add(group)
    const ribbon: THREE.Mesh[] = []
    const ribbonMaterial = basic(color, 0.8)
    let ended = false
    let spin = 0
    track({
      update(dt, now) {
        spin += dt
        head.rotation.y = spin * 9
        head.rotation.x = shape === 'disc' ? Math.PI / 2 : spin * 6
        if (!ended && ribbon.length < 22) {
          const piece = new THREE.Mesh(cube, ribbonMaterial)
          piece.scale.setScalar(size * 0.7)
          piece.position.copy(group.position)
          piece.userData.born = now
          root.add(piece)
          ribbon.push(piece)
        }
        for (let i = ribbon.length - 1; i >= 0; i--) {
          const piece = ribbon[i]
          const age = (now - (piece.userData.born as number)) / 320
          if (age >= 1) {
            root.remove(piece)
            ribbon.splice(i, 1)
            continue
          }
          piece.scale.setScalar(size * 0.7 * (1 - age))
        }
        return !ended || ribbon.length > 0
      },
      dispose() {
        ribbon.forEach(piece => root.remove(piece))
        root.remove(group)
        ;(head.material as THREE.Material).dispose()
        ;(glow.material as THREE.Material).dispose()
        ribbonMaterial.dispose()
      },
    })
    return {
      group,
      end: () => {
        ended = true
        group.visible = false
      },
      alive: () => !ended,
    }
  }

  return {
    root,
    number,
    impact,
    telegraph,
    zone,
    beam,
    shield,
    attach,
    marker,
    reticle,
    preview,
    flare,
    bolt,
    camera,
    update(dt: number, now: number) {
      for (let i = effects.length - 1; i >= 0; i--) {
        if (!effects[i].update(dt, now)) {
          effects[i].dispose()
          effects.splice(i, 1)
        }
      }
      updateNumbers(now)
    },
    dispose() {
      effects.forEach(effect => effect.dispose())
      effects.length = 0
      slots.forEach(slot => {
        root.remove(slot.sprite)
        slot.texture.dispose()
        ;(slot.sprite.material as THREE.Material).dispose()
      })
      geometries.forEach(geometry => geometry.dispose())
      scene.remove(root)
    },
    DEAD,
  }
}
