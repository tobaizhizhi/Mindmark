import { defineChain, http, isAddress } from "viem";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors/injected";

const chainId = Number(process.env.NEXT_PUBLIC_MONAD_CHAIN_ID ?? "10143");
const rpcUrl =
  process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";

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

const rawRegistryAddress = process.env.NEXT_PUBLIC_REGISTRY_ADDRESS;
export const registryAddress =
  rawRegistryAddress && isAddress(rawRegistryAddress) && !/^0x0{40}$/u.test(rawRegistryAddress)
    ? rawRegistryAddress
    : null;

export const wagmiConfig = createConfig({
  chains: [monadChain],
  connectors: [injected()],
  transports: { [monadChain.id]: http(rpcUrl) },
  ssr: true,
});
