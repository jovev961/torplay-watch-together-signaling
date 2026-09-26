import { createTwtsService } from "./service.js";

const redisProtocol = process.env.REDIS_URL
  ? new URL(process.env.REDIS_URL).protocol
  : "unset";

console.log(`TWTS startup: store=${process.env.WATCH_TOGETHER_STORE || "auto"} redis=${redisProtocol}`);

let service;
try {
  service = await createTwtsService();
} catch (error) {
  console.error("TWTS startup failed:", error);
  throw error;
}

console.log("TWTS storage and subscriptions are ready.");

const server = service.httpServer;

server.once("listening", () => console.log("TWTS HTTP server is listening."));
server.listen(Number(process.env.PORT ?? 3000));

export default server;
