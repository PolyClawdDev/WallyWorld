import * as THREE from 'three'
import { createHash } from 'node:crypto'
import { createWizard, defaultMothStyle, mothStyleOptions, type MothStyle, type WizardId } from '../src/characters'

const ids: WizardId[] = ['MOTH', 'BRAMBLE', 'CINDER', 'ORBIT']

/** Fingerprint every rendered cube position and colour so we can prove the model actually changed. */
function fingerprint(style: MothStyle, id: WizardId) {
  const root = createWizard(id, 1, style)
  const parts: string[] = []
  root.traverse(obj => {
    const mesh = obj as THREE.Mesh & { isInstancedMesh?: boolean; count?: number; instanceMatrix?: THREE.InstancedBufferAttribute }
    if (!mesh.isMesh && !mesh.isInstancedMesh) return
    const mat = mesh.material as THREE.MeshStandardMaterial
    const color = mat?.color?.getHexString?.() ?? '??'
    if (mesh.isInstancedMesh && mesh.instanceMatrix) {
      const m = new THREE.Matrix4()
      const v = new THREE.Vector3()
      const pts: string[] = []
      for (let i = 0; i < (mesh.count ?? 0); i++) {
        mesh.getMatrixAt!(i, m)
        v.setFromMatrixPosition(m)
        pts.push(`${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`)
      }
      parts.push(`inst:${color}:${pts.sort().join('|')}`)
    } else {
      const p = mesh.getWorldPosition(new THREE.Vector3())
      const g = mesh.geometry as THREE.BufferGeometry
      parts.push(`mesh:${color}:${g.type}:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`)
    }
  })
  return createHash('sha1').update(parts.sort().join('\n')).digest('hex').slice(0, 12)
}

const failures: string[] = []
const slots = ['hat', 'robe', 'familiar', 'accessory'] as const

console.log('Proving every selector changes the geometry of every character:\n')
for (const id of ids) {
  const row: string[] = []
  for (const slot of slots) {
    const options = mothStyleOptions[slot]
    const hashes = new Map<string, string>()
    for (const option of options) {
      const style = { ...defaultMothStyle, [slot]: option.id } as MothStyle
      hashes.set(option.id, fingerprint(style, id))
    }
    const unique = new Set(hashes.values()).size
    row.push(`${slot}: ${unique}/${options.length}`)
    if (unique !== options.length) {
      const dupes = [...hashes.entries()].map(([k, v]) => `${k}=${v}`).join(' ')
      failures.push(`${id} ${slot} produced only ${unique} distinct models (${dupes})`)
    }
  }
  console.log(`  ${id.padEnd(8)} ${row.join('   ')}`)
}

// Characters must also differ from one another under an identical style.
const perCharacter = new Set(ids.map(id => fingerprint(defaultMothStyle, id)))
console.log(`\n  distinct silhouettes across the 4 characters: ${perCharacter.size}/4`)
if (perCharacter.size !== 4) failures.push('characters are not visually distinct under the same style')

console.log(failures.length ? `\nFAILURES:\n${failures.join('\n')}` : '\nAll selectors change the model on all four characters.')
process.exit(failures.length ? 1 : 0)
