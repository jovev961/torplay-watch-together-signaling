import { createTwtsService } from "./service.js";

const service = await createTwtsService();
const address = await service.listen();
const location = typeof address === "string" ? address : `${address.address}:${address.port}`;
console.log(`TWTS listening on http://${location}`);

async function shutdown() {
  await service.close();
  process.exit(0);
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
