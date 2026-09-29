# AgentDeck relay

The relay lets a paired owner phone use Personal tasks and decisions when it is
not on the Mac's network, without Tailscale and without opening a port on the
Mac. The Mac dials **out** to the relay; the phone dials the relay too; the
relay forwards sealed frames between them. It is issue #90 (Everyday 15).

The Mac keeps the task database and makes every model call. The phone keeps no
task data. The relay keeps nothing on disk.

## What the relay can and cannot see

Every request and answer is sealed end to end between the phone and the Mac
(`src/relay/channel.ts`: an X25519 handshake bound to the keys exchanged at
pairing, then ChaCha20-Poly1305 with a fresh key per connection and per
direction). The relay holds no key that opens a frame.

The relay **can** see:

- each Mac's **mailbox id**: a hash of the Mac's relay signing key. It is stable
  for that Mac and appears in the pairing QR code;
- when a Mac and each phone connect and disconnect, and from which **IP
  address**;
- the **size and timing** of every frame, so it can tell that traffic
  happened, and roughly how much;
- the **APNs device token** of each phone the Mac asks it to notify, and when.

The relay **cannot**:

- read a task, a file name, a folder, a proposal, a decision, a device name,
  or the phone's credential: they are inside sealed frames;
- act as the owner. The Mac decides everything. It checks that the phone's
  handshake key belongs to an active paired phone, and that the sealed
  credential belongs to that same phone. It then runs the request through the
  same owner-phone allowlist a direct connection meets. A key the Mac has not
  paired may only pair, and only with a fresh QR code from the Mac's screen;
- impersonate the Mac. The phone learns the Mac's key from the QR code by
  camera, and the handshake fails for any other key. Registering someone
  else's mailbox needs that Mac's signing key.

Pushes carry one fixed message, "Something on your Mac needs you." They carry
no task content. The phone opens and asks the Mac what changed.

## Running it

```sh
npm run relay                      # local, ws://0.0.0.0:8080; for development
docker build -f relay/Dockerfile -t agentdeck-relay .
docker run -p 8080:8080 agentdeck-relay
```

Put it behind TLS: phones and the Mac use `wss://`. The Mac refuses a
`ws://` relay unless it is on the Mac itself. `relay/fly.toml` is one ready
setup (Fly.io terminates TLS; the relay listens on 8080 inside the machine).
Any host that can proxy WebSockets works.

Environment:

| Variable | Meaning |
| --- | --- |
| `PORT` or `RELAY_PORT` | Port to listen on (8080). |
| `RELAY_HOST` | Interface to bind (`0.0.0.0` in a container). |
| `RELAY_TRUST_PROXY` | `1` behind a proxy that sets `X-Forwarded-For` (set in `fly.toml`), so per-address limits see the caller. Leave unset otherwise: the header could be forged. |
| `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` | Optional. Your Apple Developer APNs auth key (.p8), its key id, your team id, and the phone app's bundle id. All four turn pushes on; without them the relay sends none. |

Then, on the Mac: **Settings › Owner phones › Away from home**, enter the
`wss://` address and save. The Mac connects at once and after every restart.

## Limits

The relay is open to the internet, so it caps what any one caller can hold:

- ten Mac registrations per address per minute;
- 32 phone connections per Mac, at most four from one address;
- a phone must send its first frame within ten seconds;
- one push per phone per 30 seconds, and 60 per Mac per hour.

The Mac adds two limits of its own. A connection must finish the handshake
within 15 seconds. A key the Mac has not paired may stay connected for three
minutes, which is long enough to pair.

Anyone can register a mailbox, and a registered Mac can ask for a push to any
APNs token. The caps above keep the operator's APNs key from becoming a free
sender. Each push is only the fixed pointer.

## Recovery

- **Relay down or unreachable.** Phones away from home show *Mac unavailable*,
  and never old data presented as live. On the home network they reach the Mac
  directly as before. The Mac retries with backoff, up to once a minute, and
  Settings shows the relay as unreachable. Nothing is lost: tasks stay in the
  Mac's database, and the phone reloads them once it reconnects.
- **Mac asleep, offline, or AgentDeck quit.** The relay tells the phone at once
  (close code 4404, `mac-offline`), and the phone shows *Mac unavailable*.
- **Lost or stolen phone.** Revoke it on the Mac: **Settings › Owner phones ›
  Revoke**. This takes effect at the next frame. The phone's credential stops
  resolving, its key and push token are forgotten, and its open relay
  connections are dropped. Its key could now only start a new pairing, which
  needs a QR code shown on the Mac.
- **Rotating a phone's key.** Pair again, or re-enroll from the home network:
  AgentDeck Phone sends its new key over a direct connection. A key can never
  be set or changed through the relay.
- **Rotating the Mac's keys.** Delete the `AgentDeck Relay` item in the Mac's
  login Keychain and restart AgentDeck. It makes new keys and a new mailbox.
  Every phone must then pair again: the old key and mailbox no longer answer.
- **Moving to another relay.** Change the address in Settings. A phone paired
  over Tailscale learns the new address the next time it reaches the Mac
  directly. A phone paired only through the relay has no direct path to the
  Mac, so it must pair again from a new QR code.
- **A request with no answer.** A phone that gets no answer within 15 seconds
  ends the connection and shows *Mac unavailable*. The next request starts a
  new connection.
- **Upgrading from before the relay.** Migration 031 only adds columns. A phone
  paired over Tailscale keeps working. The next time it reaches the Mac
  directly, it enrolls its key and learns the relay address, so no re-pairing
  and no task is lost.
