/**
 * @fileoverview Ethereum Event Listener for FusionBridge
 * @description Monitors HTLCBridge contract events and triggers Stellar operations
 */

import { ethers, Contract, EventLog } from 'ethers';
import { RELAYER_CONFIG } from './index.js';

// Mock CrossChainOrder interface for now
interface CrossChainOrder {
  orderId: string;
  sender: string;
  token: string;
  amount: string;
  hashLock: string;
  timelock: number;
  feeRate: string;
  partialFillEnabled: boolean;
  ethereumOrderId?: string;
}

// HTLCBridge contract ABI (focusing on OrderCreated event)
const HTLC_BRIDGE_ABI = [
  "event OrderCreated(uint256 indexed orderId, address indexed sender, address indexed token, uint256 amount, bytes32 hashLock, uint256 timelock, uint256 feeRate, bool partialFillEnabled)",
  "event OrderClaimed(uint256 indexed orderId, address indexed claimer, uint256 amount, uint256 totalFilled, bytes32 preimage)",
  "event OrderRefunded(uint256 indexed orderId, address indexed sender, uint256 refundAmount)"
];

/**
 * Ethereum OrderCreated event data
 */
interface OrderCreatedEvent {
  orderId: bigint;
  sender: string;
  token: string;
  amount: bigint;
  hashLock: string;
  timelock: bigint;
  feeRate: bigint;
  partialFillEnabled: boolean;
  transactionHash: string;
  blockNumber: number;
}

/**
 * Ethereum Event Listener for HTLCBridge contract
 */
/**
 * How often we ask the RPC for new blocks. Sepolia produces a block
 * roughly every 12s; 5s polling means we never lag more than one
 * block behind reality while keeping RPC pressure low.
 */
const POLL_INTERVAL_MS = 5_000;

/**
 * Hard cap on the size of a single `getLogs` window. Public RPCs
 * reject very wide ranges; if the relayer was offline for a long
 * time we walk forward in chunks of this size instead of one giant
 * query.
 */
const MAX_BLOCK_WINDOW = 500;

export class EthereumEventListener {
  private provider?: ethers.JsonRpcProvider;
  private contract?: Contract;
  private isListening: boolean = false;
  /**
   * Cursor for the block-polling loop. We never re-scan blocks at or
   * below this number, which makes the loop crash-safe across ticks
   * even if individual `queryFilter` calls fail.
   */
  private lastProcessedBlock: number = 0;
  private pollHandle: NodeJS.Timeout | null = null;
  /** Re-entrancy guard so a slow poll doesn't overlap the next tick. */
  private isPolling: boolean = false;

  constructor() {
    // Lazy initialization - will be done in startListening()
  }

  /**
   * Initialize components with configuration
   */
  private initializeComponents() {
    if (this.provider) return; // Already initialized

    // In mock mode, don't initialize real provider to avoid RPC errors
    if (RELAYER_CONFIG.enableMockMode) {
      console.log('🧪 Mock mode: Skipping Ethereum provider initialization');
      return;
    }

    // Initialize Ethereum provider
    this.provider = new ethers.JsonRpcProvider(RELAYER_CONFIG.ethereum.rpcUrl);
    
    // Initialize contract
    this.contract = new Contract(
      RELAYER_CONFIG.ethereum.contractAddress,
      HTLC_BRIDGE_ABI,
      this.provider
    );

    // Initialize Stellar client (placeholder for now)
    console.log('🌟 Stellar client initialization placeholder');
  }

