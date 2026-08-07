import { SiweMessage } from "siwe";
import { describe, expect, it } from "vitest";
import { createWalletSignInMessage } from "@/lib/client/wallet-auth";

describe("wallet sign-in message", () => {
  it("creates an EIP-4361 message accepted by the SIWE parser", () => {
    const message = createWalletSignInMessage({
      address: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
      nonce: {
        domain: "localhost:3000",
        uri: "http://localhost:3000",
        chainId: 10143,
        nonce: "0123456789abcdef0123456789abcdef",
        expiresAt: "2026-08-06T08:10:00.000Z",
      },
      issuedAt: "2026-08-06T08:00:00.000Z",
    });

    const parsed = new SiweMessage(message);
    expect(parsed.statement).toBe("Sign in to Mindmark");
    expect(parsed.expirationTime).toBe("2026-08-06T08:10:00.000Z");
  });
});
