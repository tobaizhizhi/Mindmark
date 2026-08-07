import { z } from "zod";
import { AddressSchema } from "@mindmark/shared";

const OperatorWalletAddressesSchema = z.string().default("").transform((value) => [
  ...new Set(
    value
      .split(",")
      .map((address) => address.trim())
      .filter(Boolean)
      .map((address) => AddressSchema.parse(address).toLowerCase() as `0x${string}`),
  ),
]);

const OptionalAddressSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  AddressSchema.optional(),
);

const OptionalPrivateKeySchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().regex(/^0x[0-9a-fA-F]{64}$/u).optional(),
);

const ServerEnvironmentSchema = z.object({
  MONAD_RPC_URL: z.string().url(),
  MONAD_CHAIN_ID: z.coerce.number().int().positive(),
  REGISTRY_V2_ADDRESS: AddressSchema.refine(
    (address) => address !== "0x0000000000000000000000000000000000000000",
    "REGISTRY_V2_ADDRESS must be deployed",
  ),
  PROJECT_ESCROW_ADDRESS: AddressSchema.refine(
    (address) => address !== "0x0000000000000000000000000000000000000000",
    "PROJECT_ESCROW_ADDRESS must be deployed",
  ),
  BLOCK_EXPLORER_URL: z.string().url().default("https://testnet.monadexplorer.com"),
  COMPLETION_REGISTRY_ADDRESS: OptionalAddressSchema,
  COMPLETION_ATTESTOR_PRIVATE_KEY: OptionalPrivateKeySchema,
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SESSION_SECRET: z.string().min(32),
  OPERATOR_WALLET_ADDRESSES: OperatorWalletAddressesSchema,
});

export type ServerEnvironment = z.infer<typeof ServerEnvironmentSchema>;

let cachedEnvironment: ServerEnvironment | undefined;

export function getServerEnvironment(): ServerEnvironment {
  cachedEnvironment ??= ServerEnvironmentSchema.parse({
    MONAD_RPC_URL: process.env.MONAD_RPC_URL,
    MONAD_CHAIN_ID: process.env.MONAD_CHAIN_ID,
    REGISTRY_V2_ADDRESS: process.env.REGISTRY_V2_ADDRESS,
    PROJECT_ESCROW_ADDRESS: process.env.PROJECT_ESCROW_ADDRESS,
    BLOCK_EXPLORER_URL: process.env.BLOCK_EXPLORER_URL
      ?? process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL,
    COMPLETION_REGISTRY_ADDRESS: process.env.COMPLETION_REGISTRY_ADDRESS,
    COMPLETION_ATTESTOR_PRIVATE_KEY: process.env.COMPLETION_ATTESTOR_PRIVATE_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SESSION_SECRET: process.env.SESSION_SECRET,
    OPERATOR_WALLET_ADDRESSES: process.env.OPERATOR_WALLET_ADDRESSES,
  });
  return cachedEnvironment;
}

export function resetServerEnvironmentForTests(): void {
  cachedEnvironment = undefined;
}
