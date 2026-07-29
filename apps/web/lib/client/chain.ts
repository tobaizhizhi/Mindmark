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

const rawRegistryV2Address = process.env.NEXT_PUBLIC_REGISTRY_V2_ADDRESS;
export const registryV2Address =
  rawRegistryV2Address && isAddress(rawRegistryV2Address) && !/^0x0{40}$/u.test(rawRegistryV2Address)
    ? rawRegistryV2Address
    : null;

export const wagmiConfig = createConfig({
  chains: [monadChain],
  connectors: [injected()],
  transports: { [monadChain.id]: http(rpcUrl) },
  ssr: true,
});
