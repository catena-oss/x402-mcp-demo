import { createServer } from "node:http"
import { createPaidMcpServer } from "../src/server/paid-mcp-server.js"
import type { FacilitatorClient } from "@x402/core/server"
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types"
import type { Server } from "node:http"

export const TEST_NETWORK: Network = "eip155:84532"
export const TEST_PAY_TO = "0x0000000000000000000000000000000000000001"
/** Unfunded throwaway key: fine because the fake facilitator approves
 * payments without touching a chain. */
export const TEST_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const

/** Records every verify/settle call and approves everything, so tests can
 * assert exactly when settlement is (and is not) reached without a network. */
export class FakeFacilitatorClient implements FacilitatorClient {
  readonly verifyCalls: PaymentPayload[] = []
  readonly settleCalls: PaymentPayload[] = []

  verify(
    payload: PaymentPayload,
    _requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.verifyCalls.push(payload)
    return Promise.resolve({ isValid: true })
  }

  settle(
    payload: PaymentPayload,
    _requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.settleCalls.push(payload)
    return Promise.resolve({
      success: true,
      transaction: "0xtest-settlement-transaction",
      network: TEST_NETWORK,
    })
  }

  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve({
      kinds: [{ x402Version: 2, scheme: "exact", network: TEST_NETWORK }],
      extensions: [],
      signers: {},
    })
  }
}

export interface TestServer {
  url: string
  facilitator: FakeFacilitatorClient
  close: () => Promise<void>
}

export async function startTestServer(price = "$0.001"): Promise<TestServer> {
  const facilitator = new FakeFacilitatorClient()
  const app = createPaidMcpServer({
    payTo: TEST_PAY_TO,
    price,
    network: TEST_NETWORK,
    facilitatorClient: facilitator,
  })
  const server: Server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine test server port")
  }
  return {
    url: `http://localhost:${address.port}`,
    facilitator,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      }),
  }
}
