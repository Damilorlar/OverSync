import { useState, useEffect, useCallback } from 'react';
import { Clock, CheckCircle, XCircle, ArrowRight, ExternalLink, RefreshCw, Undo2 } from 'lucide-react';
import { isTestnet } from '../config/networks';
import RefundDialog from '../features/refund/RefundDialog';
import type { Address } from 'viem';

interface Transaction {
  id: string;
  txHash: string;
  fromNetwork: string;
  toNetwork: string;
  fromToken: string;
  toToken: string;
  amount: string;
  estimatedAmount: string;
  status: 'pending' | 'completed' | 'cancelled' | 'failed';
  timestamp: number;
  ethTxHash?: string;
  stellarTxHash?: string;
  direction: 'eth-to-xlm' | 'xlm-to-eth';
  // Refund support
  // ETH-side refund metadata (eth-to-xlm; populated when ETH is locked on-chain)
  onChainOrderId?: string;       // bytes32 hex (v1) or uint256 string (v2)
  htlcContractAddress?: string;  // contract holding the locked ETH
  htlcContractMode?: 'v1-mainnet-htlc' | 'v2-escrow';
  timelockUnixSeconds?: number;
  amountWei?: string;
  // Generic refund tracking (works for both directions)
  refundTxHash?: string;
  refundNetwork?: 'ethereum' | 'stellar';  // which chain the refund lives on
  refundedAt?: number;
  networkMode?: 'mainnet' | 'testnet';
}

interface TransactionHistoryProps {
  ethAddress?: string;
  stellarAddress?: string;
}

const STORAGE_KEY = 'oversync_transactions_v2';

// Hash patterns that indicate fabricated/demo data, used to filter out legacy entries
// persisted by older builds. New entries can never match these because v2 only stores
// real on-chain hashes returned from the coordinator.
const KNOWN_FAKE_HASHES = new Set([
  '0x1234567890abcdef1234567890abcdef12345678',
  '0xabcdef1234567890abcdef1234567890abcdef12',
  '0x9876543210fedcba9876543210fedcba98765432',
  '0x0000000000000000000000000000000000000000000000000000000000000000',
  '0x0000000000000000000000000000000000000000',
]);

function isRealHash(hash?: string): boolean {
  if (!hash) return true;
  if (KNOWN_FAKE_HASHES.has(hash)) return false;
  if (hash.startsWith('mock_')) return false;
  if (hash.startsWith('placeholder')) return false;
  if (/^0x0+$/.test(hash)) return false;
  return true;
}

function isRealTransaction(tx: Transaction): boolean {
  return isRealHash(tx.txHash) && isRealHash(tx.ethTxHash) && isRealHash(tx.stellarTxHash);
}

