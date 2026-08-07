import { defineChain, fallback, http, isAddress } from "viem";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors/injected";

const chainId = Number(process.env.NEXT_PUBLIC_MONAD_CHAIN_ID ?? "10143");
const rpcUrl =
  process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const rpcUrls = [...new Set([
  rpcUrl,
  "https://rpc.ankr.com/monad_testnet",
  "https://rpc-testnet.monadinfra.com",
])];

export const monadChain = defineChain({
  id: chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: {
    default: {
      name: "Monad Explorer",
      url:
        process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL ??
        "https://testnet.monadexplorer.com",
    },
  },
});

const rawRegistryV2Address = process.env.NEXT_PUBLIC_REGISTRY_V2_ADDRESS;
export const registryV2Address =
  rawRegistryV2Address && isAddress(rawRegistryV2Address) && !/^0x0{40}$/u.test(rawRegistryV2Address)
    ? rawRegistryV2Address
    : null;

const rawCompletionRegistryAddress = process.env.NEXT_PUBLIC_COMPLETION_REGISTRY_ADDRESS;
export const completionRegistryAddress =
  rawCompletionRegistryAddress
  && isAddress(rawCompletionRegistryAddress)
  && !/^0x0{40}$/u.test(rawCompletionRegistryAddress)
    ? rawCompletionRegistryAddress
    : null;

export const wagmiConfig = createConfig({
  chains: [monadChain],
  connectors: [injected()],
  transports: {
    [monadChain.id]: fallback(rpcUrls.map((url) => http(url, { timeout: 4_000, retryCount: 0 }))),
  },
  ssr: true,
});
