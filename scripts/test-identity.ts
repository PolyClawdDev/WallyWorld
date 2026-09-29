/*
 * One account per player: guest play, the signed claim, and the two explicit
 * resolutions when a wallet already belongs to somebody.
 *
 * The signatures here are real ed25519 signatures over the real SIWS message, so
 * a break in the message layout or the challenge binding fails this suite rather
 * than passing it with a stub.
 *
 * Run with: npm run test:identity
 */
import { createHash, randomBytes } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import bs58 from 'bs58'
import { useTestDatabases, check, equal, section, finish } from './lib/harness'

useTestDatabases('test-identity')

const { buildSiwsMessage, SIWS_VERSION, SIWS_STATEMENT } = await import('../src/shared/siws')
const { CHAIN_ID } = await import('../src/server/config')
const { saveSession, writeProfile, readProfile } = await import('../src/server/db')
const { resolveUserForPrincipal, walletOwner, walletsFor, principalsFor, readUser, followMerges, hashGuestKey, linkHistory } =
  await import('../src/server/identity/users')
const { issueClaimChallenge, verifyClaim, resolveClaimConflict, LINK_STATEMENT } = await import('../src/server/identity/claim')
const { grantStartingGold, creditGold, goldSnapshot, ensureGoldAccounts } = await import('../src/server/money/gold')
const { balanceOf, playerAvailable, conservationReport, eligibilityOf } = await import('../src/server/money/ledger')
const { DEFAULT_PROFILE } = await import('../src/shared/profile')

const DOMAIN = 'voxels.test'
const URI = 'https://voxels.test'

type Wallet = { address: string; sign: (message: string) => string }

function newWallet(): Wallet {
  const secret = ed25519.utils.randomSecretKey()
  const publicKey = ed25519.getPublicKey(secret)
  return {
    address: bs58.encode(publicKey),
    sign: (message: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret)),
  }
}

/** A live session, and the hash the server knows it by. */
function newSession(principal: string): string {
  const token = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  saveSession(hash, principal, Date.now(), Date.now() + 60 * 60 * 1000)
  return hash
}

const signChallenge = (wallet: Wallet, fields: Parameters<typeof buildSiwsMessage>[0]) =>
  wallet.sign(buildSiwsMessage({ ...fields, statement: LINK_STATEMENT }))

/* ------------------------------------------------------------ guest play */

section('a guest is a real server-side account')

const guestKey = randomBytes(32).toString('hex')
const guestPrincipal = `gst_${hashGuestKey(guestKey).slice(0, 24)}`
const guest = resolveUserForPrincipal(guestPrincipal)
check('the guest got an account', guest.created && guest.userId.length > 0, guest.userId)
equal('recognised as a guest principal', guest.kind, 'guest')
equal('resolving the same guest twice is the same account', resolveUserForPrincipal(guestPrincipal).userId, guest.userId)
equal('one principal, not two', principalsFor(guest.userId).length, 1)

grantStartingGold(guest.userId)
creditGold({ userId: guest.userId, amount: 320n, provenance: 'hunt_verified', idemScope: 'kill', idemKey: 'g-1', note: 'guest hunt' })
writeProfile(guestPrincipal, { ...DEFAULT_PROFILE, playerName: 'Wisp', character: 'CINDER' }, 'test')

const goldBeforeClaim = goldSnapshot(guest.userId)
const profileBeforeClaim = readProfile(guestPrincipal)
equal('the guest has a character', profileBeforeClaim?.profile.character, 'CINDER')
equal('the guest has gold', goldBeforeClaim.total, 570n)
equal('and redeemable headroom from hunting', goldBeforeClaim.redeemable, 320n)

/* -------------------------------------------------------- claiming it */

section('claiming with a wallet proves control and keeps the account')

const playerWallet = newWallet()
const session = newSession(guestPrincipal)

check('a wallet that has never signed owns nothing', walletOwner(playerWallet.address) === null)

