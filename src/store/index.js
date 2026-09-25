import { MemoryRoomStore } from "./memory.js";
import { RedisRoomStore } from "./redis.js";

export function createStore(config, options = {}) {
  if (config.store === "redis") {
    return new RedisRoomStore({
      url: config.redisUrl,
      prefix: config.redisPrefix,
      now: options.now,
      clientFactory: options.clientFactory,
    });
  }
  return new MemoryRoomStore({ now: options.now });
}
