/**
 * Golden path in one process: boot the paid MCP server (real facilitator),
 * front it with the paying proxy, and drive a standard MCP client through
 * the proxy: free discovery, then a paid tool call that settles real testnet
 * USDC into the configured payTo address.
 *
 * Usage: tsx scripts/demo.ts   (requires SELLER_PAY_TO_ADDRESS and
 * BUYER_EVM_PRIVATE_KEY in .env)
 */
import { createServer } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { HTTPFacilitatorClient } from "@x402/core/server"
import { decodePaymentResponseHeader } from "@x402/fetch"
import { loadConfig } from "../src/config.js"
import { createPayingProxy } from "../src/proxy/paying-proxy.js"
import {
  createPaidMcpServer,
  MCP_PATH,
  PAID_TOOL,
} from "../src/server/paid-mcp-server.js"
import type { SettleResponse } from "@x402/core/types"

const config = loadConfig()
if (!config.SELLER_PAY_TO_ADDRESS || !config.BUYER_EVM_PRIVATE_KEY) {
  console.error(
    "SELLER_PAY_TO_ADDRESS and BUYER_EVM_PRIVATE_KEY are required (see .env.example)",
  )
  process.exit(2)
}

const app = createPaidMcpServer({
  payTo: config.SELLER_PAY_TO_ADDRESS,
  price: config.TOOL_PRICE_USD,
  network: config.X402_NETWORK,
  facilitatorClient: new HTTPFacilitatorClient({
    url: config.X402_FACILITATOR_URL,
  }),
})
const httpServer = createServer(app)
await new Promise<void>((resolve, reject) => {
  httpServer.once("error", reject)
  httpServer.listen(config.MCP_PORT, resolve)
})
const upstreamUrl = `http://localhost:${config.MCP_PORT}${MCP_PATH}`
console.log(`Paid MCP server: ${upstreamUrl} (price ${config.TOOL_PRICE_USD})`)
console.log(`Pay-to:          ${config.SELLER_PAY_TO_ADDRESS}\n`)

// Capture the settlement receipt the facilitator returns, so the demo can
// show the transaction instead of asserting that one happened.
let settlement: SettleResponse | undefined
const capturingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  const header = response.headers.get("payment-response")
  if (header) {
    try {
      settlement = decodePaymentResponseHeader(header)
    } catch {
      // a malformed receipt header is not worth failing the demo over
    }
  }
  return response
}

const proxy = createPayingProxy({
  upstreamUrl,
  evmPrivateKey: config.BUYER_EVM_PRIVATE_KEY,
  spendCapUsd: config.PROXY_SPEND_CAP_USD,
  network: config.X402_NETWORK,
  fetchImpl: capturingFetch,
})
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await proxy.connect(serverTransport)
const client = new Client({ name: "demo-client", version: "0.1.0" })
await client.connect(clientTransport)

try {
  const tools = await client.listTools()
  console.log(`tools/list (free): ${tools.tools.map((t) => t.name).join(", ")}`)

  const result = await client.callTool({
    name: PAID_TOOL,
    arguments: { topic: "usdc-liquidity" },
  })
  if (result.isError) {
    console.error(`FAIL: paid call errored: ${JSON.stringify(result.content)}`)
    process.exitCode = 1
  } else {
    console.log(
      `tools/call ${PAID_TOOL} (paid): ${JSON.stringify(result.content).slice(0, 120)}...`,
    )
    if (settlement?.transaction) {
      console.log(
        `Settled on-chain: https://sepolia.basescan.org/tx/${settlement.transaction}`,
      )
    }
    console.log(
      "\nPASS: discovery was free, the paid tool settled over x402, and the result came back through the proxy.",
    )
  }
} finally {
  await client.close()
  await new Promise<void>((resolve, reject) => {
    httpServer.closeAllConnections()
    httpServer.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
