# OverSync v2 — Architecture

> **Status:** OverSync is being rebuilt as a non-custodial, multi-resolver,
> HTLC-based bridge between Ethereum and Stellar. This document tracks the
> **target** architecture. Code in this repository is in the middle of the
> v1 → v2 transition; sections that describe behaviour not yet shipped are
> marked **`(planned)`**.

Bridges are responsible for some of the largest losses in DeFi history.
Reviewers and integrators are right to demand a precise, verifiable
description of how a bridge works before trusting it with funds. This
document is intentionally exhaustive on the points that matter — trust
boundaries, atomicity invariants, failure modes, and the exact ledger
state we modify — so a reader can audit the design before reading code.

---

## 1. Design goals

OverSync v2 is built around three load-bearing properties.

### 1.1 Non-custodial by construction

User funds are locked in HTLC contracts on both chains. The contracts
have no admin escape hatch (no `emergencyWithdraw`, no `pause`, no
`upgradeTo`). Locked funds can only move under exactly two on-chain
conditions:

1. A caller submits a `preimage` such that
   `sha256(preimage) == hashlock` (or `keccak256(preimage) == hashlock`
   on the EVM side) **and** `block.timestamp <= timelock`. The locked
   amount goes to `beneficiary`.
2. `block.timestamp > timelock` and any caller invokes `refund_order`.
   The locked amount returns to `refund_address`, which the contract
   pins to the original user at order-creation time.

Any other call path reverts. The deployer's key, the coordinator's
key, and the resolver's key cannot circumvent these conditions.

### 1.2 Multi-resolver

Anyone can register as a resolver by staking an ERC-20 (Ethereum side)
or Stellar asset (Stellar side) into the `ResolverRegistry`. The
registry exposes `isActive(address) → bool` which the HTLC contract
reads to gate **order creation** (so the off-chain order book stays
sybil-resistant). The registry does **not** gate `claim` or `refund` —
those remain permissionless even after registry compromise.

Misbehaviour is slashable by the registry owner (intended to become a
2-of-3 multisig before mainnet, then a Timelock+Governor DAO before
high TVL). Slashing routes funds to a `slashBeneficiary`, not to the
admin EOA.

### 1.3 Symmetric HTLC semantics

Both contracts enforce the same invariants with the same parameters:

| Parameter | Ethereum (`HTLCEscrow.sol`) | Stellar (`oversync-htlc`) |
|---|---|---|
| Minimum timelock | `MIN_TIMELOCK = 300` (5 min) | `MIN_TIMELOCK_SECONDS = 300` |
| Maximum timelock | `MAX_TIMELOCK = 86_400` (24 h) | `MAX_TIMELOCK_SECONDS = 86_400` |
| Hashlock digest | sha256 **or** keccak256 of preimage | sha256 of preimage |
| Refund delivery | permissionless, paid to `refundAddress` | permissionless, paid to `refund_address` |
| Safety deposit | configurable via `minSafetyDeposit` | configurable via `min_safety_deposit` |
| Admin role over locked funds | none | none |

The EVM contract accepts either sha256 or keccak256 because EVM tooling
expects keccak by default but the Soroban side can only verify sha256.
A single cross-chain swap uses sha256 end-to-end; the keccak path is
provided for compatibility with classic EVM-only HTLC flows.

---

## 2. Why HTLCs (and not validator-set or attester bridges)

OverSync deliberately gives up some properties of validator-set
bridges in exchange for a strictly weaker trust assumption. The
[`docs/DIFFERENTIATION.md`](docs/DIFFERENTIATION.md) document covers
the competitive landscape in detail; in short:

| Compromise that lets attacker steal locked funds | Validator-set bridge (Axelar ITS, Allbridge, Wormhole-style) | OverSync v2 |
|---|---|---|
| Compromise an off-chain signer quorum | **Yes** | **No** — no privileged signer exists in the HTLC |
| Compromise a first-party attester service (Circle, etc.) | **Yes** (for CCTP-style bridges) | **No** — no attester is consulted |
| Break sha256 | No | Yes, but this breaks all of crypto |
| Compromise Ethereum or Stellar consensus | Yes (both) | Yes (both) |

In other words, OverSync inherits the trust assumptions of the
underlying chains and adds nothing on top. The reward of this trade is
weaker — slower UX, higher per-swap gas overhead, no support for
arbitrary chains without an HTLC on each — and we accept that.

---

## 3. High-level layout

