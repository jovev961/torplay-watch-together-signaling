import { createTwtsService } from "../src/server.js";

const service = await createTwtsService();

export default service.httpServer;
