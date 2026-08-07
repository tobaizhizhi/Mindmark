import type { AuthNonceResponse } from "@mindmark/shared";
import { SiweMessage } from "siwe";

const WALLET_SIGN_IN_STATEMENT = "Sign in to Mindmark";

export function createWalletSignInMessage(input: {
  address: string;
  nonce: AuthNonceResponse;
  issuedAt?: string;
}): string {
  return new SiweMessage({
    domain: input.nonce.domain,
    address: input.address,
    statement: WALLET_SIGN_IN_STATEMENT,
    uri: input.nonce.uri,
    version: "1",
    chainId: input.nonce.chainId,
    nonce: input.nonce.nonce,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    expirationTime: input.nonce.expiresAt,
  }).prepareMessage();
}
