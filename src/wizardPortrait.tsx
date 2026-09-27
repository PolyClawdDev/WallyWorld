import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { animateCharacter, createWizard } from './characters'
import type { MothStyle, WizardId } from './characters'

/* ------------------------------------------------------------------ *
 * Combat-HUD likeness.
 *
 * The riveted square has to show the same mesh the town uses —
 * createWizard(id, style) — not a hat glyph. A second live WebGL
 * context next to the world canvas loses its buffer (and can stall
 * software GL), so this renders the bust off-screen and blits it
 * onto a 2D canvas. Rebuild on wizard/style so a wardrobe change
 * updates the face the moment the live player does.
 * ------------------------------------------------------------------ */

const SIZE = 116

function disposeGraph(root: THREE.Object3D) {
  const geos = new Set<THREE.BufferGeometry>()
  const mats = new Set<THREE.Material>()
  root.traverse(obj => {
    const mesh = obj as THREE.Mesh
    if (mesh.geometry) geos.add(mesh.geometry)
    const material = mesh.material
    if (!material) return
    if (Array.isArray(material)) material.forEach(item => mats.add(item))
    else mats.add(material)
  })
  geos.forEach(geo => geo.dispose())
  mats.forEach(mat => mat.dispose())
}

function frameFigure(camera: THREE.PerspectiveCamera, character: THREE.Object3D) {
  const height = (character.userData.height as number | undefined) ?? 3.2
  // Whole figure in the riveted square — a hat-only crop is what we replaced.
  const lookY = height * 0.48
  const dist = Math.max(4.4, height * 1.65)
  camera.position.set(dist * 0.32, lookY + height * 0.18, dist)
  camera.lookAt(0, lookY, 0)
}

export function WizardPortrait({ wizard, style }: { wizard: WizardId; style: MothStyle }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const dest = canvasRef.current
    if (!dest) return
    dest.width = SIZE
    dest.height = SIZE
    const ctx = dest.getContext('2d')
    if (!ctx) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#12161f')
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 28)
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    })
    renderer.setPixelRatio(1)
    renderer.setSize(SIZE, SIZE, false)
    renderer.setClearColor('#12161f', 1)

    scene.add(new THREE.HemisphereLight('#b9c8df', '#192333', 2.2))
    const key = new THREE.DirectionalLight('#ffd48a', 2.8)
    key.position.set(-3, 5, 4)
    scene.add(key)
    const rim = new THREE.DirectionalLight('#9fd7ff', 1.8)
    rim.position.set(2, 2.4, -4)
    scene.add(rim)
    const fill = new THREE.PointLight('#7bc9ce', 0.7, 8)
    fill.position.set(1.4, 1.6, 2)
    scene.add(fill)

    const character = createWizard(wizard, 1, style)
    character.rotation.y = 0.42
    scene.add(character)
    frameFigure(camera, character)

    const blit = (time: number) => {
      animateCharacter(character, time)
      renderer.render(scene, camera)
      ctx.drawImage(renderer.domElement, 0, 0)
    }
    blit(0)
    // Software GL often presents black on the first submit; keep a few
    // frames then drop the extra WebGL context so the world stays the owner.
    let frames = 0
    let id = 0
    const tick = (time: number) => {
      blit(time)
      frames += 1
      if (frames < 8) {
        id = requestAnimationFrame(tick)
        return
      }
      renderer.dispose()
      disposeGraph(character)
    }
    id = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(id)
      renderer.dispose()
      disposeGraph(character)
    }
  }, [wizard, style.hat, style.robe, style.familiar, style.accessory])

  return <canvas ref={canvasRef} className="cbt-portrait-canvas" width={SIZE} height={SIZE} aria-hidden="true" />
}