```
┌──────────────────────────┐                           ┌──────────────────────────┐
│ Ethereum                 │ ◄────── user wallet ────► │ Stellar                  │
│                          │                           │                          │
│  HTLCEscrow              │                           │  oversync-htlc           │
│   ├─ createOrder         │                           │   ├─ create_order        │
│   ├─ claimOrder          │                           │   ├─ claim_order         │
│   └─ refundOrder         │                           │   └─ refund_order        │
│                          │                           │                          │
│  ResolverRegistry        │                           │  oversync-resolver-      │
│   ├─ register/stake      │                           │  registry                │
│   ├─ isActive            │                           │   ├─ register/stake      │
│   └─ slash               │                           │   └─ is_active           │
└──────────┬───────────────┘                           └─────────────┬────────────┘
           │ logs / events                                            │ events
           ▼                                                          ▼
     ┌─────────────────────────────────────────────────────────────────────┐
     │                       Reference Coordinator                        │
     │                                                                    │
     │   - watches both chains for HTLC events                            │
     │   - maintains the public order book (REST + WebSocket)             │
     │   - relays the preimage between chains the moment it appears       │
     │   - persists order state to SQLite / Postgres                      │
     │                                                                    │
     │   - HAS NO KEYS THAT CAN MOVE USER FUNDS                           │
     └──────────────────────┬──────────────────────┬───────────────────────┘
                            │                      │
              ┌─────────────▼───────────┐  ┌───────▼──────────────────┐
              │ Community resolver A    │  │ Community resolver B     │
              │  (open source runner +  │  │  (any team that staked   │
              │   Docker image)         │  │   into the registry)     │
              └─────────────────────────┘  └──────────────────────────┘
```

Funds never sit anywhere except the two HTLC contracts. The
coordinator is a high-availability metadata service; the resolvers
are independent economic actors.

---

## 4. The atomic-swap flow

### 4.1 Direction: ETH → XLM

```
participant User
participant ETH as HTLCEscrow.sol
participant Coord as Coordinator
participant Resolver
participant XLM as oversync-htlc

User -> Coord: POST /orders { fromAsset=ETH, toAsset=XLM, amount, beneficiary }
Coord -> Coord: secret = random32(); hashlock = sha256(secret)
Coord -> User: { orderId, hashlock, timelock_eth, timelock_xlm }

User -> ETH: createOrder(beneficiary=resolver, hashlock, timelock_eth, asset=ETH, amount)  # locks user's ETH
ETH -> ETH: emit OrderCreated(orderId, hashlock, timelock_eth)
Coord <- ETH: event ingested

Coord -> Resolver: offer order
Resolver -> XLM: create_order(beneficiary=user, refund_address=resolver, hashlock, timelock_xlm, asset=XLM, amount)
                # locks resolver's XLM
XLM -> XLM: emit OrderCreated
Coord <- XLM: event ingested

Coord -> User: order ready
User -> XLM: claim_order(order_id, preimage=secret)   # user receives XLM
XLM -> XLM: emit OrderClaimed(order_id, preimage)
Coord <- XLM: event ingested; preimage now public

Coord -> Resolver: preimage is on-chain on Stellar
Resolver -> ETH: claimOrder(orderId, preimage=secret)  # resolver receives ETH
```

Both legs settle or both legs refund — the cryptographic
correspondence guarantees it:

- If the user claims XLM first, the preimage is revealed on Stellar.
  The resolver (or anyone) can then claim ETH on Ethereum using the
  same preimage before `timelock_eth` expires.
- If the user never claims, `timelock_xlm < timelock_eth` is chosen so
  the resolver's Stellar refund expires first and they recover their
  XLM safely. Once the resolver refunds, the user can refund their
  Ethereum side after `timelock_eth`.

### 4.2 Direction: XLM → ETH

Symmetric, with the roles of the two chains swapped. The Soroban
contract emits `OrderCreated` and `OrderClaimed` events with the same
shape as the EVM side, so the coordinator's listener logic is shared.

### 4.3 Timelock ordering invariant

To preserve atomicity, the destination-side timelock is **shorter**
than the source-side timelock. By convention:

```
timelock_source = now + 24 h        # user-side
timelock_dest   = now + 12 h        # resolver-side
```

This ordering ensures the resolver's destination refund expires first.
If the user delays past the destination refund, the resolver gets its
funds back and the user's source side will refund 12h later. If the
ordering were reversed, the user could claim destination after the
source had already refunded — breaking atomicity. The contracts
enforce only the absolute bounds (`MIN_TIMELOCK ≤ t ≤ MAX_TIMELOCK`);
the ordering invariant is enforced by the coordinator's order builder
and verified by the resolver before it locks destination-side funds.

