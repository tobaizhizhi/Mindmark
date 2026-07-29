import { createHmac, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getAddress } from "viem";
import { SiweMessage } from "siwe";
import type { AuthVerifyRequest } from "@mindmark/shared";
import { ApiError } from "./http";
import { getServerEnvironment } from "./config";
import { getSupabaseAdmin } from "./supabase";

export const SESSION_COOKIE = "mindmark_session";
export const SESSION_DURATION_SECONDS = 60 * 60 * 12;

export type WalletSession = {
  address: `0x${string}`;
  expiresAt: string;
};

export interface AuthStore {
  saveNonce(address: `0x${string}`, nonce: string, expiresAt: string): Promise<void>;
  consumeNonce(address: `0x${string}`, nonce: string): Promise<boolean>;
  saveSession(address: `0x${string}`, tokenHash: string, expiresAt: string): Promise<void>;
  findSession(tokenHash: string): Promise<WalletSession | null>;
  revokeSession(tokenHash: string): Promise<void>;
}

export class SupabaseAuthStore implements AuthStore {
  async saveNonce(address: `0x${string}`, nonce: string, expiresAt: string): Promise<void> {
    const { error } = await getSupabaseAdmin().from("auth_nonces").insert({
      nonce,
      wallet_address: address,
      expires_at: expiresAt,
    });
    if (error) throw new Error(`Could not save auth nonce: ${error.message}`);
  }

  async consumeNonce(address: `0x${string}`, nonce: string): Promise<boolean> {
    const { data, error } = await getSupabaseAdmin().rpc("consume_auth_nonce", {
      p_nonce: nonce,
      p_wallet_address: address,
    });
    if (error) throw new Error(`Could not consume auth nonce: ${error.message}`);
    return data === true;
  }

  async saveSession(
    address: `0x${string}`,
    tokenHash: string,
    expiresAt: string,
  ): Promise<void> {
    const { error } = await getSupabaseAdmin().from("wallet_sessions").insert({
      wallet_address: address,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });
    if (error) throw new Error(`Could not save wallet session: ${error.message}`);
  }

  async findSession(tokenHash: string): Promise<WalletSession | null> {
    const { data, error } = await getSupabaseAdmin()
      .from("wallet_sessions")
      .select("wallet_address, expires_at")
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error) throw new Error(`Could not read wallet session: ${error.message}`);
    if (!data) return null;
    return {
      address: getAddress(data.wallet_address).toLowerCase() as `0x${string}`,
      expiresAt: data.expires_at,
    };
  }

  async revokeSession(tokenHash: string): Promise<void> {
    const { error } = await getSupabaseAdmin()
      .from("wallet_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token_hash", tokenHash);
    if (error) throw new Error(`Could not revoke wallet session: ${error.message}`);
  }
}

export function createNonce(): string {
  return randomBytes(16).toString("hex");
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

export async function verifySiweCredentials(
  request: AuthVerifyRequest,
  expected: { domain: string; uri: string; chainId: number },
  consumeNonce: (address: `0x${string}`, nonce: string) => Promise<boolean>,
): Promise<`0x${string}`> {
  const message = new SiweMessage(request.message);
  if (message.chainId !== expected.chainId || message.uri !== expected.uri) {
    throw new ApiError(401, "invalid_siwe_scope", "SIWE chain or origin does not match");
  }

  const verification = await message.verify({
    signature: request.signature,
    domain: expected.domain,
    nonce: message.nonce,
    time: new Date().toISOString(),
  });
  if (!verification.success) {
    throw new ApiError(401, "invalid_signature", "Wallet signature verification failed");
  }

  const address = getAddress(message.address).toLowerCase() as `0x${string}`;
  if (!(await consumeNonce(address, message.nonce))) {
    throw new ApiError(401, "invalid_nonce", "The login nonce is expired or already used");
  }
  return address;
}

export async function readWalletSession(
  store: AuthStore = new SupabaseAuthStore(),
): Promise<WalletSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const environment = getServerEnvironment();
  return store.findSession(hashSessionToken(token, environment.SESSION_SECRET));
}

export async function requireWalletSession(): Promise<WalletSession> {
  const session = await readWalletSession();
  if (!session) throw new ApiError(401, "authentication_required", "Connect and sign in first");
  return session;
}

export async function requireOperatorSession(): Promise<WalletSession> {
  const session = await requireWalletSession();
  if (!getServerEnvironment().OPERATOR_WALLET_ADDRESSES.includes(session.address)) {
    throw new ApiError(403, "operator_access_required", "This wallet is not allowed to view operations");
  }
  return session;
}
