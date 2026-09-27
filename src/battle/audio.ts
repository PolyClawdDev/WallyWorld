/* ------------------------------------------------------------------ *
 * Combat audio.
 *
 * The repository ships no audio assets and this module does not add
 * any: every cue below is synthesised at runtime from oscillators and
 * a noise buffer, which matches how the town's art is generated and
 * means nothing is fetched over the network.
 *
 * Browsers will not start an AudioContext before a gesture, so the
 * context is created lazily on the first key press or click and every
 * cue is a no-op until then.
 * ------------------------------------------------------------------ */

export type SoundId =
  | 'basic.fire' | 'basic.thorn' | 'basic.spark' | 'basic.lantern'
  | 'cast.fire' | 'cast.nature' | 'cast.storm' | 'cast.light'
  | 'impact.soft' | 'impact.hard' | 'impact.burn'
  | 'dash' | 'shield' | 'heal' | 'root' | 'stun'
  | 'ultimate' | 'levelup' | 'upgrade' | 'death' | 'deny' | 'select'

let ctx: AudioContext | null = null
let master: GainNode | null = null
let noise: AudioBuffer | null = null
let volume = 0.5
let muted = false

export function setCombatVolume(next: number) {
  volume = Math.max(0, Math.min(1, next))
  if (master) master.gain.value = muted ? 0 : volume
}

export function setCombatMuted(next: boolean) {
  muted = next
  if (master) master.gain.value = muted ? 0 : volume
}

export function isCombatMuted() {
  return muted
}

/** Call from a real user gesture; safe to call repeatedly. */
export function primeAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  ctx = new Ctor()
  master = ctx.createGain()
  master.gain.value = muted ? 0 : volume
  // A gentle ceiling: several impacts can land in the same frame.
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -14
  limiter.ratio.value = 12
  master.connect(limiter).connect(ctx.destination)

  const length = Math.floor(ctx.sampleRate * 0.5)
  noise = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = noise.getChannelData(0)
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
  return ctx
}

type ToneSpec = {
  type?: OscillatorType
  from: number
  to?: number
  duration: number
  gain?: number
  delay?: number
  /** Lowpass corner; omit for an unfiltered tone. */
  cutoff?: number
}

function tone(spec: ToneSpec) {
  if (!ctx || !master) return
  const start = ctx.currentTime + (spec.delay ?? 0)
  const osc = ctx.createOscillator()
  osc.type = spec.type ?? 'sine'
  osc.frequency.setValueAtTime(spec.from, start)
  if (spec.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, spec.to), start + spec.duration)
  const gain = ctx.createGain()
  const peak = spec.gain ?? 0.2
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.012, spec.duration * 0.3))
  gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.duration)
  let node: AudioNode = osc
  if (spec.cutoff) {
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(spec.cutoff, start)
    node = osc.connect(filter)
  }
  node.connect(gain).connect(master)
  osc.start(start)
  osc.stop(start + spec.duration + 0.02)
}

type NoiseSpec = {
  duration: number
  gain?: number
  delay?: number
  type?: BiquadFilterType
  from: number
  to?: number
  q?: number
}

function hiss(spec: NoiseSpec) {
  if (!ctx || !master || !noise) return
  const start = ctx.currentTime + (spec.delay ?? 0)
  const source = ctx.createBufferSource()
  source.buffer = noise
  source.loop = true
  const filter = ctx.createBiquadFilter()
  filter.type = spec.type ?? 'bandpass'
  filter.frequency.setValueAtTime(spec.from, start)
  if (spec.to !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(40, spec.to), start + spec.duration)
  filter.Q.value = spec.q ?? 1
  const gain = ctx.createGain()
  const peak = spec.gain ?? 0.16
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.01, spec.duration * 0.25))
  gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.duration)
  source.connect(filter).connect(gain).connect(master)
  source.start(start)
  source.stop(start + spec.duration + 0.02)
}

/**
 * One recipe per cue. Elements are separated by timbre rather than pitch: fire
 * is filtered noise, storm is a hard square, nature is a soft triangle, light
 * is a clean sine with a fifth above it.
 */