---

## 5. Components

### 5.1 Ethereum contracts (`contracts/contracts/v2/`)

#### `HTLCEscrow.sol`

- `createOrder(...) returns (uint256 orderId)` — locks `amount` of
  `asset` (native ETH or any ERC-20) under `hashlock` and `timelock`.
  Optionally gated by `ResolverRegistry.isActive`. Stores
  `refundAddress = msg.sender`; this can never be re-pointed.
- `claimOrder(uint256 orderId, bytes32 preimage)` — pays the locked
  amount to `beneficiary` if `sha256(preimage) == hashlock` or
  `keccak256(preimage) == hashlock`, and the safety deposit to
  `msg.sender`.
- `refundOrder(uint256 orderId)` — permissionless after `timelock`.
  Pays the locked amount to `refundAddress` and the safety deposit to
  `msg.sender`.
- `MIN_TIMELOCK = 300` (5 min), `MAX_TIMELOCK = 86_400` (24 h).
- No `onlyOwner` function exists. No admin role can move locked
  funds. Verified by Hardhat test
  `non-custodial guarantees > contract has no admin escape hatch`.
- `ReentrancyGuard` on every state-changing function.
- ERC-20 transfers use OpenZeppelin `SafeERC20`.

#### `ResolverRegistry.sol`

- `register(uint256 stake)` — stakes `stakeAsset` into the registry.
- `increaseStake(uint256 delta)` / `unregister()` — let resolvers
  adjust their own stake.
- `isActive(address resolver) → bool` — read by `HTLCEscrow`.
- `slash(address resolver, uint256 amount)` — `onlyOwner`, sends
  `stakeAsset` to `slashBeneficiary` (not to the owner).
- `Ownable2Step` for owner transfer (no single-tx hijack).

### 5.2 Soroban contracts (`soroban/contracts/`)

#### `oversync-htlc`

- `create_order(env, sender, beneficiary, refund_address, hashlock,
  timelock, asset, amount, safety_deposit)` — locks the asset under
  the standard HTLC commitments. Stores the entire order in a
  Soroban `Map<u64, Order>` keyed by an autoincrementing
  `next_order_id`. Emits the `OrderCreated` event.
- `claim_order(env, order_id, preimage)` — `sha256(preimage) ==
  hashlock` and `env.ledger().timestamp() <= timelock` are required.
  Asset transferred to `beneficiary`, safety deposit to `caller`.
- `refund_order(env, order_id)` — permissionless after `timelock`;
  asset to `refund_address`, safety deposit to `caller`.
- 10 unit tests in `soroban/contracts/htlc/src/test.rs` covering
  happy path, wrong preimage, expiry, double claim, refund after
  claim, timelock bounds, safety deposit minimum, admin
  initialisation.

#### `oversync-resolver-registry`

- `register(env, resolver, stake_token, amount)` —
  stake-transferred into the contract.
- `unregister(env, resolver)` — refund stake if not slashed.
- `slash(env, resolver, amount)` — admin-only; sends to
  `slash_beneficiary`.
- `is_active(env, resolver) → bool`.

### 5.3 Coordinator (`coordinator/`)

A reference Node.js service split into the following modules:

| Module | Responsibility |
|---|---|
| `src/listeners/ethereum-listener.ts` | viem `watchEvent` subscription to `HTLCEscrow` logs. Tags each event with block number for ordering. |
| `src/listeners/soroban-listener.ts` | Polls `getEvents` against the Soroban RPC; resumes from the last persisted ledger sequence on restart. |
| `src/state-machine/order-machine.ts` | XState-style state machine: `Created → Locked → SecretRevealed → Claimed | Refunded | Expired`. The same machine is exported from the SDK so the frontend and coordinator agree on transitions. |
| `src/services/order-service.ts` | Drives orders through the state machine. Refuses transitions that would violate invariants. |
| `src/services/quote-service.ts` | CoinGecko-backed price quote; not on the critical path for fund safety, only for displaying expected outcomes. |
| `src/services/secret-service.ts` | Generates secrets, hashes them, and persists them encrypted-at-rest. Only releases a secret if the corresponding on-chain HTLC has been observed locked. |
| `src/persistence/` | `node:sqlite` (Postgres for production). Schema in `schema.sql`. Order rows are immutable except for the `status` and `last_event_block` fields. |
| `src/server/` | Express routes for `/health`, `/orders`, `/quotes`, `/secrets`. JSON Schema-validated via zod. |
| `src/index.ts` | < 200 lines of bootstrap. The old 3,276-line `relayer/src/index.ts` is gone. |

