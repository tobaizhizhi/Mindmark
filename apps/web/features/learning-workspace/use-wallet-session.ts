"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSignMessage,
  useSwitchChain,
} from "wagmi";
import type { AuthNonceResponse, AuthVerifyResponse } from "@mindmark/shared";
import { monadChain } from "@/lib/client/chain";
import { parseApiResponse as parseApi } from "@/lib/client/http";
import { createWalletSignInMessage } from "@/lib/client/wallet-auth";

type WalletSessionResponse = {
  session: { address: string; expiresAt?: string } | null;
};

export function useWalletSession(input: { onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { address: connectedAddress, chainId, isConnected } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const sessionQuery = useQuery({
    queryKey: ["wallet-session"],
    queryFn: async () => {
      const response = await fetch("/api/auth/session");
      if (!response.ok) throw new Error("登录状态读取失败");
      return response.json() as Promise<WalletSessionResponse>;
    },
    staleTime: 30_000,
  });
  const sessionAddress = sessionQuery.data?.session?.address?.toLowerCase() ?? null;
  const loggedIn = Boolean(sessionAddress);
  const address = sessionAddress ?? connectedAddress;

  async function signIn(walletAddress: string, walletChainId: number | undefined) {
    if (walletChainId !== monadChain.id) await switchChainAsync({ chainId: monadChain.id });
    const nonce = await parseApi<AuthNonceResponse>(await fetch("/api/auth/nonce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: walletAddress }),
    }));
    const message = createWalletSignInMessage({
      address: walletAddress,
      nonce,
    });
    const signature = await signMessageAsync({ message });
    const verified = await parseApi<AuthVerifyResponse>(await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature }),
    }));
    queryClient.setQueryData<WalletSessionResponse>(["wallet-session"], {
      session: { address: verified.address.toLowerCase(), expiresAt: verified.expiresAt },
    });
    void queryClient.invalidateQueries({ predicate: (query) => (
      typeof query.queryKey[0] === "string"
      && (query.queryKey[0].startsWith("learning-") || query.queryKey[0].startsWith("document-library"))
    ) });
  }

  async function authenticate() {
    setBusy(true);
    setError(null);
    try {
      if (loggedIn) {
        await fetch("/api/auth/logout", { method: "POST" });
        queryClient.setQueryData<WalletSessionResponse>(["wallet-session"], { session: null });
        queryClient.removeQueries({ predicate: (query) => (
          typeof query.queryKey[0] === "string"
          && (query.queryKey[0].startsWith("learning-") || query.queryKey[0].startsWith("document-library"))
        ) });
        await disconnectAsync();
        input.onSignedOut();
        return;
      }
      if (isConnected && connectedAddress) {
        await signIn(connectedAddress, chainId);
        return;
      }
      const connector = connectors[0];
      if (!connector) throw new Error("未检测到浏览器钱包");
      const connection = await connectAsync({ connector, chainId: monadChain.id });
      await signIn(connection.accounts[0], connection.chainId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "钱包登录失败");
    } finally {
      setBusy(false);
    }
  }

  return {
    address,
    isConnected,
    loggedIn,
    busy,
    error,
    authenticate,
  };
}
