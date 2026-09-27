/* Throwaway API probe: confirms the installed packages expose the exact calls
 * the integration relies on, and that devnet RPC answers from this machine. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { ed25519 } from '@noble/curves/ed25519.js'
import bs58 from 'bs58'
import Database from 'better-sqlite3'

console.log('TOKEN_PROGRAM_ID       ', TOKEN_PROGRAM_ID.toBase58())
console.log('TOKEN_2022_PROGRAM_ID  ', TOKEN_2022_PROGRAM_ID.toBase58())
console.log('LAMPORTS_PER_SOL       ', LAMPORTS_PER_SOL)

// ed25519 sign/verify round trip, the shape the server will use.
const kp = Keypair.generate()
const msg = new TextEncoder().encode('probe message')
const sig = ed25519.sign(msg, kp.secretKey.slice(0, 32))
console.log('ed25519 verify ok      ', ed25519.verify(sig, msg, kp.publicKey.toBytes()))
console.log('ed25519 reject tamper  ', ed25519.verify(sig, new TextEncoder().encode('other'), kp.publicKey.toBytes()))
console.log('bs58 roundtrip ok      ', bs58.encode(bs58.decode(kp.publicKey.toBase58())) === kp.publicKey.toBase58())

// better-sqlite3 native load + WAL.
const db = new Database(':memory:')
db.pragma('journal_mode = WAL')
db.exec('create table t (a text primary key, b integer)')
db.prepare('insert into t values (?, ?)').run('x', 42)
console.log('sqlite roundtrip       ', JSON.stringify(db.prepare('select * from t').get()))

// Devnet RPC reachability and the exact methods used at runtime.
const conn = new Connection('https://api.devnet.solana.com', 'confirmed')
console.log('genesis hash           ', await conn.getGenesisHash())
console.log('slot                   ', await conn.getSlot())
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
console.log('blockhash              ', blockhash, 'lastValid', lastValidBlockHeight)

// Fee quote for a real transfer message.
const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight })
tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1000 }))
const fee = await conn.getFeeForMessage(tx.compileMessage(), 'confirmed')
console.log('getFeeForMessage       ', fee.value)

// Token account enumeration against a known-populated devnet-ish owner is not
// guaranteed, so just prove the call shape works on an empty account.
const parsed = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId: TOKEN_PROGRAM_ID })
console.log('getParsedTokenAccounts ', parsed.value.length, 'accounts')

// Unknown-signature path: a well-formed signature that was never submitted.
const fakeSig = bs58.encode(new Uint8Array(64).fill(7))
const statuses = await conn.getSignatureStatuses([fakeSig])
console.log('unknown sig status     ', JSON.stringify(statuses.value))
console.log('balance of fresh key   ', await conn.getBalance(new PublicKey(kp.publicKey.toBase58())))
