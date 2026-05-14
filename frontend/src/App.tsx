import { useState, useEffect } from 'react'
import BridgeForm from './components/BridgeForm'

import TransactionHistory from './components/TransactionHistory'

import { ToastContainer, useToast } from './components/Toast'
import { useFreighter } from './hooks/useFreighter'
import { useNetworkMode } from './lib/useNetworkMode'
import NetworkMismatchBanner from './components/NetworkMismatchBanner'
import MainnetVersionBanner from './components/MainnetVersionBanner'
import {
  Activity,
  ArrowRightLeft,
  ChevronDown,
  ExternalLink,
  History,
  LockKeyhole,
  RadioTower,
  ShieldCheck,
  Wallet,
  Zap,
} from 'lucide-react'

// Window objeleri için type definitions
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: any[] }) => Promise<any>;
      selectedAddress?: string;
    };
  }
}

function App() {
  const [ethAddress, setEthAddress] = useState<string>('');
  const [showWalletMenu, setShowWalletMenu] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'bridge' | 'history'>('bridge');

  // Freighter hook usage
  const {
    isConnected: stellarConnected,
    address: stellarAddress,
    isLoading: stellarLoading,
    error: stellarError,
    connect: connectFreighter,
    disconnect: disconnectFreighter,
  } = useFreighter();

  // Toast hook
  const toast = useToast();

  // Auto-connect MetaMask if previously connected
  useEffect(() => {
    const checkMetaMaskConnection = async () => {
      if (window.ethereum) {
        try {
          const accounts = await window.ethereum.request({ method: 'eth_accounts' });
          if (accounts.length > 0) {
            setEthAddress(accounts[0]);
          }
        } catch (error) {
          console.log('Could not check MetaMask connection:', error);
        }
      }
    };

    checkMetaMaskConnection();

    // Listen for account changes
    if (window.ethereum) {
      const handleAccountsChanged = (accounts: string[]) => {
        if (accounts.length > 0) {
          setEthAddress(accounts[0]);
        } else {
          setEthAddress('');
        }
      };

      (window.ethereum as any).on('accountsChanged', handleAccountsChanged);

      return () => {
        if (window.ethereum) {
          (window.ethereum as any).removeListener('accountsChanged', handleAccountsChanged);
        }
      };
    }
  }, []);

  // Single source of truth for testnet/mainnet across URL + MetaMask + Freighter.
  // Replaces the previous local `currentNetwork` state and 2s page-reload hack
  // that allowed URL and wallet to drift apart.
  const networkState = useNetworkMode({
    ethAddress: ethAddress || undefined,
    stellarAddress: stellarAddress || undefined,
  });
  const currentNetwork = networkState.mode;

  const toggleNetwork = async () => {
    const newNetwork = currentNetwork === 'testnet' ? 'mainnet' : 'testnet';
    const result = await networkState.setMode(newNetwork);

    if (!result.ok) {
      if (result.reason === 'user-rejected') {
        toast.warning('Network change cancelled', 'You declined the wallet switch — app is still on ' + (currentNetwork === 'mainnet' ? 'Mainnet' : 'Testnet') + '.');
      } else {
        toast.error('Network switch failed', 'Please switch your wallet network manually, then click the toggle again.');
      }
      return;
    }

    toast.success(
      'Network mode changed',
      `Switched to ${newNetwork === 'mainnet' ? 'Mainnet' : 'Testnet'} mode`,
    );
  };



  // MetaMask connection
  const connectMetaMask = async () => {
    setIsConnecting(true);
    setConnectionError('');
    
    try {
      if (!window.ethereum) {
        throw new Error('MetaMask bulunamadı! Lütfen MetaMask yükleyin.');
      }

      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts'
      });

      if (accounts.length > 0) {
        setEthAddress(accounts[0]);
        setShowWalletMenu(false);
        toast.success('MetaMask Connected!', `Connected to ${accounts[0].slice(0, 8)}...${accounts[0].slice(-6)}`);
      }
    } catch (error: any) {
      setConnectionError(`MetaMask: ${error.message}`);
      toast.error('Connection Failed', error.message);
    } finally {
      setIsConnecting(false);
    }
  };

  // Freighter connection - Using hook
  const handleFreighterConnect = async () => {
    try {
      await connectFreighter();
      setShowWalletMenu(false);
    } catch (error: any) {
      setConnectionError(`Freighter: ${error.message}`);
    }
  };

  // Wallet disconnect
  const disconnectWallets = () => {
    setEthAddress('');
    disconnectFreighter();
    setShowWalletMenu(false);
  };

  const isWalletsConnected = ethAddress && stellarConnected;
  const hasAnyConnection = ethAddress || stellarConnected;

  const connectionLabel = isWalletsConnected ? 'Connected' : hasAnyConnection ? 'Partial' : 'Connect Wallet';

  return (
    <div className="app-shell min-h-screen text-white flex flex-col">
      {/* Top Navigation */}
      <nav className="sticky top-0 z-50 w-full border-b border-white/10 bg-[#071012]/70 px-4 py-3 backdrop-blur-2xl md:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <img 
            src="/images/oversync-logo.png" 
            alt="OverSync" 
            className="h-11 w-11 rounded-xl border border-white/10 shadow-[0_0_28px_rgba(52,211,153,0.18)]"
          />
          <div>
            <span className="block text-lg font-semibold tracking-tight text-white">OverSync</span>
            <span className="hidden text-xs uppercase tracking-[0.32em] text-emerald-200/60 sm:block">Fusion Rail</span>
          </div>
        </div>
        
        <div className="flex items-center gap-2 md:gap-3">
          <nav className="hidden items-center gap-2 md:flex">
            <a href="https://www.alchemy.com/faucets/ethereum-sepolia" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-300 transition hover:border-cyan-300/30 hover:bg-white/[0.08] hover:text-white">
              Faucet
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </nav>

          {/* Network Toggle Button */}
          <button
            onClick={toggleNetwork}
            className={`network-pill px-3 py-2 text-sm font-semibold transition-all duration-200 md:px-4 ${
              currentNetwork === 'mainnet'
                ? 'network-mainnet'
                : 'network-testnet'
            }`}
          >
            <div className={`w-2 h-2 rounded-full ${
              currentNetwork === 'mainnet' ? 'bg-cyan-300' : 'bg-amber-300'
            }`}></div>
            {currentNetwork === 'mainnet' ? 'Mainnet' : 'Testnet'}
          </button>
          
          {/* Connect Wallet Button */}
          <div className="relative">
            <button 
              onClick={() => setShowWalletMenu(!showWalletMenu)}
              className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-sm font-semibold text-white shadow-[0_12px_40px_rgba(34,211,238,0.12)] transition hover:border-cyan-200/40 hover:bg-cyan-300/15 md:px-5"
            >
              <Wallet className="h-4 w-4" />
              {isWalletsConnected ? (
                <>
                  <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                  <span className="hidden sm:inline">{connectionLabel}</span>
                </>
              ) : hasAnyConnection ? (
                <>
                  <div className="w-2 h-2 bg-yellow-400 rounded-full"></div>
                  <span className="hidden sm:inline">{connectionLabel}</span>
                </>
              ) : (
                <span className="hidden sm:inline">{connectionLabel}</span>
              )}
              <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${showWalletMenu ? 'rotate-180' : ''}`} />
            </button>

            {/* Wallet Dropdown Menu */}
            {showWalletMenu && (
              <div className="absolute right-0 top-full z-[100] mt-3 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-white/15 bg-[#0b1518]/95 p-4 shadow-2xl shadow-black/50 backdrop-blur-2xl">
                <h3 className="mb-4 text-center font-semibold text-white">Connect Wallets</h3>
                
                {(connectionError || stellarError) && (
                  <div className="mb-4 rounded-xl border border-red-400/25 bg-red-500/15 p-3">
                    <p className="text-red-300 text-sm">{connectionError || stellarError}</p>
                  </div>
                )}

                {/* MetaMask */}
                <div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-orange-300/20 bg-orange-400/15 text-orange-200">
                        <Wallet className="h-4 w-4" />
                      </span>
                      <div>
                        <div className="text-white font-medium">MetaMask</div>
                        <div className="text-xs text-slate-400">Ethereum Network</div>
                      </div>
                    </div>
                    
                    {ethAddress ? (
                      <div className="text-right">
                        <div className="flex items-center gap-1 mb-1">
                          <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                          <span className="text-xs text-green-400">Connected</span>
                        </div>
                        <p className="text-xs text-gray-300">
                          {ethAddress.substring(0, 6)}...{ethAddress.substring(ethAddress.length - 4)}
                        </p>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={connectMetaMask}
                        className="rounded-full border border-orange-300/20 bg-orange-400/15 px-4 py-2 text-sm text-orange-200 transition hover:bg-orange-400/25"
                        disabled={isConnecting}
                      >
                        {isConnecting ? 'Connecting...' : 'Connect'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Freighter */}
                <div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/15 text-cyan-100">
                        <RadioTower className="h-4 w-4" />
                      </span>
                      <div>
                        <div className="text-white font-medium">Freighter</div>
                        <div className="text-xs text-slate-400">Stellar Network</div>
                      </div>
                    </div>
                    
                    {stellarConnected && stellarAddress ? (
                      <div className="text-right">
                        <div className="flex items-center gap-1 mb-1">
                          <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                          <span className="text-xs text-green-400">Connected</span>
                        </div>
                        <p className="text-xs text-gray-300">
                          {stellarAddress.substring(0, 6)}...{stellarAddress.substring(stellarAddress.length - 4)}
                        </p>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={handleFreighterConnect}
                        className="rounded-full border border-cyan-300/20 bg-cyan-300/15 px-4 py-2 text-sm text-cyan-200 transition hover:bg-cyan-300/25"
                        disabled={stellarLoading}
                      >
                        {stellarLoading ? 'Connecting...' : 'Connect'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Disconnect Button */}
                {hasAnyConnection && (
                  <button
                    onClick={disconnectWallets}
                    className="w-full rounded-full border border-red-400/30 bg-red-500/15 py-2 text-sm text-red-200 transition hover:bg-red-500/25"
                  >
                    Disconnect All
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        </div>
      </nav>

      <NetworkMismatchBanner networkState={networkState} />
      <MainnetVersionBanner networkState={networkState} />

      {/* Main Content */}
      <main className="relative z-10 mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-8 px-4 pb-20 pt-10 md:px-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(420px,560px)] lg:items-start lg:pt-16">
        <section className="space-y-8">
          <div className="max-w-2xl">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-100/80">
              <RadioTower className="h-3.5 w-3.5" />
              Live cross-chain rail
            </div>
            <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight text-white md:text-6xl">
              Ethereum and Stellar,
              <span className="hero-gradient block">synced with intent.</span>
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-300 md:text-lg">
              Execute ETH and XLM swaps from a focused, production-grade control surface with live quotes, wallet state, and settlement history in one place.
            </p>
          </div>

          <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { icon: ShieldCheck, label: 'HTLC secured', value: 'Atomic path' },
              { icon: Activity, label: 'Quote source', value: 'Relayer live' },
              { icon: LockKeyhole, label: 'Mode', value: currentNetwork === 'mainnet' ? 'Mainnet' : 'Testnet' },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="metric-tile">
                <Icon className="h-4 w-4 text-cyan-200" />
                <span className="text-xs text-slate-400">{label}</span>
                <strong className="text-sm font-semibold text-white">{value}</strong>
              </div>
            ))}
          </div>

          <div className="route-panel max-w-2xl">
            <div className="flex items-center justify-between gap-4 border-b border-white/10 pb-4">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Active route</p>
                <h2 className="mt-1 text-lg font-semibold text-white">ETH / XLM liquidity lane</h2>
              </div>
              <Zap className="h-5 w-5 text-amber-200" />
            </div>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 pt-4">
              <div className="chain-node">
                <img src="/images/eth.png" alt="ETH" className="h-7 w-7" />
                <span>Ethereum</span>
              </div>
              <ArrowRightLeft className="h-5 w-5 text-slate-400" />
              <div className="chain-node">
                <img src="/images/xlm.png" alt="XLM" className="h-7 w-7" />
                <span>Stellar</span>
              </div>
            </div>
          </div>
        </section>

        <section className="w-full">
          {/* Tab Navigation */}
          <div className="mb-4 flex justify-center lg:justify-end">
            <div className="segmented-control">
              <button
                onClick={() => setActiveTab('bridge')}
                className={activeTab === 'bridge' ? 'active' : ''}
              >
                <ArrowRightLeft className="h-4 w-4" />
                Bridge
              </button>
              <button
                onClick={() => setActiveTab('history')}
                className={activeTab === 'history' ? 'active' : ''}
              >
                <History className="h-4 w-4" />
                History
              </button>
            </div>
          </div>

          {activeTab === 'bridge' && (
            <BridgeForm
              ethAddress={ethAddress}
              stellarAddress={stellarAddress || ''}
            />
          )}

          {activeTab === 'history' && (
            <TransactionHistory
              ethAddress={ethAddress}
              stellarAddress={stellarAddress || ''}
            />
          )}
        </section>
      </main>

      <div className="background-depth pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="background-grid" />
        <div className="background-scanline" />
      </div>

      {/* Footer Bar */}
      <div className="relative z-10 flex h-9 w-full items-center justify-end border-t border-white/10 bg-[#050b0d]/80 px-6 backdrop-blur-xl">
        <a 
          href="https://x.com/OverBlock_" 
          target="_blank" 
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm font-semibold text-slate-300 transition-colors hover:text-cyan-200"
        >
          Powered by OverBlock
          <span className="text-base">X</span>
        </a>
      </div>

      {/* Toast Container */}
      <ToastContainer 
        toasts={toast.toasts}
        onClose={toast.removeToast}
      />

    </div>
  );
}

export default App;