The coordinator has **no private keys that can move user funds**. It
holds a server-side key only for signing its own metadata responses
(if at all) and for posting transactions to its own RPC endpoint
(no signing authority on the HTLC contracts).

### 5.4 Resolver runner (`resolver/`)

A standalone TypeScript CLI plus Docker image. Anyone who has staked
into the `ResolverRegistry` can run an instance:

```bash
docker run ghcr.io/oversync/resolver:latest register
docker run ghcr.io/oversync/resolver:latest run
```

The runner subscribes to the coordinator's order book and on-chain
events, decides which orders to fill (based on its own pair/amount
configuration), and signs the destination-side HTLC creation. The
runner ships with sensible defaults but every parameter is
configurable; community resolvers are not bound to OverSync's
reference economics.

### 5.5 Frontend (`frontend/`)

React 18 + Vite. Key behaviours relevant to architecture:

- All HTLC interactions go through `@oversync/sdk` so the frontend
  shares the secret-generation and state-machine code with the
  coordinator. There is no second source of truth.
- Network mode is centralised in
  [`src/lib/useNetworkMode.ts`](frontend/src/lib/useNetworkMode.ts):
  the URL `?network=`, the MetaMask chain id, and the Freighter network
  passphrase are reconciled. A `NetworkMismatchBanner` warns and
  offers one-click reconciliation when they diverge.
- `RefundDialog` calls `refundOrder` directly from the user's wallet,
  so users can recover funds without the coordinator participating.
- All `console.*` calls are stripped from production bundles via
  Vite's `esbuild.drop` and source maps are disabled, so demo
  visitors do not see internal state in devtools.

### 5.6 SDK (`packages/sdk/`)

`@oversync/sdk` is the shared layer:

- `EthereumHTLCClient` (viem-based) — typed wrapper around the EVM
  contract.
- `SorobanHTLCClient` — typed wrapper around the Soroban contract;
  signer is a callback so any wallet integration plugs in.
- `secrets/` — `generateSecret`, `hashSecret`, `verifyPreimage` with
  sha256 + keccak256 support.
- `state-machine/` — the shared state machine consumed by the
  coordinator and the frontend.
- `types/` — `Order`, `OrderStatus`, `ChainLeg`, `ResolverInfo`,
  `Direction`.

---

## 6. Failure mode catalogue

This catalogue is exhaustive within the v2 scope. Every condition
described here either leaves user funds recoverable or is impossible
by the contract invariants.

| Scenario | What happens | User outcome |
|---|---|---|
| Coordinator goes down between user-source-lock and secret-reveal | Resolver can still observe source-side event and fill the destination side. If resolver also missed the order, both sides eventually refund after their timelocks. | Funds refunded automatically. |
| Coordinator returns malicious data to frontend | Frontend's contract calls are signed by the user's wallet, not the coordinator. Malicious data can mislead the UI but cannot move funds. | No fund loss. |
| Resolver fills destination then withholds preimage | Resolver's destination-side refund expires first (12h vs 24h). Resolver loses gas + stake-slashable reputation. User refunds source side after 24h. | Funds refunded after worst-case 24h. |
| User loses the secret | Secret is generated by the SDK; if the user never claims, the order falls through to refund at timelock expiry. | Source funds refunded. |
| Sepolia/mainnet RPC rate-limited mid-claim | The contract call is idempotent — user can retry. As long as the call lands before `timelock`, the claim succeeds. | No loss. |
| Soroban network halts past `timelock` | Once the network resumes, anyone can call `refund_order`. The contract has no expiry of the order record. | Funds refunded once network resumes. |
| Ethereum reorg removes source lock | The destination side has not yet been filled because the resolver waits for source-side finality before locking destination. Resolver simply doesn't fill the reorged order. | No fund loss; order silently expires. |
| Admin EOA of `ResolverRegistry` is stolen | Attacker can slash legitimate resolvers, redirecting their stakes to `slashBeneficiary`. They cannot touch user HTLC funds. Loss is bounded by total stake at risk. | No user fund loss. Resolver stake loss is bounded; admin should already be a multisig before mainnet (see `docs/TRUST_MODEL.md`). |
| Wrong-preimage submission to `claimOrder` | Contract reverts. No state change. | No effect. |
| Two simultaneous `claimOrder` calls with the correct preimage | Whichever lands first wins; the other reverts because the order is no longer in `Locked` status. Safety deposit pays the winner. | First caller wins, no funds lost. |

