import { Address } from "@ton/core";
import type { MessageConsequences } from "@ton-api/client";
import { describe, expect, it, vi } from "vitest";
import type { TonEmulatorClient } from "../src/client.ts";
import { emulateMessageToWallet } from "../src/emulate.ts";

// Minimal valid BOC string accepted by Cell.fromBase64 — enough to satisfy
// the boundary conversion. The SDK call itself is mocked, so the BOC is
// never actually consumed by anything that would inspect its bits.
const DUMMY_BOC = "te6cckEBAQEAAgAAAEysuc0=";

const buildClientWithMockResponse = (
  response: MessageConsequences | (() => never),
): TonEmulatorClient => ({
  enabled: true,
  baseUrl: "https://tonapi.io",
  raw: {
    emulation: {
      emulateMessageToWallet:
        typeof response === "function" ? response : vi.fn().mockResolvedValue(response),
    },
  } as unknown as TonEmulatorClient["raw"],
});

const buildResponse = (
  overrides: {
    aborted?: boolean;
    success?: boolean;
    isScam?: boolean;
  } = {},
): MessageConsequences => {
  // Build a structurally valid MessageConsequences. We only assert on the
  // few fields the mapper reads — the rest are stubs that satisfy the type.
  const placeholderAddress = Address.parseRaw(
    "0:0000000000000000000000000000000000000000000000000000000000000000",
  );
  const accountAddress = {
    address: placeholderAddress,
    name: "test",
    isScam: false,
    isWallet: true,
  };

  return {
    trace: {
      transaction: {
        hash: "deadbeef",
        lt: 1n,
        account: accountAddress,
        success: overrides.success ?? true,
        utime: 0,
        origStatus: "active",
        endStatus: "active",
        totalFees: 100n,
        endBalance: 1000n,
        transactionType: "TransOrd",
        stateUpdateOld: "",
        stateUpdateNew: "",
        // Critical for the test under examination — see "reads aborted directly"
        aborted: overrides.aborted ?? false,
        destroyed: false,
        raw: "",
      },
      interfaces: ["wallet"],
      children: [],
      emulated: true,
    },
    risk: {
      transferAllRemainingBalance: false,
      ton: 0n,
      jettons: [],
      nfts: [],
    },
    event: {
      eventId: "evt",
      account: accountAddress,
      timestamp: 0,
      actions: [],
      isScam: overrides.isScam ?? false,
      lt: 1n,
      inProgress: false,
      extra: 0n,
      progress: 1,
    },
  } as unknown as MessageConsequences;
};

describe("emulateMessageToWallet response mapping", () => {
  it("returns skipped when client is disabled", async () => {
    const client: TonEmulatorClient = {
      enabled: false,
      baseUrl: "https://tonapi.io",
      raw: {} as TonEmulatorClient["raw"],
    };

    const result = await emulateMessageToWallet(client, DUMMY_BOC);

    expect(result).toEqual({ status: "skipped", reason: "not_configured" });
  });

  it("reads `aborted` directly from trace.transaction.aborted, not !success", async () => {
    // Regression test for PR #17 review finding: the mapper used to derive
    // `aborted` from `!response.trace.transaction.success`. The two flags
    // are semantically distinct in TVM — a bounce can leave `success` true
    // while still being aborted, and vice versa. This test pins the source.
    const client = buildClientWithMockResponse(buildResponse({ aborted: true, success: true }));

    const result = await emulateMessageToWallet(client, DUMMY_BOC);

    expect(result.status).toBe("ok");

    if (result.status === "ok") {
      // success=true, aborted=true → must report aborted=true (would be
      // false under the old `!success` derivation).
      expect(result.trace.aborted).toBe(true);
    }
  });

  it("reports aborted=false when transaction is not aborted, regardless of success flag", async () => {
    const client = buildClientWithMockResponse(buildResponse({ aborted: false, success: false }));

    const result = await emulateMessageToWallet(client, DUMMY_BOC);

    expect(result.status).toBe("ok");

    if (result.status === "ok") {
      // success=false, aborted=false → must report aborted=false (would
      // be true under the old `!success` derivation).
      expect(result.trace.aborted).toBe(false);
    }
  });

  it("propagates is_scam from the event", async () => {
    const client = buildClientWithMockResponse(buildResponse({ isScam: true }));

    const result = await emulateMessageToWallet(client, DUMMY_BOC);

    expect(result.status).toBe("ok");

    if (result.status === "ok") {
      expect(result.trace.isScam).toBe(true);
    }
  });

  it("classifies a 429 SDK error as rate_limited", async () => {
    const client = buildClientWithMockResponse(() => {
      const error = new Error("Too Many Requests") as Error & { status: number };
      error.status = 429;
      throw error;
    });

    const result = await emulateMessageToWallet(client, DUMMY_BOC);

    expect(result).toEqual({ status: "failed", reason: "rate_limited", httpStatus: 429 });
  });

  it("classifies a 503 SDK error as provider_down", async () => {
    const client = buildClientWithMockResponse(() => {
      const error = new Error("Service Unavailable") as Error & { status: number };
      error.status = 503;
      throw error;
    });

    const result = await emulateMessageToWallet(client, DUMMY_BOC);

    expect(result).toEqual({ status: "failed", reason: "provider_down", httpStatus: 503 });
  });

  it("classifies a 400 SDK error as bad_request", async () => {
    const client = buildClientWithMockResponse(() => {
      const error = new Error("Bad Request") as Error & { status: number };
      error.status = 400;
      throw error;
    });

    const result = await emulateMessageToWallet(client, DUMMY_BOC);

    expect(result).toEqual({ status: "failed", reason: "bad_request", httpStatus: 400 });
  });

  it("classifies a network error (no status) as provider_down", async () => {
    const client = buildClientWithMockResponse(() => {
      throw new Error("ECONNREFUSED");
    });

    const result = await emulateMessageToWallet(client, DUMMY_BOC);

    expect(result).toEqual({ status: "failed", reason: "provider_down", httpStatus: null });
  });
});

