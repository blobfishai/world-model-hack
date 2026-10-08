const apiKey = process.env.REACTOR_API_KEY;
const modelName = "reactor/helios";

if (!apiKey) {
  console.error("Set REACTOR_API_KEY in .env, then run pnpm reactor:check again.");
  process.exit(1);
}

try {
  const response = await fetch("https://api.reactor.inc/tokens", {
    method: "POST",
    headers: {
      "Reactor-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: 300,
      authorization_details: [
        {
          type: "session",
          resources: { models: { match: [modelName] } },
          constraints: { max_sessions: 1 },
        },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Reactor token request failed (HTTP ${response.status}).`);
  }

  const { jwt, expires_at } = await response.json();
  if (
    typeof jwt !== "string" ||
    jwt.split(".").length !== 3 ||
    typeof expires_at !== "number" ||
    expires_at <= Date.now() / 1000
  ) {
    throw new Error("Reactor returned an invalid or expired token.");
  }

  console.log(`Reactor authentication verified for ${modelName}.`);
  console.log(`Token expires at ${new Date(expires_at * 1000).toISOString()}.`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Reactor check failed: ${message.replaceAll(apiKey, "[redacted]")}`);
  process.exitCode = 1;
}
