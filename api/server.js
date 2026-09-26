import { createTwtsService } from "../src/service.js";

const service = await createTwtsService();

export default service.httpServer;