const challenge = issueClaimChallenge({
  userId: guest.userId,
  wallet: playerWallet.address,
  domain: DOMAIN,
  uri: URI,
  sessionHash: session,
})
equal('the challenge binds this application', challenge.fields.domain, DOMAIN)
equal('and this wallet', challenge.fields.address, playerWallet.address)
equal('and carries a 32-byte nonce', challenge.fields.nonce.length, 64)
check('and expires', challenge.expiresAtMs > Date.now())
check('the link statement is not the sign-in statement', LINK_STATEMENT !== SIWS_STATEMENT)

// Wrong key, right message: this is the "wallet connection is not proof" case.
const impostor = newWallet()
const forged = verifyClaim({
  userId: guest.userId,
  sessionHash: session,
  wallet: playerWallet.address,
  nonce: challenge.fields.nonce,
  signature: signChallenge(impostor, challenge.fields),
})
check('a signature from another key is refused', !forged.ok, forged.ok ? 'it linked' : forged.reason)

// Right key, wrong session: the challenge is bound to the session that asked for it.
const otherSession = newSession(guestPrincipal)
const wrongSession = verifyClaim({
  userId: guest.userId,
  sessionHash: otherSession,
  wallet: playerWallet.address,
  nonce: challenge.fields.nonce,
  signature: signChallenge(playerWallet, challenge.fields),
})
check('a challenge cannot be redeemed from a different session', !wrongSession.ok,
  wrongSession.ok ? 'it linked' : wrongSession.reason)

// A sign-in signature must not work as a link signature: different bytes.
const signInBytes = playerWallet.sign(buildSiwsMessage({ ...challenge.fields, statement: SIWS_STATEMENT }))
const crossReplay = verifyClaim({
  userId: guest.userId,
  sessionHash: session,
  wallet: playerWallet.address,
  nonce: challenge.fields.nonce,
  signature: signInBytes,
})
check('a sign-in signature cannot be replayed as a link', !crossReplay.ok,
  crossReplay.ok ? 'it linked' : crossReplay.reason)

const claimed = verifyClaim({
  userId: guest.userId,
  sessionHash: session,
  wallet: playerWallet.address,
  nonce: challenge.fields.nonce,
  signature: signChallenge(playerWallet, challenge.fields),
})
check('a correct signature links the wallet', claimed.ok && claimed.kind === 'linked',
  claimed.ok ? claimed.kind : claimed.reason)

const replay = verifyClaim({
  userId: guest.userId,
  sessionHash: session,
  wallet: playerWallet.address,
  nonce: challenge.fields.nonce,
  signature: signChallenge(playerWallet, challenge.fields),
})
check('the nonce cannot be used twice', !replay.ok, replay.ok ? 'it linked again' : replay.reason)

section('nothing was reset, duplicated or granted')

equal('the wallet belongs to the guest account', walletOwner(playerWallet.address), guest.userId)
equal('resolving by wallet finds that same account, not a new one',
  resolveUserForPrincipal(playerWallet.address).userId, guest.userId)
check('resolving by wallet created nothing', !resolveUserForPrincipal(playerWallet.address).created)
equal('resolving by the guest key still finds it too', resolveUserForPrincipal(guestPrincipal).userId, guest.userId)
equal('one linked wallet', walletsFor(guest.userId).length, 1)
// Reading by the wallet must find the character that already existed under the
// guest key. This is the assertion that linking did not start a fresh save.
equal('the character survived the claim', readProfile(playerWallet.address)?.profile.character, 'CINDER')
equal('the name survived the claim', readProfile(playerWallet.address)?.profile.playerName, 'Wisp')
equal('gold is unchanged — linking grants nothing', goldSnapshot(guest.userId).total, goldBeforeClaim.total)
equal('redeemable headroom is unchanged', goldSnapshot(guest.userId).redeemable, goldBeforeClaim.redeemable)
equal('the account is marked claimed', readUser(guest.userId)?.status, 'active')
check('the claim is recorded in the account history', linkHistory(guest.userId).length >= 1)

/* --------------------------------------------------- wallet already taken */

