import { privateKeyToAccount } from "viem/accounts";
import { SiweMessage } from "siwe";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/server/http";
import { hashSessionToken, verifySiweCredentials } from "@/lib/server/auth";

const account = privateKeyToAccount(`0x${"12".repeat(32)}`);
const expected = {
  domain: "localhost:3000",
  uri: "http://localhost:3000",
  chainId: 10143,
};

async function signedRequest(nonce: string) {
  const message = new SiweMessage({
    domain: expected.domain,
    address: account.address,
    statement: "Sign in to Mindmark",
    uri: expected.uri,
    version: "1",
    chainId: expected.chainId,
    nonce,
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
  }).prepareMessage();
  const signature = await account.signMessage({ message });
  return { message, signature };
}

describe("SIWE session security", () => {
  it("verifies scope and consumes the nonce exactly once", async () => {
    const request = await signedRequest("abc12345def67890");
    let available = true;
    const consume = async () => {
      if (!available) return false;
      available = false;
      return true;
    };

    await expect(verifySiweCredentials(request, expected, consume)).resolves.toBe(
      account.address.toLowerCase(),
    );
    await expect(verifySiweCredentials(request, expected, consume)).rejects.toMatchObject({
      status: 401,
      code: "invalid_nonce",
    } satisfies Partial<ApiError>);
  });

  it("rejects a valid signature from the wrong chain scope", async () => {
    const request = await signedRequest("chain1234nonce");
    await expect(
      verifySiweCredentials(request, { ...expected, chainId: 1 }, async () => true),
    ).rejects.toMatchObject({ code: "invalid_siwe_scope" });
  });

  it("peppers session tokens before persistence", () => {
    const first = hashSessionToken("raw-session-token", "a".repeat(32));
    const second = hashSessionToken("raw-session-token", "b".repeat(32));
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toBe(second);
    expect(first).not.toContain("raw-session-token");
  });
});

