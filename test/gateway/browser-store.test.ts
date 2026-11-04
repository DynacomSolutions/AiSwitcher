import { describe } from "bun:test";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { browserStoreContract } from "./browser-store-contract.ts";

describe("MemoryGatewayStore browser contract", () => {
  browserStoreContract(async () => new MemoryGatewayStore());
});