  /**
   * Start listening to Ethereum events
   */
  async startListening(): Promise<void> {
    if (this.isListening) {
      console.log('⚠️  Event listener is already running');
      return;
    }

    try {
      // Initialize components first
      this.initializeComponents();

      console.log('🔄 Starting Ethereum event listener...');
      console.log(`📍 Contract address: ${RELAYER_CONFIG.ethereum.contractAddress}`);
      console.log(`🌐 Network: ${RELAYER_CONFIG.ethereum.network}`);

      // Validate configuration
      await this.validateConfiguration();

      // Set up event listener for OrderCreated events
      if (RELAYER_CONFIG.enableMockMode) {
        console.log('🧪 Mock mode: Simulating event listener (no real blockchain connection)');
      } else {
        // Start from the current head — we only care about NEW orders,
        // not history. Historical orders are surfaced via /api/orders.
        this.lastProcessedBlock = await this.provider!.getBlockNumber();
        console.log(`📦 Polling from block ${this.lastProcessedBlock} forward (every ${POLL_INTERVAL_MS / 1000}s)`);

        // Block-by-block polling instead of `contract.on(...)`. The
        // `on` path uses `eth_newFilter` / `eth_getFilterChanges`,
        // which load-balanced public RPCs (PublicNode, etc.) do not
        // track reliably — the filter id is unknown to whichever node
        // serves the next poll, producing the `filter not found`
        // errors and silently dropping events. `queryFilter` is
        // stateless on the RPC side: every tick we just ask for
        // `getLogs(fromBlock, toBlock)`, which any node can answer.
        this.pollHandle = setInterval(() => {
          void this.pollEvents();
        }, POLL_INTERVAL_MS);
      }

      this.isListening = true;
      console.log('✅ Ethereum event listener started successfully');
      console.log('👂 Listening for OrderCreated events...');

    } catch (error) {
      console.error('❌ Failed to start event listener:', error);
      throw error;
    }
  }

  /**
   * Stop listening to events
   */
  async stopListening(): Promise<void> {
    if (!this.isListening) {
      console.log('⚠️  Event listener is not running');
      return;
    }

    try {
      if (this.pollHandle) {
        clearInterval(this.pollHandle);
        this.pollHandle = null;
      }
      this.isListening = false;
      console.log('🛑 Ethereum event listener stopped');
    } catch (error) {
      console.error('❌ Error stopping event listener:', error);
    }
  }

