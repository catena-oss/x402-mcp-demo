import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
// The low-level Server is the right API here, not deprecated-by-accident
// usage: the proxy forwards tools/list and tools/call verbatim without
// declaring schemas of its own, which McpServer's high-level API cannot do.
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { ExactEvmScheme } from "@x402/evm/exact/client"
import { wrapFetchWithPayment, x402Client } from "@x402/fetch"
import { privateKeyToAccount } from "viem/accounts"
import { z } from "zod"
import { moneyToMicros } from "../config.js"
import type { PaymentRequirements } from "@x402/core/types"

/** Circle USDC on Base Sepolia. The cap is denominated in micro-USD, which
 * only holds for a 6-decimal USD-pegged asset, so the policy pins it: a
 * challenge in any other token is refused rather than mis-priced. */
const USDC_BASE_SEPOLIA = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"

export interface ProxyOptions {
  upstreamUrl: string
  evmPrivateKey: `0x${string}`
  /** Total the proxy may spend across its lifetime, e.g. "$0.10". */
  spendCapUsd: string
  /** Only challenges on this network are signed. Narrowed to the one
   * network the USDC pin above is true for: any other value would price
   * the cap in the wrong asset. */
  network: "eip155:84532"
  fetchImpl?: typeof fetch
}

/** True when @x402 refused to sign because every requirement was filtered
 * by our budget policy. Do NOT match HTTP 402 or the substring "x402":
 * post-payment 402s and scheme errors also contain those and are not
 * spend-cap refusals. The vendor string is pinned by the proxy's spend-cap
 * test: if @x402 reworks the message, that test fails first. */
function isBudgetRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  return (
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("filtered out by policies")
  )
}

/**
 * The paying proxy: a local MCP server a standard client (Claude Code,
 * Claude Desktop, MCP Inspector) can spawn over stdio. It holds the wallet
 * and fronts the remote paid MCP server: tools/list is forwarded verbatim,
 * and a tools/call that draws a 402 upstream is paid transparently and
 * retried, so the standard client only ever sees ordinary tool results.
 *
 * Money discipline: the spend cap binds at the signing point (see the
 * budget policy below), and there is no separate probe request: each tool
 * executes upstream exactly once. The cap is configuration, never derived
 * from tool arguments, so a prompt-injected tool call cannot raise it.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated
export function createPayingProxy(options: ProxyOptions): Server {
  const { upstreamUrl, evmPrivateKey, spendCapUsd, network } = options
  const baseFetch = options.fetchImpl ?? fetch
  const capMicros = moneyToMicros(spendCapUsd)
  let spentMicros = 0n

  // What a challenge must look like before this proxy will sign it. The SDK
  // hands policies unparsed JSON (decodePaymentRequiredHeader is a bare
  // JSON.parse); this parse is the real boundary. A shape that does not fit
  // is refused, not repaired.
  const signableRequirement = z.object({
    network: z.literal(network),
    // .toLowerCase() is load-bearing: the server returns a checksummed
    // address, and the pinned constant is lowercase.
    asset: z.string().refine((v) => v.toLowerCase() === USDC_BASE_SEPOLIA),
    amount: z.string().regex(/^\d+$/),
    maxTimeoutSeconds: z.number().int().positive().max(600),
  })

  // The x402 client runs this synchronous policy while selecting what to
  // pay: challenges the remaining budget cannot cover are filtered out, and
  // the chosen amount is reserved in the same tick, so overlapping tool
  // calls cannot both slip under the cap. A payment that later fails leaves
  // its reservation in place: conservative in the only safe direction (the
  // proxy can underspend its cap, never overspend it).
  const budgetPolicy = (
    _x402Version: number,
    requirements: PaymentRequirements[],
  ): PaymentRequirements[] => {
    const affordable = requirements.filter((r) => {
      const parsed = signableRequirement.safeParse(r)
      return (
        parsed.success && spentMicros + BigInt(parsed.data.amount) <= capMicros
      )
    })
    const chosen = affordable[0]
    if (chosen) spentMicros += BigInt(chosen.amount)
    // Return only the reserved entry so reserved == signed by construction,
    // not by relying on the client's default first-entry selector.
    return affordable.slice(0, 1)
  }

  const signer = privateKeyToAccount(evmPrivateKey)
  const paying = wrapFetchWithPayment(
    baseFetch,
    new x402Client()
      // Pin the scheme to the configured network; do not sign eip155:* wildcards.
      .register(network, new ExactEvmScheme(signer))
      .registerPolicy(budgetPolicy),
  )

  async function connectUpstream(fetchImpl: typeof fetch): Promise<Client> {
    const client = new Client({
      name: "x402-paying-proxy",
      version: "0.1.0",
    })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(upstreamUrl), {
        fetch: fetchImpl,
      }),
    )
    return client
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: "x402-paying-proxy", version: "0.1.0" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const upstream = await connectUpstream(baseFetch)
    try {
      // Forward params so a paginated tools/list keeps its cursor.
      return await upstream.listTools(request.params)
    } finally {
      await upstream.close()
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Free tools never draw a 402, so the paying fetch is safe for every
    // call; a paid tool's first POST earns the 402 (the tool has not run
    // yet), then the wrapped fetch pays and retries: one execution total.
    const upstream = await connectUpstream(paying)
    try {
      return await upstream.callTool(request.params)
    } catch (error) {
      if (isBudgetRefusal(error)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Refused before payment: no challenge passed this proxy's policy (USDC on ${network}, within the spend cap; spent ${spentMicros} of ${capMicros} micro-USD).`,
            },
          ],
        }
      }
      throw error
    } finally {
      await upstream.close()
    }
  })

  return server
}
