import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { ZodError } from 'zod';
import { IMAGE_MAX_BYTES } from '../shared/limits';
import { saveProjectSchema } from '../shared/schemas';
import type { Config } from './config';
import { openDb } from './db';
import { AppError } from './errors';
import { Store } from './store';

export interface BuiltApp {
  app: FastifyInstance;
  store: Store;
}

export async function buildApp(config: Pick<Config, 'dataDir' | 'webDist'>): Promise<BuiltApp> {
  const db = openDb(config.dataDir);
  const store = new Store(db, config.dataDir);
  store.sweepOrphans();

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.addHook('onClose', async () => {
    db.close();
  });

  await app.register(fastifyMultipart, { limits: { fileSize: IMAGE_MAX_BYTES, files: 1, fields: 0 } });

  app.setErrorHandler((err: Error & { code?: string; statusCode?: number }, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply
        .status(400)
        .send({ error: { code: 'INVALID_INPUT', message: '입력한 내용을 확인해 주세요.' } });
    }
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply
        .status(413)
        .send({ error: { code: 'IMAGE_TOO_LARGE', message: '이미지는 10MB 이하만 올릴 수 있어요.' } });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: 'INVALID_INPUT', message: '요청을 처리할 수 없어요.' } });
    }
    console.error(err);
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL', message: '문제가 생겼어요. 잠시 후 다시 시도해 주세요.' } });
  });

  type IdParams = { Params: { id: string } };
  type SceneParams = { Params: { id: string; position: string } };

  app.get('/api/projects', async () => ({ projects: store.listProjects() }));

  app.post('/api/projects', async (_req, reply) => {
    reply.status(201);
    return { project: store.createProject() };
  });

  app.get<IdParams>('/api/projects/:id', async (req) => ({ project: store.getProject(req.params.id) }));

  app.put<IdParams>('/api/projects/:id', async (req) => {
    const input = saveProjectSchema.parse(req.body);
    return { project: store.saveProject(req.params.id, input) };
  });

  app.delete<IdParams>('/api/projects/:id', async (req, reply) => {
    store.deleteProject(req.params.id);
    return reply.status(204).send();
  });

  app.post<SceneParams>('/api/projects/:id/scenes/:position/image', async (req) => {
    const file = await req.file();
    if (!file) throw new AppError('IMAGE_MISSING_FILE', 400, '이미지 파일을 선택해 주세요.');
    const buf = await file.toBuffer(); // 10MB 를 넘으면 FST_REQ_FILE_TOO_LARGE
    return { project: store.attachImage(req.params.id, Number(req.params.position), buf, file.filename) };
  });

  app.delete<SceneParams>('/api/projects/:id/scenes/:position/image', async (req) => ({
    project: store.removeImage(req.params.id, Number(req.params.position)),
  }));

  app.get<{ Params: { id: string } }>('/api/images/:id/file', async (req, reply) => {
    const { path: filePath, mime } = store.getImageFile(req.params.id);
    return reply
      .header('Content-Type', mime)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(fs.createReadStream(filePath));
  });

  if (config.webDist && fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '찾을 수 없어요.' } });
      }
      return reply.sendFile('index.html'); // 새로고침해도 화면 경로가 유지되도록 SPA 로 돌려준다
    });
  }

  return { app, store };
}
