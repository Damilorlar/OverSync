import { useState } from 'react';
import type { NetworkModeState } from '../lib/useNetworkMode';

interface Props {
  networkState: NetworkModeState;
}

const MODE_LABEL: Record<'testnet' | 'mainnet', string> = {
  testnet: 'Testnet',
  mainnet: 'Mainnet',
};

const ETH_MODE_FROM_CHAIN: Record<string, string> = {
  '0x1': 'Ethereum Mainnet',
  '0xaa36a7': 'Sepolia Testnet',
};

const STELLAR_MODE_FROM_PASSPHRASE: Record<string, string> = {
  'Public Global Stellar Network ; September 2015': 'Stellar Public',
  'Test SDF Network ; September 2015': 'Stellar Testnet',
};

function describeMetamaskChain(chainId: string | null): string {
  if (!chainId) return 'unknown';
  return ETH_MODE_FROM_CHAIN[chainId.toLowerCase()] || `chain ${chainId}`;
}

function describeFreighterNetwork(passphrase: string | null): string {
  if (!passphrase) return 'unknown';
  return STELLAR_MODE_FROM_PASSPHRASE[passphrase] || passphrase;
}

export default function NetworkMismatchBanner({ networkState }: Props) {
  const [busy, setBusy] = useState(false);
  const {
    mode,
    metamaskConnected,
    metamaskMatches,
    metamaskChainId,
    freighterConnected,
    freighterMatches,
    freighterNetworkPassphrase,
    hasAnyMismatch,
    setMode,
    refreshWalletNetworks,
  } = networkState;

  if (!hasAnyMismatch) {
    return null;
  }

  const expectedLabel = MODE_LABEL[mode];
  const metamaskActual = describeMetamaskChain(metamaskChainId);
  const freighterActual = describeFreighterNetwork(freighterNetworkPassphrase);

  const onSwitchAppToWallet = async () => {
    setBusy(true);
    try {
      const nextMode: 'testnet' | 'mainnet' =
        metamaskConnected && !metamaskMatches
          ? metamaskChainId?.toLowerCase() === '0x1'
            ? 'mainnet'
            : 'testnet'
          : freighterConnected && !freighterMatches
            ? freighterNetworkPassphrase === 'Public Global Stellar Network ; September 2015'
              ? 'mainnet'
              : 'testnet'
            : mode;
      if (nextMode !== mode) {
        await setMode(nextMode);
      } else {
        refreshWalletNetworks();
      }
    } finally {
      setBusy(false);
    }
  };

  const onSwitchWalletToApp = async () => {
    setBusy(true);
    try {
      await setMode(mode);
      refreshWalletNetworks();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full bg-amber-500/15 border-y border-amber-400/40 text-amber-100 px-6 py-3 flex flex-col md:flex-row items-start md:items-center gap-3 justify-between">
      <div className="flex items-start gap-3 text-sm">
        <span className="mt-0.5">⚠</span>
        <div>
          <div className="font-semibold">
            Your wallet network does not match the app network.
          </div>
          <div className="text-amber-200/90">
            App is set to <b>{expectedLabel}</b>.{' '}
            {metamaskConnected && !metamaskMatches && (
              <span>MetaMask is on <b>{metamaskActual}</b>. </span>
            )}
            {freighterConnected && !freighterMatches && (
              <span>Freighter is on <b>{freighterActual}</b>. </span>
            )}
            Balances and signing will fail until they match.
          </div>
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          onClick={onSwitchWalletToApp}
          disabled={busy}
          className="px-3 py-1.5 rounded-md bg-amber-400/20 hover:bg-amber-400/30 text-amber-50 text-xs font-semibold border border-amber-300/30 transition-colors disabled:opacity-50"
        >
          Switch wallet to {expectedLabel}
        </button>
        <button
          onClick={onSwitchAppToWallet}
          disabled={busy}
          className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-amber-50 text-xs font-medium border border-white/10 transition-colors disabled:opacity-50"
        >
          Switch app to wallet
        </button>
      </div>
    </div>
  );
}