---

## 7. Security boundaries: what is enforced where

This table is what an auditor should grep against.

| Invariant | Enforced by | Test that verifies it |
|---|---|---|
| Locked funds can only leave the contract via `claim` (preimage match + before timelock) or `refund` (after timelock) | `HTLCEscrow.sol` `claimOrder`/`refundOrder` require statements; same in `oversync-htlc` | `claim_with_wrong_preimage_fails`, `claim_after_expiry_fails`, `refund_before_timeout_fails` |
| Refund always pays the original user | `_orders[orderId].refundAddress` set to `msg.sender` at create-time, immutable | `returns the locked amount to the refund address after timeout, permissionlessly` |
| No admin can move locked funds | No fund-moving function has `onlyOwner`; no `emergencyWithdraw` exists | `non-custodial guarantees > contract has no admin escape hatch` |
| Resolver allowlist is only consulted for `create`, not `claim`/`refund` | `claimOrder` and `refundOrder` do not call `ResolverRegistry` | `claim_works_even_when_registry_is_address_zero` (planned) |
| Stake can only be slashed by registry admin, to `slashBeneficiary` | `ResolverRegistry.slash` is `onlyOwner` and routes to a fixed beneficiary | `slash routes funds to beneficiary, not owner` |
| Coordinator cannot fabricate orders | Order creation requires an on-chain transaction signed by the user's wallet | (manual / out-of-band; demonstrated in `docs/TRUST_MODEL.md`) |
| Coordinator cannot replay an old preimage | Each order has a unique `hashlock`; the SDK refuses to reuse a hashlock | SDK test `verifyPreimage` |

---

## 8. Trust model summary

Three actors are not trusted:

- **Coordinator** — can withhold service. Cannot steal funds, forge
  orders, or move state without user signatures. Worst case: users
  refund after timelock.
- **Resolver** — can refuse to fill orders. Cannot keep user funds
  because the user, not the resolver, is the destination beneficiary.
  Cannot steal stake from other resolvers.
- **Other users** — public on-chain order book and events; no
  privacy guarantees, but no fund-loss vector.

One actor is trusted *for liveness only*:

- **`ResolverRegistry` admin** — can slash legitimate resolvers (a
  liveness attack, not a fund-theft attack). Must become a multisig
  before mainnet.

The full STRIDE-style threat model is in
[`docs/TRUST_MODEL.md`](docs/TRUST_MODEL.md). The audit roadmap is in
[`docs/SECURITY.md`](docs/SECURITY.md). The mainnet rollout checklist
is in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## 9. Status table

| Layer | v1 state | v2 state | Verifiable artefact |
|---|---|---|---|
| Stellar HTLC | Claimable balance with unconditional claimants, coordinator-custodial | **Shipped** Soroban contract | `soroban/contracts/htlc/src/lib.rs`, 10 unit tests |
| EVM HTLC | 3 overlapping contracts, resolver allowlist not enforced | **Shipped** single canonical contract | `contracts/contracts/v2/HTLCEscrow.sol`, 15 Hardhat tests |
| Resolver registry | None | **Shipped** on both chains | `contracts/v2/ResolverRegistry.sol`, `soroban/contracts/resolver-registry/`, 6 Hardhat tests |
| Coordinator | 3,276-line `relayer/src/index.ts` | **Shipped** modular rewrite | `coordinator/`, 4 service tests |
| Frontend refund | Mocked | **Shipped** real on-chain refund | `frontend/src/features/refund/RefundDialog.tsx` |
| Audit | None | **Pending** independent audit; pre-audit hardening shipped | `docs/SECURITY.md` |
| Mainnet | v1 deployed without audit (not recommended) | **Not deployed** — testnet only until post-audit | `docs/DEPLOYMENT.md` |

---

## 10. Out of scope for v2.0

These items are tracked in [`ROADMAP.md`](ROADMAP.md):

- Partial fills on Soroban (EVM side already supports them).
- Stellar non-XLM Soroban assets in the SDK.
- Off-chain resolver auction protocol (v2.0 uses simple
  first-come-first-served fills).
- Direct integration with the 1inch Fusion+ public resolver mesh.
- Cross-chain message format that subsumes both sha256 and
  keccak256 in a single signed payload (so cross-chain composability
  works without coordinator hints).
