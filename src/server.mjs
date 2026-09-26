import { createTwtsService } from "./service.js";

const service = await createTwtsService();
const server = service.httpServer;

server.listen(Number(process.env.PORT ?? 3000));

export default server;