export default function TransactionHistory({ ethAddress, stellarAddress }: TransactionHistoryProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'pending' | 'completed' | 'cancelled'>('all');
  const [refundTarget, setRefundTarget] = useState<Transaction | null>(null);

  const loadFromStorage = useCallback((): Transaction[] => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as Transaction[];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isRealTransaction);
    } catch (err) {
      console.warn('Could not parse stored transactions:', err);
      return [];
    }
  }, []);

  const refreshFromCoordinator = useCallback(async () => {
    const apiBase = (import.meta as any).env?.VITE_API_BASE_URL;
    if (!apiBase || (!ethAddress && !stellarAddress)) {
      setTransactions(loadFromStorage());
      return;
    }
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (ethAddress) params.set('eth', ethAddress);
      if (stellarAddress) params.set('stellar', stellarAddress);
      const res = await fetch(`${apiBase}/api/orders/history?${params.toString()}`);
      if (!res.ok) throw new Error(`Coordinator returned ${res.status}`);
      const body = await res.json();
      const remote: Transaction[] = Array.isArray(body?.transactions)
        ? body.transactions.filter(isRealTransaction)
        : [];
      const local = loadFromStorage();
      const byId = new Map<string, Transaction>();
      for (const tx of local) byId.set(tx.id, tx);
      for (const tx of remote) byId.set(tx.id, tx);
      const merged = Array.from(byId.values()).sort((a, b) => b.timestamp - a.timestamp);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      setTransactions(merged);
    } catch (err) {
      console.warn('Coordinator history unavailable, falling back to local cache:', err);
      setTransactions(loadFromStorage());
    } finally {
      setIsLoading(false);
    }
  }, [ethAddress, stellarAddress, loadFromStorage]);

  useEffect(() => {
    setTransactions(loadFromStorage());
    void refreshFromCoordinator();
  }, [loadFromStorage, refreshFromCoordinator]);

  const getStatusColor = (status: Transaction['status']) => {
    switch (status) {
      case 'completed':
        return 'text-green-400 bg-green-500/20';
      case 'pending':
        return 'text-yellow-400 bg-yellow-500/20';
      case 'cancelled':
        return 'text-gray-400 bg-gray-500/20';
      case 'failed':
        return 'text-red-400 bg-red-500/20';
      default:
        return 'text-gray-400 bg-gray-500/20';
    }
  };

  const getStatusIcon = (status: Transaction['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-4 w-4" />;
      case 'pending':
        return <Clock className="h-4 w-4" />;
      case 'cancelled':
        return <XCircle className="h-4 w-4" />;
      case 'failed':
        return <XCircle className="h-4 w-4" />;
      default:
        return <Clock className="h-4 w-4" />;
    }
  };

  const formatTime = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    return `${minutes}m ago`;
  };

  const filteredTransactions = transactions.filter(tx =>
    filter === 'all' || tx.status === filter
  );

  const getEtherscanUrl = (txHash: string): string => {
    const base = isTestnet() ? 'https://sepolia.etherscan.io' : 'https://etherscan.io';
    return `${base}/tx/${txHash}`;
  };

  const getStellarExplorerUrl = (txHash: string): string => {
    const network = isTestnet() ? 'testnet' : 'public';
    return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
  };

  /**
   * Pick the right block explorer for a refund tx.
   *
   * `refundNetwork` is the authoritative signal once we start writing it.
   * For legacy entries that don't have it, we fall back to a hash-shape
   * heuristic: Ethereum hashes are 0x-prefixed, Stellar hashes are not.
   */
  const getRefundNetwork = (tx: Transaction): 'ethereum' | 'stellar' => {
    if (tx.refundNetwork) return tx.refundNetwork;
    if (tx.refundTxHash?.startsWith('0x')) return 'ethereum';
    return 'stellar';
  };

  const getRefundExplorerUrl = (tx: Transaction): string => {
    if (!tx.refundTxHash) return '#';
    return getRefundNetwork(tx) === 'ethereum'
      ? getEtherscanUrl(tx.refundTxHash)
      : getStellarExplorerUrl(tx.refundTxHash);
  };

  const getRefundNetworkLabel = (tx: Transaction): string =>
    getRefundNetwork(tx) === 'ethereum' ? 'Ethereum' : 'Stellar';

  /**
   * A pending ETH→XLM swap is "refundable" once we have all three on-chain
   * coordinates and the order is still in pending/failed state. We do NOT
   * gate on time here — RefundDialog itself enforces the timelock and only
   * unlocks the button after it expires.
   */
  const canRefund = (tx: Transaction): boolean => {
    return (
      tx.direction === 'eth-to-xlm' &&
      (tx.status === 'pending' || tx.status === 'failed') &&
      !tx.refundedAt &&
      !!tx.onChainOrderId &&
      !!tx.htlcContractAddress &&
      !!tx.timelockUnixSeconds
    );
  };

  const handleRefunded = (orderId: string, refundHash: `0x${string}`) => {
    setTransactions((prev) => {
      const next = prev.map((tx) =>
        tx.id === orderId
          ? { ...tx, status: 'cancelled' as const, refundTxHash: refundHash, refundedAt: Date.now() }
          : tx
      );
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    setRefundTarget(null);
  };

  return (
    <div className="bg-[#131823] rounded-2xl p-6 border border-white/10">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">Transaction History</h2>
          <p className="text-gray-400 text-sm">
            Track your cross-chain swaps between Ethereum and Stellar networks
          </p>
        </div>
        <button
          onClick={refreshFromCoordinator}
          disabled={isLoading}
          className="flex items-center gap-2 px-4 py-2 bg-[#3ABEFF]/20 hover:bg-[#3ABEFF]/30 text-[#3ABEFF] rounded-lg transition-colors button-hover-scale"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="flex gap-2 mb-6">
        {[
          { key: 'all', label: 'All' },
          { key: 'pending', label: 'Pending' },
          { key: 'completed', label: 'Completed' },
          { key: 'cancelled', label: 'Cancelled' }
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key as any)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === key
                ? 'bg-gradient-to-r from-[#6C63FF] to-[#3ABEFF] text-white'
                : 'bg-white/5 text-gray-400 hover:text-white hover:bg-white/10'
            }`}
          >
            {label} {key !== 'all' && `(${transactions.filter(tx => tx.status === key).length})`}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {filteredTransactions.length === 0 ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 bg-gray-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <Clock className="h-8 w-8 text-gray-400" />
            </div>
            <p className="text-gray-400 text-lg">No transactions yet</p>
            <p className="text-gray-500 text-sm mt-1">
              Your real cross-chain swaps will appear here after the first transaction
            </p>
          </div>
        ) : (
          filteredTransactions.map((tx) => (
            <div
              key={tx.id}
              className="bg-[#1a212f] rounded-lg p-4 border border-white/5 hover:border-white/10 transition-colors"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium ${getStatusColor(tx.status)}`}>
                    {getStatusIcon(tx.status)}
                    <span className="capitalize">{tx.status}</span>
                  </div>
                  <span className="text-xs text-gray-400">
                    {formatTime(tx.timestamp)}
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  {tx.ethTxHash && isRealHash(tx.ethTxHash) && (
                    <a
                      href={getEtherscanUrl(tx.ethTxHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white text-[11px] font-medium border border-white/5 transition-colors"
                      title="View on Etherscan"
                    >
                      <img src="/images/eth.png" alt="ETH" className="h-3.5 w-3.5" />
                      <span>Etherscan</span>
                      <ExternalLink className="h-3 w-3 opacity-70" />
                    </a>
                  )}
                  {tx.stellarTxHash && isRealHash(tx.stellarTxHash) && (
                    <a
                      href={getStellarExplorerUrl(tx.stellarTxHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white text-[11px] font-medium border border-white/5 transition-colors"
                      title="View on Stellar Expert"
                    >
                      <img src="/images/xlm.png" alt="XLM" className="h-3.5 w-3.5" />
                      <span>Stellar Expert</span>
                      <ExternalLink className="h-3 w-3 opacity-70" />
                    </a>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="text-center">
                    <div className="text-white font-medium">
                      {tx.amount} {tx.fromToken}
                    </div>
                    <div className="text-xs text-gray-400">
                      {tx.fromNetwork}
                    </div>
                  </div>

                  <ArrowRight className="h-4 w-4 text-gray-400" />

                  <div className="text-center">
                    <div className="text-white font-medium">
                      {tx.estimatedAmount} {tx.toToken}
                    </div>
                    <div className="text-xs text-gray-400">
                      {tx.toNetwork}
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between gap-2 flex-wrap">
                <div className="text-xs text-gray-400">
                  Transaction:
                  <span className="text-gray-300 font-mono ml-1">
                    {tx.txHash.substring(0, 10)}...{tx.txHash.substring(tx.txHash.length - 8)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {tx.refundTxHash && (
                    <a
                      href={getRefundExplorerUrl(tx)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 text-xs font-semibold border border-emerald-400/30 transition-colors"
                      title={`Refund settled on ${getRefundNetworkLabel(tx)}. Click to view the refund transaction.`}
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                      <span>Refunded · view on</span>
                      <img
                        src={getRefundNetwork(tx) === 'ethereum' ? '/images/eth.png' : '/images/xlm.png'}
                        alt={getRefundNetworkLabel(tx)}
                        className="h-3.5 w-3.5"
                      />
                      <span>{getRefundNetworkLabel(tx)}</span>
                    </a>
                  )}
                  {canRefund(tx) && (
                    <button
                      onClick={() => setRefundTarget(tx)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 text-xs font-semibold border border-amber-400/30 transition-colors"
                      title="Refund your locked ETH from the HTLC contract once the timelock expires"
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                      Refund ETH
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {refundTarget && refundTarget.onChainOrderId && refundTarget.htlcContractAddress && refundTarget.timelockUnixSeconds && ethAddress && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <RefundDialog
            userAddress={ethAddress as Address}
            orderId={refundTarget.onChainOrderId}
            timelockUnixSeconds={refundTarget.timelockUnixSeconds}
            amountWei={refundTarget.amountWei ?? '0'}
            contractMode={refundTarget.htlcContractMode ?? 'v1-mainnet-htlc'}
            v1ContractAddress={refundTarget.htlcContractAddress as Address}
            onClose={() => setRefundTarget(null)}
            onRefunded={(hash) => handleRefunded(refundTarget.id, hash)}
          />
        </div>
      )}
    </div>
  );
}