  /**
   * Poll for new OrderCreated events. Designed to be safe across:
   *  - transient RPC failures (we keep the cursor; retry next tick)
   *  - long offline windows (we walk forward MAX_BLOCK_WINDOW at a time)
   *  - re-entrancy (a slow getLogs won't pile up on the next interval)
   */
  private async pollEvents(): Promise<void> {
    if (this.isPolling || !this.contract || !this.provider) return;
    this.isPolling = true;
    try {
      const head = await this.provider.getBlockNumber();
      if (head <= this.lastProcessedBlock) return;

      const fromBlock = this.lastProcessedBlock + 1;
      const toBlock = Math.min(head, fromBlock + MAX_BLOCK_WINDOW - 1);

      const filter = this.contract.filters.OrderCreated();
      const events = await this.contract.queryFilter(filter, fromBlock, toBlock);

      for (const ev of events) {
        // `queryFilter` returns plain `Log` objects unless the ABI
        // matches, in which case ethers gives us `EventLog` with
        // decoded `args`. Filter to the typed case so we don't NPE
        // on raw logs (e.g. from a contract that emits a colliding
        // anonymous event).
        if (!('args' in ev) || !ev.args) continue;
        const args = ev.args as unknown as [
          bigint, string, string, bigint, string, bigint, bigint, boolean
        ];
        await this.handleOrderCreatedEvent(
          args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
          ev as EventLog
        );
      }

      this.lastProcessedBlock = toBlock;
    } catch (err: any) {
      // Don't advance the cursor — we'll retry the same window next
      // tick. Public RPCs occasionally return 429s or transient
      // upstream errors; logging once per failure is enough.
      console.warn('[eth-listener] poll failed, will retry next tick:', err?.shortMessage ?? err?.message ?? err);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Handle OrderCreated event from HTLCBridge contract
   */
  private async handleOrderCreatedEvent(
    orderId: bigint,
    sender: string,
    token: string,
    amount: bigint,
    hashLock: string,
    timelock: bigint,
    feeRate: bigint,
    partialFillEnabled: boolean,
    event: EventLog
  ): Promise<void> {
    try {
      console.log('\n🚨 NEW ETHEREUM ORDER DETECTED!');
      console.log('================================');
      console.log(`🆔 Order ID: ${orderId.toString()}`);
      console.log(`👤 Sender: ${sender}`);
      console.log(`💰 Token: ${token}`);
      console.log(`💵 Amount: ${ethers.formatUnits(amount.toString(), 18)} tokens`);
      console.log(`🔒 Hash Lock: ${hashLock}`);
      console.log(`⏰ Timelock: ${new Date(Number(timelock) * 1000).toISOString()}`);
      console.log(`💸 Fee Rate: ${Number(feeRate) / 100}%`);
      console.log(`🔄 Partial Fill: ${partialFillEnabled ? 'Enabled' : 'Disabled'}`);
      console.log(`📝 Tx Hash: ${event.transactionHash}`);
      console.log(`🧱 Block: ${event.blockNumber}`);

      // Convert Ethereum event to CrossChainOrder format
      const crossChainOrder: CrossChainOrder = {
        orderId: orderId.toString(),
        ethereumOrderId: orderId.toString(),
        token: token,
        amount: amount.toString(),
        hashLock: hashLock,
        timelock: Number(timelock),
        sender: sender,
        partialFillEnabled: partialFillEnabled,
        feeRate: feeRate.toString()
      };

      // Process the order (create Stellar HTLC)
      await this.processCrossChainOrder(crossChainOrder);

    } catch (error) {
      console.error('❌ Error handling OrderCreated event:', error);
    }
  }

  /**
   * Process cross-chain order by creating Stellar HTLC.
   *
   * The v1 implementation only logged a `placeholder-tx-hash` here and
   * never actually created a Stellar HTLC. v2 routes this through the
   * Soroban HTLC contract via the coordinator's StellarBridgeService.
   * Until that wiring is in place (Phase 4) we explicitly NO-OP and let
   * the user's own claim/refund handle settlement, rather than logging
   * fake success messages.
   */
  private async processCrossChainOrder(order: CrossChainOrder): Promise<void> {
    console.log('🌉 OrderCreated observed on Ethereum:', {
      ethereumOrderId: order.ethereumOrderId,
      hashLock: order.hashLock
    });
    console.log(
      '⚠️  v1 placeholder Stellar HTLC path disabled. The v2 coordinator (Phase 4) ' +
      'creates the Soroban HTLC. Until then the user can refund permissionlessly ' +
      'after the timelock.'
    );
  }

  /**
   * Validate configuration before starting
   */
  private async validateConfiguration(): Promise<void> {
    // Check if contract address is set
    if (!RELAYER_CONFIG.ethereum.contractAddress || RELAYER_CONFIG.ethereum.contractAddress === '') {
      throw new Error('HTLCBridge contract address not configured');
    }

    // Skip network validation in mock mode
    if (RELAYER_CONFIG.enableMockMode) {
      console.log('🧪 Mock mode enabled - skipping network validation');
      console.log('✅ Mock configuration validated');
      return;
    }

    // Check if RPC URL is valid
    if (RELAYER_CONFIG.ethereum.rpcUrl.includes('YOUR_')) {
      throw new Error('Ethereum RPC URL contains placeholder values');
    }

    try {
      // Test provider connection
      const network = await this.provider!.getNetwork();
      console.log(`🔗 Connected to Ethereum network: ${network.name} (Chain ID: ${network.chainId})`);

      // Test contract deployment
      const code = await this.provider!.getCode(RELAYER_CONFIG.ethereum.contractAddress);
      if (code === '0x') {
        throw new Error(`No contract deployed at address: ${RELAYER_CONFIG.ethereum.contractAddress}`);
      }

      console.log('✅ Contract validation successful');

    } catch (error) {
      console.error('❌ Configuration validation failed:', error);
      throw error;
    }
  }

  /**
   * Get current listening status
   */
  public isListeningToEvents(): boolean {
    return this.isListening;
  }

  /**
   * Get contract address being monitored
   */
  public getContractAddress(): string {
    return RELAYER_CONFIG.ethereum.contractAddress;
  }
}

// Export singleton instance
export const ethereumListener = new EthereumEventListener(); 