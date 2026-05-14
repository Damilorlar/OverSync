import { useCallback, useEffect, useState } from 'react';
import freighterApi from '@stellar/freighter-api';
import { isTestnet } from '../config/networks';

export type NetworkMode = 'testnet' | 'mainnet';

const ETH_MAINNET_CHAIN_ID_HEX = '0x1';
const ETH_SEPOLIA_CHAIN_ID_HEX = '0xaa36a7';

const STELLAR_MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
const STELLAR_TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

const MAINNET_RPC_URL =
  (import.meta as any).env?.VITE_MAINNET_RPC_URL ||
  'https://eth.llamarpc.com';

function readModeFromUrl(): NetworkMode {
  if (typeof window === 'undefined') {
    return 'testnet';
  }
  const url = new URLSearchParams(window.location.search).get('network');
  if (url === 'mainnet' || url === 'testnet') {
    return url;
  }
  return isTestnet() ? 'testnet' : 'mainnet';
}

function expectedEthChainIdHex(mode: NetworkMode): string {
  return mode === 'mainnet' ? ETH_MAINNET_CHAIN_ID_HEX : ETH_SEPOLIA_CHAIN_ID_HEX;
}

function expectedStellarPassphrase(mode: NetworkMode): string {
  return mode === 'mainnet' ? STELLAR_MAINNET_PASSPHRASE : STELLAR_TESTNET_PASSPHRASE;
}

function eqHexChainId(a: string | null, b: string): boolean {
  if (!a) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export interface NetworkModeState {
  mode: NetworkMode;
  expectedEthChainIdHex: string;
  expectedStellarPassphrase: string;

  metamaskChainId: string | null;
  metamaskConnected: boolean;
  metamaskMatches: boolean;

  freighterNetworkPassphrase: string | null;
  freighterConnected: boolean;
  freighterMatches: boolean;

  hasAnyMismatch: boolean;

  setMode: (next: NetworkMode) => Promise<{ ok: boolean; reason?: string }>;
  refreshWalletNetworks: () => void;
}

/**
 * Single source of truth for "is the app in testnet or mainnet mode?".
 *
 * - Reads the chosen mode from the `?network=` URL param (falls back to env).
 * - Subscribes to `chainChanged` from MetaMask so manual wallet switches
 *   are reflected immediately.
 * - Polls Freighter once on mount and once every 4s to detect manual
 *   network switches (Freighter exposes no event API).
 * - `setMode` first asks the connected wallets to switch; only once a
 *   wallet acknowledges (or no wallet is connected) does it update the
 *   URL. This removes the previous race where the URL could flip while
 *   one wallet stayed on the wrong chain.
 */
export function useNetworkMode(opts: {
  ethAddress?: string;
  stellarAddress?: string;
}): NetworkModeState {
  const [mode, setLocalMode] = useState<NetworkMode>(() => readModeFromUrl());
  const [metamaskChainId, setMetamaskChainId] = useState<string | null>(null);
  const [freighterNetworkPassphrase, setFreighterNetworkPassphrase] = useState<string | null>(null);

  const metamaskConnected = Boolean(opts.ethAddress);
  const freighterConnected = Boolean(opts.stellarAddress);

  useEffect(() => {
    const handler = () => setLocalMode(readModeFromUrl());
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const refreshMetamask = useCallback(async () => {
    if (typeof window === 'undefined' || !window.ethereum) {
      setMetamaskChainId(null);
      return;
    }
    try {
      const chainId = (await window.ethereum.request({ method: 'eth_chainId' })) as string;
      setMetamaskChainId(chainId);
    } catch {
      setMetamaskChainId(null);
    }
  }, []);

  const refreshFreighter = useCallback(async () => {
    try {
      if (!freighterApi || typeof freighterApi.isConnected !== 'function') {
        setFreighterNetworkPassphrase(null);
        return;
      }
      const connectedRaw: any = await freighterApi.isConnected();
      const connected =
        typeof connectedRaw === 'boolean'
          ? connectedRaw
          : Boolean(connectedRaw?.isConnected);
      if (!connected) {
        setFreighterNetworkPassphrase(null);
        return;
      }
      const info: any = await freighterApi.getNetwork();
      const passphrase =
        (info && typeof info === 'object' && info.networkPassphrase) ||
        (typeof info === 'string' ? info : null);
      setFreighterNetworkPassphrase(passphrase || null);
    } catch {
      setFreighterNetworkPassphrase(null);
    }
  }, []);

  useEffect(() => {
    refreshMetamask();

    if (typeof window === 'undefined' || !window.ethereum) {
      return;
    }
    const eth = window.ethereum as any;
    const onChainChanged = (next: string) => setMetamaskChainId(next);
    if (typeof eth.on === 'function') {
      eth.on('chainChanged', onChainChanged);
    }
    return () => {
      if (typeof eth.removeListener === 'function') {
        eth.removeListener('chainChanged', onChainChanged);
      }
    };
  }, [refreshMetamask]);

  useEffect(() => {
    refreshFreighter();
    const id = window.setInterval(refreshFreighter, 4000);
    return () => window.clearInterval(id);
  }, [refreshFreighter, freighterConnected]);

  const writeUrlMode = (next: NetworkMode) => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('network', next);
    window.history.replaceState({}, '', url.toString());
  };

  const switchMetamaskChain = async (next: NetworkMode): Promise<{ ok: boolean; reason?: string }> => {
    if (typeof window === 'undefined' || !window.ethereum) {
      return { ok: true };
    }
    const target = expectedEthChainIdHex(next);
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: target }],
      });
      return { ok: true };
    } catch (err: any) {
      if (err?.code === 4902 && next === 'mainnet') {
        try {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: target,
                chainName: 'Ethereum Mainnet',
                rpcUrls: [MAINNET_RPC_URL],
                blockExplorerUrls: ['https://etherscan.io'],
                nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
              },
            ],
          });
          return { ok: true };
        } catch {
          return { ok: false, reason: 'metamask-add-failed' };
        }
      }
      if (err?.code === 4001) {
        return { ok: false, reason: 'user-rejected' };
      }
      return { ok: false, reason: 'metamask-switch-failed' };
    }
  };

  const setMode = useCallback(
    async (next: NetworkMode): Promise<{ ok: boolean; reason?: string }> => {
      if (next === mode) {
        return { ok: true };
      }

      if (metamaskConnected) {
        const result = await switchMetamaskChain(next);
        if (!result.ok) {
          return result;
        }
      }

      writeUrlMode(next);
      setLocalMode(next);
      await refreshMetamask();
      await refreshFreighter();
      return { ok: true };
    },
    [mode, metamaskConnected, refreshMetamask, refreshFreighter],
  );

  const refreshWalletNetworks = useCallback(() => {
    refreshMetamask();
    refreshFreighter();
  }, [refreshMetamask, refreshFreighter]);

  const expectedChain = expectedEthChainIdHex(mode);
  const expectedPassphrase = expectedStellarPassphrase(mode);

  const metamaskMatches = metamaskConnected
    ? eqHexChainId(metamaskChainId, expectedChain)
    : true;
  const freighterMatches = freighterConnected
    ? freighterNetworkPassphrase === expectedPassphrase
    : true;

  return {
    mode,
    expectedEthChainIdHex: expectedChain,
    expectedStellarPassphrase: expectedPassphrase,
    metamaskChainId,
    metamaskConnected,
    metamaskMatches,
    freighterNetworkPassphrase,
    freighterConnected,
    freighterMatches,
    hasAnyMismatch: !metamaskMatches || !freighterMatches,
    setMode,
    refreshWalletNetworks,
  };
}
