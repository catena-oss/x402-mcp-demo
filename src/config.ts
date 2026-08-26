import { z } from "zod"

/** Exact money: "$x.yz" strings to bigint micro-dollars; USDC's 6 decimals
 * make atomic units and micro-dollars the same scale. No floats on the
 * money path. */
export function moneyToMicros(money: string): bigint {
  const match = /^\$(\d+)(?:\.(\d+))?$/.exec(money)
  if (!match?.[1]) {
    throw new Error(`Invalid money string: ${money}`)
  }
  const whole = match[1]
  const rawFraction = match[2] ?? ""
  if (rawFraction.length > 6) {
    throw new Error(`Too many decimal places for micro-dollars: ${money}`)
  }
  return BigInt(whole) * 1_000_000n + BigInt(rawFraction.padEnd(6, "0"))
}

/** .env.example ships these keys blank, so an untouched copy must read as
 * absent rather than as an empty string that fails the regex. */
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v)

/** A positive US-dollar amount, e.g. "$0.001". The refine must not throw:
 * zod v4 runs it even when the regex above already failed, and a thrown
 * error would replace the prettified env report with a stack trace. */
const usdAmount = z
  .string()
  .regex(/^\$\d+(\.\d{1,6})?$/)
  .refine((v) => /[1-9]/.test(v), "must be greater than 0")

const envSchema = z.object({
  MCP_PORT: z.coerce.number().int().positive().max(65535).default(4040),
  /** Address receiving tool-call payments: the Catena sandbox account's
   * base-sepolia USDC deposit address, so settlement lands in a
   * Catena-governed account. */
  SELLER_PAY_TO_ADDRESS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
  ),
  /** Price of one paid tool invocation. */
  TOOL_PRICE_USD: usdAmount.default("$0.02"),
  X402_NETWORK: z.literal("eip155:84532").default("eip155:84532"),
  X402_FACILITATOR_URL: z.url().default("https://x402.org/facilitator"),
  /** Funded Base Sepolia key the paying proxy signs payments with. */
  BUYER_EVM_PRIVATE_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .transform((v) => v as `0x${string}`)
      .optional(),
  ),
  /** Upstream paid MCP server the proxy fronts. */
  UPSTREAM_MCP_URL: z.url().default("http://localhost:4040/mcp"),
  /** Total the proxy may spend across its lifetime. */
  PROXY_SPEND_CAP_USD: usdAmount.default("$0.10"),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    process.loadEnvFile()
  } catch {
    // no .env file; environment variables may be set directly
  }
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    // Exit 2 is this repo's config-error code (1 means a dependency is
    // unreachable). A stack trace would bury the one line that helps.
    console.error(
      `Invalid environment (see .env.example):\n${z.prettifyError(parsed.error)}`,
    )
    process.exit(2)
  }
  return parsed.data
}
