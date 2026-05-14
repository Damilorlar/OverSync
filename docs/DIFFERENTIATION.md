# OverSync vs other Stellar bridges

This document is OverSync's honest assessment of the Stellar bridging
landscape as of **May 2026** and the specific niche we occupy.

The bridging landscape is the question everyone serious about a bridge
project asks. We are not the only bridge connecting Stellar to other
chains — and we are not trying to be a generalist competitor to the
incumbents. We solve a specific, well-defined problem that none of
them solve.

## TL;DR

| Bridge | Live on Stellar | Assets | Trust model | What it does well |
|---|---|---|---|---|
| **Circle CCTP v2** | Testnet (April 2026 → mainnet imminent) | **USDC only** | Circle attestation service signs the burn proof | Native, burnless USDC; first-party Circle support |
| **Axelar ITS** | Mainnet (February 16, 2026) | Any tokenized asset routed via Axelar hub | Axelar validator set + threshold signatures | Generalist token routing; institutional partners (Solv, Stronghold, Squid) |
| **Allbridge Classic / Core** | Mainnet (existing) | Stablecoins + select assets | Allbridge validator set | Established, integrated with on-ramps; small Stellar TVL (~$0.45M as of May 2026) |
| **OverSync v2** | Testnet (v2 rebuild in progress) | XLM ↔ ETH (v2.0); ERC-20s, Soroban assets (v2.1) | **Atomic HTLC math — no validators, no committee** | Native non-custodial swaps; Fusion+ resolver compatibility |

## The "why are you not just X" answers

### "Why not just use CCTP v2 for everything?"

CCTP v2 is excellent for what it does: burn-and-mint **USDC** between
chains using a Circle-signed attestation. It's not a general bridge. If
your asset is not USDC, CCTP v2 cannot help you. If your asset is
USDC and Circle's attester goes offline or is compelled by a regulator
to withhold an attestation, your transfer stalls until they recover.

OverSync moves **native XLM, ETH and arbitrary ERC-20s** atomically.
The trust assumption is "sha256 still works" + "Ethereum and Stellar
finalise blocks." There is no first-party attester.

**These two systems are complementary, not competing.** A typical user
might use CCTP v2 for USDC transfers and OverSync for swapping native
XLM ↔ ETH in a single atomic operation. We are not trying to take
USDC volume from Circle.

### "Why not just use Axelar's Interchain Token Service?"

Axelar ITS launched on Stellar in February 2026 and is a generalist
token-routing layer. It works by:

1. Locking the asset on the source chain in an Axelar-controlled vault.
2. The Axelar validator set produces a threshold signature attesting
   to that lock.
3. Minting a wrapped representation on the destination chain.

This is the **validator-set trust model**. If a quorum of Axelar
validators is compromised, colludes, or is taken offline by an
external party, the wrapped tokens on the destination chain can be
minted without a real lock or stranded behind a non-functioning
attester. This is the trust assumption that every multisig / federated
bridge inherits, and historically the most catastrophic bridge hacks
(Ronin $625M, Multichain $231M, Wormhole $325M) have come from
compromising the validator/guardian set, not from breaking cryptography.

OverSync's trust assumption is strictly weaker:

| Compromise required to steal funds | Axelar ITS | OverSync v2 |
|---|---|---|
| Compromise a quorum of off-chain signers | Yes — steals all locked funds | **Not possible** — the contract has no privileged signer role |
| Break sha256 | No (different attack path) | Yes — and if sha256 is broken, the entire crypto ecosystem is broken |
| Compromise Stellar consensus | Yes | Yes |
| Compromise Ethereum consensus | Yes | Yes |

We are not better than Axelar at everything — Axelar has more chains,
more institutional partners, and a much larger validator set than we
have resolvers. We are better than Axelar **on trust-minimisation**,
which is the only axis a power user cares about for non-custodial
swaps.

### "Why not just use Allbridge?"

Allbridge ships and works today, and it integrates with on-ramps that
matter to retail users. However:

- Allbridge uses a **validator-set trust model**, same category as
  Axelar above.
- Allbridge's Stellar-side TVL is **~$0.45M** as of May 2026
  (DefiLlama: `protocol/allbridge-core`, Stellar pool). The total
  protocol moves ~$22M/30d across all chains; Stellar is a thin
  slice.
- Allbridge wraps the destination asset; you end up with `aUSDC` or
  similar, not the native token.

OverSync delivers the native asset on the other side. We expect to
overlap with Allbridge for trust-conscious users and to leave high-
volume retail flow to Allbridge.

## Where OverSync is the right tool

OverSync v2 is the right choice when you need:

1. **Trust-minimised cross-chain swaps** — power users, treasuries,
   protocols who explicitly want HTLC settlement, not validator
   attestation.
2. **Atomic XLM ↔ ETH** — neither CCTP v2 nor Axelar ITS swap native
   chain assets; they bridge wrapped tokens.
3. **1inch Fusion+ compatibility** — EVM resolvers already operating
   inside Fusion+ can run an OverSync resolver and serve Stellar
   liquidity with minimal new tooling. None of the incumbents
   slot into the Fusion+ resolver mesh.

## Where OverSync is the wrong tool

We will say this out loud because reviewers always test for it:

- USDC-only transfers. **Use CCTP v2.**
- Transfers to a chain Axelar already supports where wrapping is
  acceptable. **Use Axelar ITS.**
- Sub-second UX requirement. HTLC dance has a multi-block floor on
  both chains.
- $5 retail swaps. The safety deposit and gas overhead make us
  uneconomic below a threshold.

## How the landscape affects our roadmap

The competitive picture shapes [`ROADMAP.md`](ROADMAP.md). The two
near-term implications:

1. **CCTP v2 going mainnet on Stellar is a positive event for us.**
   It increases USDC liquidity on Stellar, which makes Stellar a more
   interesting chain to swap into. OverSync benefits from a richer
   Stellar asset universe.
2. **Axelar ITS being live raises the bar on integrations.** Any
   on-chain resolver that already integrates with Axelar can also
   resolve OverSync orders without writing new contracts; we will
   publish a reference resolver that runs alongside an existing
   Axelar resolver inventory.

## References

- Circle, *"CCTP V2 is Coming to Stellar"*, April 2026.
- Axelar, *"Network Integrates Stellar to Accelerate Onchain Finance"*, February 2026.
- DefiLlama Allbridge Core protocol page, accessed May 2026.