const recipes: Record<SoundId, () => void> = {
  'basic.fire': () => {
    hiss({ from: 1800, to: 500, duration: 0.16, gain: 0.1, type: 'bandpass', q: 0.8 })
    tone({ type: 'sawtooth', from: 320, to: 140, duration: 0.14, gain: 0.07, cutoff: 1400 })
  },
  'basic.thorn': () => {
    tone({ type: 'triangle', from: 640, to: 300, duration: 0.12, gain: 0.09 })
    hiss({ from: 2600, to: 1400, duration: 0.07, gain: 0.05 })
  },
  'basic.spark': () => {
    tone({ type: 'square', from: 1180, to: 760, duration: 0.07, gain: 0.055, cutoff: 3200 })
    hiss({ from: 5200, to: 2600, duration: 0.05, gain: 0.05, type: 'highpass' })
  },
  'basic.lantern': () => {
    tone({ type: 'sine', from: 880, to: 1320, duration: 0.11, gain: 0.08 })
    tone({ type: 'sine', from: 1320, to: 1760, duration: 0.09, gain: 0.04, delay: 0.02 })
  },
  'cast.fire': () => {
    hiss({ from: 400, to: 2400, duration: 0.3, gain: 0.13, type: 'bandpass', q: 0.6 })
    tone({ type: 'sawtooth', from: 130, to: 260, duration: 0.26, gain: 0.09, cutoff: 900 })
  },
  'cast.nature': () => {
    tone({ type: 'triangle', from: 220, to: 430, duration: 0.28, gain: 0.1 })
    tone({ type: 'sine', from: 660, to: 880, duration: 0.2, gain: 0.05, delay: 0.05 })
  },
  'cast.storm': () => {
    tone({ type: 'square', from: 180, to: 900, duration: 0.18, gain: 0.08, cutoff: 2600 })
    hiss({ from: 3000, to: 8000, duration: 0.2, gain: 0.08, type: 'highpass' })
  },
  'cast.light': () => {
    tone({ type: 'sine', from: 520, to: 1040, duration: 0.24, gain: 0.09 })
    tone({ type: 'sine', from: 780, to: 1560, duration: 0.24, gain: 0.05 })
  },
  'impact.soft': () => {
    tone({ type: 'sine', from: 240, to: 90, duration: 0.11, gain: 0.11 })
    hiss({ from: 900, to: 300, duration: 0.08, gain: 0.06, type: 'lowpass' })
  },
  'impact.hard': () => {
    tone({ type: 'sine', from: 150, to: 48, duration: 0.24, gain: 0.2 })
    hiss({ from: 1600, to: 200, duration: 0.18, gain: 0.13, type: 'lowpass' })
  },
  'impact.burn': () => hiss({ from: 900, to: 260, duration: 0.3, gain: 0.07, type: 'bandpass', q: 0.5 }),
  dash: () => hiss({ from: 300, to: 3200, duration: 0.2, gain: 0.09, type: 'bandpass', q: 0.9 }),
  shield: () => {
    tone({ type: 'sine', from: 300, to: 600, duration: 0.3, gain: 0.1 })
    tone({ type: 'sine', from: 450, to: 900, duration: 0.3, gain: 0.05, delay: 0.04 })
  },
  heal: () => {
    tone({ type: 'sine', from: 520, to: 780, duration: 0.3, gain: 0.08 })
    tone({ type: 'sine', from: 780, to: 1040, duration: 0.26, gain: 0.05, delay: 0.09 })
  },
  root: () => {
    tone({ type: 'triangle', from: 160, to: 70, duration: 0.26, gain: 0.13 })
    hiss({ from: 700, to: 200, duration: 0.2, gain: 0.07, type: 'lowpass' })
  },
  stun: () => {
    tone({ type: 'square', from: 90, to: 60, duration: 0.3, gain: 0.1, cutoff: 700 })
    hiss({ from: 2400, to: 600, duration: 0.2, gain: 0.08 })
  },
  ultimate: () => {
    tone({ type: 'sawtooth', from: 70, to: 200, duration: 0.7, gain: 0.16, cutoff: 1100 })
    tone({ type: 'sine', from: 140, to: 70, duration: 0.9, gain: 0.13 })
    hiss({ from: 200, to: 4000, duration: 0.55, gain: 0.11, type: 'bandpass', q: 0.5 })
  },
  levelup: () => {
    // A rising triad: unmistakably good news without stopping the fight.
    ;[523.25, 659.25, 783.99, 1046.5].forEach((freq, i) =>
      tone({ type: 'sine', from: freq, duration: 0.32, gain: 0.1, delay: i * 0.07 }),
    )
  },
  upgrade: () => {
    tone({ type: 'square', from: 700, to: 1400, duration: 0.09, gain: 0.05, cutoff: 3000 })
    tone({ type: 'sine', from: 1400, duration: 0.14, gain: 0.06, delay: 0.06 })
  },
  death: () => {
    tone({ type: 'sawtooth', from: 220, to: 55, duration: 0.5, gain: 0.12, cutoff: 800 })
    hiss({ from: 1200, to: 120, duration: 0.42, gain: 0.1, type: 'lowpass' })
  },
  deny: () => tone({ type: 'square', from: 200, to: 150, duration: 0.09, gain: 0.05, cutoff: 900 }),
  select: () => tone({ type: 'sine', from: 900, duration: 0.05, gain: 0.04 }),
}

/**
 * Same cue twice in the same few milliseconds is a click, not a sound, so
 * repeats inside a short window are dropped.
 */
const lastPlayed = new Map<SoundId, number>()

export function playSound(id: SoundId, minGapMs = 35) {
  if (!ctx || !master || muted) return
  const now = performance.now()
  if (now - (lastPlayed.get(id) ?? -1e9) < minGapMs) return
  lastPlayed.set(id, now)
  recipes[id]?.()
}

export function disposeAudio() {
  lastPlayed.clear()
  if (ctx) void ctx.close()
  ctx = null
  master = null
  noise = null
}
