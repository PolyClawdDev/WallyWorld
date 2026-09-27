/* ------------------------------------------------------------------ *
 * `Buffer` for the browser.
 *
 * @solana/web3.js is written against Node and reaches for the `Buffer`
 * global when it serialises transactions and account data. Browsers have
 * no such global, and Vite deliberately does not invent one, so without
 * this the whole app throws `ReferenceError: Buffer is not defined` on
 * first render and the page goes blank.
 *
 * `buffer` is Feross's long-standing userland implementation — the same
 * one bundlers have used for this for years, and already present in the
 * tree as a dependency of web3.js itself.
 *
 * This must be imported before anything that pulls in web3.js. ES modules
 * evaluate their imports in declaration order, so the import of this file
 * sits first in `main.tsx`.
 * ------------------------------------------------------------------ */

import { Buffer as NodeBuffer } from 'buffer'

// Narrow view of the global object. Declaring `var Buffer` in `declare global`
// instead would be self-referential, and would also fight @types/node wherever
// that is in scope.
const globals = globalThis as unknown as {
  Buffer?: typeof NodeBuffer
  global?: unknown
}

if (typeof globals.Buffer === 'undefined') {
  globals.Buffer = NodeBuffer
}

// Some transitive dependencies still test for `global` rather than
// `globalThis`. Cheap to satisfy, and heads off the same blank-page failure.
if (typeof globals.global === 'undefined') {
  globals.global = globalThis
}

export {}