// ── structured `details` extraction for PR-D2 diff ──────────────────────────
//
// These tests pin the mapping from TONAPI's typed action subobjects
// (Action.TonTransfer, Action.ContractDeploy) to our internal
// `EmulatedActionDetails`. The diff module relies on raw "0:hex" addresses
// and `bigint` nanoton amounts being preserved verbatim from the SDK — no
// human-text parsing.

describe("emulateMessageToWallet structured details extraction", () => {
  const recipientRaw = "0:cdce58745d265d6f9fd0ae5c79423c991d500efbe8bf9683c79556bb45ff956d";
  const deployRaw = "0:abcdef0000000000000000000000000000000000000000000000000000000000";

  const buildResponseWithActions = (actions: readonly unknown[]): MessageConsequences => {
    const base = buildResponse();
    return {
      ...base,
      event: { ...base.event, actions: actions as never },
    };
  };

  it("populates details.kind='ton_transfer' with raw recipient and bigint amount", async () => {
    const action = {
      type: "TonTransfer",
      status: "ok",
      simplePreview: { description: "ignore me — diff must not read this" },
      baseTransactions: [],
      TonTransfer: {
        sender: { address: Address.parseRaw(recipientRaw), isScam: false, isWallet: true },
        recipient: { address: Address.parseRaw(recipientRaw), isScam: false, isWallet: true },
        amount: 10_000_000n,
      },
    };
    const client = buildClientWithMockResponse(buildResponseWithActions([action]));

    const result = await emulateMessageToWallet(client, DUMMY_BOC);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.actions[0]?.details).toEqual({
        kind: "ton_transfer",
        recipient: recipientRaw,
        amountNano: 10_000_000n,
      });
    }
  });

  it("populates details.kind='contract_deploy' with raw address and interfaces", async () => {
    const action = {
      type: "ContractDeploy",
      status: "ok",
      simplePreview: { description: "Deploy NFT item" },
      baseTransactions: [],
      ContractDeploy: {
        address: Address.parseRaw(deployRaw),
        interfaces: ["nft_item", "nft_royalty"],
      },
    };
    const client = buildClientWithMockResponse(buildResponseWithActions([action]));

    const result = await emulateMessageToWallet(client, DUMMY_BOC);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.actions[0]?.details).toEqual({
        kind: "contract_deploy",
        address: deployRaw,
        interfaces: ["nft_item", "nft_royalty"],
      });
    }
  });

  it("leaves details null for kinds not in PR-D2 diff scope (e.g. JettonTransfer)", async () => {
    const action = {
      type: "JettonTransfer",
      status: "ok",
      simplePreview: { description: "Transfer 100 USDT" },
      baseTransactions: [],
      JettonTransfer: {
        /* opaque — we deliberately ignore */
      },
    };
    const client = buildClientWithMockResponse(buildResponseWithActions([action]));

    const result = await emulateMessageToWallet(client, DUMMY_BOC);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.actions[0]?.details).toBeNull();
      expect(result.actions[0]?.kind).toBe("jetton_transfer");
    }
  });

  it("leaves details null when the type-tagged subobject is missing (defensive)", async () => {
    // TONAPI sometimes ships type='TonTransfer' with no TonTransfer subobject
    // for actions that failed at the boundary. We must not throw or invent
    // data — just degrade to details=null and let the diff module skip it.
    const action = {
      type: "TonTransfer",
      status: "failed",
      simplePreview: { description: "Failed" },
      baseTransactions: [],
      // no TonTransfer subobject
    };
    const client = buildClientWithMockResponse(buildResponseWithActions([action]));

    const result = await emulateMessageToWallet(client, DUMMY_BOC);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.actions[0]?.details).toBeNull();
    }
  });
});