section('a wallet that already belongs to someone forces an explicit choice')

const secondGuestKey = randomBytes(32).toString('hex')
const secondPrincipal = `gst_${hashGuestKey(secondGuestKey).slice(0, 24)}`
const second = resolveUserForPrincipal(secondPrincipal)
check('a second guest account exists', second.userId !== guest.userId)
grantStartingGold(second.userId)
const secondSession = newSession(secondPrincipal)

const conflictChallenge = issueClaimChallenge({
  userId: second.userId,
  wallet: playerWallet.address,
  domain: DOMAIN,
  uri: URI,
  sessionHash: secondSession,
})
const conflict = verifyClaim({
  userId: second.userId,
  sessionHash: secondSession,
  wallet: playerWallet.address,
  nonce: conflictChallenge.fields.nonce,
  signature: signChallenge(playerWallet, conflictChallenge.fields),
})
check('a good signature over a taken wallet asks rather than guessing',
  conflict.ok && conflict.kind === 'choice_required', conflict.ok ? conflict.kind : conflict.reason)
if (conflict.ok && conflict.kind === 'choice_required') {
  equal('it names the account that holds the wallet', conflict.otherUserId, guest.userId)
}
equal('nothing moved while the choice is pending', walletOwner(playerWallet.address), guest.userId)

// The resolution is authorised by the nonce, which only reached `pending_choice`
// after a verified signature from this session. No request field selects the
// account or the wallet.
const fromWrongSession = resolveClaimConflict({
  userId: second.userId,
  sessionHash: session,
  nonce: conflictChallenge.fields.nonce,
  action: 'merge',
})
check('another session cannot resolve this decision', !fromWrongSession.ok,
  fromWrongSession.ok ? 'it resolved' : fromWrongSession.reason)
check('a made-up action is refused',
  !resolveClaimConflict({ userId: second.userId, sessionHash: secondSession, nonce: conflictChallenge.fields.nonce, action: 'take' }).ok)
check('a made-up nonce is refused',
  !resolveClaimConflict({ userId: second.userId, sessionHash: secondSession, nonce: 'f'.repeat(64), action: 'merge' }).ok)

section('merge: one account absorbs the other')

const guestGoldBeforeMerge = balanceOf(playerAvailable(guest.userId))
const secondGoldBeforeMerge = balanceOf(playerAvailable(second.userId))
const merged = resolveClaimConflict({
  userId: second.userId,
  sessionHash: secondSession,
  nonce: conflictChallenge.fields.nonce,
  action: 'merge',
})
check('the merge was applied', merged.ok && merged.action === 'merge', merged.ok ? merged.action : merged.reason)
equal('the surviving account is the wallet holder', merged.ok ? merged.userId : '', guest.userId)
equal('the merged-away account points at the survivor', followMerges(second.userId), guest.userId)
equal('it is marked merged', readUser(second.userId)?.status, 'merged')
equal('its gold arrived', balanceOf(playerAvailable(guest.userId)), guestGoldBeforeMerge + secondGoldBeforeMerge)
equal('and left', balanceOf(playerAvailable(second.userId)), 0n)
equal('the merge did not manufacture redeemable headroom', eligibilityOf(guest.userId).accrued, 320n)
equal('the guest key now resolves to the survivor', resolveUserForPrincipal(secondPrincipal).userId, guest.userId)
equal('still one account holding the wallet', walletOwner(playerWallet.address), guest.userId)

section('switch: the session adopts the wallet\'s account, and nothing moves')

const thirdPrincipal = `gst_${hashGuestKey(randomBytes(32).toString('hex')).slice(0, 24)}`
const third = resolveUserForPrincipal(thirdPrincipal)
grantStartingGold(third.userId)
ensureGoldAccounts(third.userId)
const thirdSession = newSession(thirdPrincipal)

