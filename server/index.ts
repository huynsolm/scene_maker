import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { app } = await buildApp(config);

await app.listen({ port: config.port, host: config.host });
console.log(`씬 메이커 서버: http://${config.host}:${config.port}  (데이터: ${config.dataDir})`);