const switchChallenge = issueClaimChallenge({
  userId: third.userId,
  wallet: playerWallet.address,
  domain: DOMAIN,
  uri: URI,
  sessionHash: thirdSession,
})
const switchConflict = verifyClaim({
  userId: third.userId,
  sessionHash: thirdSession,
  wallet: playerWallet.address,
  nonce: switchChallenge.fields.nonce,
  signature: signChallenge(playerWallet, switchChallenge.fields),
})
check('the conflict is raised again', switchConflict.ok && switchConflict.kind === 'choice_required')

const thirdGoldBefore = balanceOf(playerAvailable(third.userId))
const survivorGoldBefore = balanceOf(playerAvailable(guest.userId))
const switched = resolveClaimConflict({
  userId: third.userId,
  sessionHash: thirdSession,
  nonce: switchChallenge.fields.nonce,
  action: 'switch',
})
check('the switch was applied', switched.ok && switched.action === 'switch', switched.ok ? switched.action : switched.reason)

// "Switch" means the player continues as the account the wallet already owns. The
// wallet deliberately does not move: taking it off its existing account would
// leave that account with no way to sign in, which is a worse outcome than asking
// the player to pick the account they actually meant.
equal('the answer is the account the wallet owns', switched.ok ? switched.userId : '', guest.userId)
equal('the wallet stays where it was', walletOwner(playerWallet.address), guest.userId)
equal('the wallet\'s account keeps its gold', balanceOf(playerAvailable(guest.userId)), survivorGoldBefore)
equal('the switching account keeps its gold', balanceOf(playerAvailable(third.userId)), thirdGoldBefore)
equal('neither account was merged away', readUser(third.userId)?.status, 'active')
equal('the wallet\'s account keeps its character', readProfile(guestPrincipal)?.profile.character, 'CINDER')
check('the switch is recorded against the account switched to',
  linkHistory(guest.userId).some(entry => entry.action === 'switch'),
  JSON.stringify(linkHistory(guest.userId).map(entry => entry.action)))
check('a third claim on the same nonce is refused',
  !resolveClaimConflict({ userId: third.userId, sessionHash: thirdSession, nonce: switchChallenge.fields.nonce, action: 'merge' }).ok)

/* -------------------------------------------------------------- redaction */

section('a session token cannot reach a log line or a response body')

const { redact, redactDeep, looksUnredacted } = await import('../src/server/redact')

const liveToken = randomBytes(32).toString('base64url')
check('a bearer header is scrubbed', !looksUnredacted(redact(`Authorization: Bearer ${liveToken}`)),
  redact(`Authorization: Bearer ${liveToken}`))
// The PvP socket carries its session in the upgrade URL, because a browser cannot
// set a header on a WebSocket handshake. An upgrade URL is exactly what a
// connection error quotes, so this is a real leak path rather than a theoretical one.
const upgrade = `ws://localhost:8787/ws/pvp?token=${liveToken}&room=1`
check('a token in a websocket upgrade url is scrubbed', !looksUnredacted(redact(upgrade)), redact(upgrade))
check('the rest of the url survives, so the log stays useful', redact(upgrade).includes('/ws/pvp'))
check('a guest key in a query string is scrubbed', !looksUnredacted(redact(`/api/pvp/guest?guestKey=${guestKey}`)))
check('nested objects are scrubbed too',
  !looksUnredacted(JSON.stringify(redactDeep({ headers: { authorization: `Bearer ${liveToken}` } }))))
check('an ordinary log line is left alone', redact('opened hunt h_abc for level 9') === 'opened hunt h_abc for level 9')
// A freshly issued token is returned to the client as a JSON field and the client
// needs it, so the scrubber must not match that shape.
check('a sign-in response can still carry its own token',
  redact(JSON.stringify({ token: liveToken })).includes(liveToken))

/* ------------------------------------------------------------ conservation */

section('the ledger balances after all of that')

const report = conservationReport()
check('balances sum to zero', report.balanceSum === 0n, report.balanceSum.toString())
check('no transfer is half-written', report.unbalancedTransfers.length === 0)
check('no balance drifted', report.driftedAccounts.length === 0)

finish('identity')
