import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { ZodError } from 'zod';
import { IMAGE_MAX_BYTES } from '../shared/limits';
import { saveProjectSchema } from '../shared/schemas';
import { loadConfig, type Config } from './config';
import { openDb } from './db';
import { AppError, notFound } from './errors';
import { FfmpegRenderer, type Renderer } from './render/renderer';
import { RenderQueue } from './renderQueue';
import { RenderStore } from './renderStore';
import { Store } from './store';

export interface BuiltApp {
  app: FastifyInstance;
  store: Store;
  renders: RenderStore;
  queue: RenderQueue;
}

export type AppConfig = Pick<Config, 'dataDir' | 'webDist'> &
  Partial<Pick<Config, 'ffmpegPath' | 'ffprobePath' | 'fontsDir' | 'renderTimeoutMs'>>;

/** `deps.renderer` 는 테스트에서 가짜 렌더러를 끼우기 위한 자리다. */
export async function buildApp(config: AppConfig, deps: { renderer?: Renderer } = {}): Promise<BuiltApp> {
  const db = openDb(config.dataDir);
  const store = new Store(db, config.dataDir);
  const renders = new RenderStore(db, store);
  const defaults = loadConfig({});
  const renderer =
    deps.renderer ??
    new FfmpegRenderer({
      ffmpegPath: config.ffmpegPath ?? defaults.ffmpegPath,
      ffprobePath: config.ffprobePath ?? defaults.ffprobePath,
      fontsDir: config.fontsDir ?? defaults.fontsDir,
      timeoutMs: config.renderTimeoutMs ?? defaults.renderTimeoutMs,
    });
  const queue = new RenderQueue(renders, store, renderer);

  // 시작 시 복구: 진행 중이던 작업은 실패로 표시(사용자가 직접 재시도), 임시/고아 파일 정리.
  // 입력 내용과 장면이 쓰는 이미지는 건드리지 않는다.
  renders.failInterrupted();
  renders.sweepFiles();
  store.sweepOrphans();

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.addHook('onClose', async () => {
    await queue.close();
    db.close();
  });

  await app.register(fastifyMultipart, { limits: { fileSize: IMAGE_MAX_BYTES, files: 1, fields: 0 } });

  app.setErrorHandler((err: Error & { code?: string; statusCode?: number }, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...err.extra } });
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

  // 영상 생성: 요청(POST)과 상태 조회(GET)를 분리한다. 요청은 접수만 하고 바로 돌려준다.
  app.post<IdParams>('/api/projects/:id/renders', async (req, reply) => {
    const job = renders.createJob(req.params.id);
    queue.kick();
    return reply.status(202).send({ job: renders.toView(job) });
  });

  app.get<IdParams>('/api/projects/:id/renders/latest', async (req) => {
    const job = renders.latestForProject(req.params.id);
    return { job: job ? renders.toView(job) : null };
  });

  // 프로젝트 경로 아래에서 특정 작업을 조회한다. 다른 프로젝트의 작업 ID 는 404 로 취급해
  // 주소(/projects/A/result/<B 의 작업>)로 다른 프로젝트의 영상·문구가 보이지 않게 한다.
  app.get<{ Params: { id: string; jobId: string } }>('/api/projects/:id/renders/:jobId', async (req) => {
    const job = renders.requireJob(req.params.jobId);
    if (job.project_id !== req.params.id) throw notFound('작업');
    return { job: renders.toView(job) };
  });

  app.get<IdParams>('/api/renders/:id', async (req) => ({ job: renders.toView(renders.requireJob(req.params.id)) }));

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>('/api/renders/:id/video', async (req, reply) => {
    const job = renders.requireJob(req.params.id);
    const file = job.video_file ? renders.videoPathFor(job.project_id, job.id) : null;
    if (job.status !== 'done' || !file || !fs.existsSync(file)) {
      throw new AppError('NOT_FOUND', 404, '완성된 영상을 찾을 수 없어요.');
    }
    const size = fs.statSync(file).size;
    reply.header('Content-Type', 'video/mp4').header('Accept-Ranges', 'bytes').header('X-Content-Type-Options', 'nosniff');
    if (req.query.download) {
      const title = (JSON.parse(job.snapshot_json) as { title: string }).title;
      reply.header('Content-Disposition', contentDisposition(`${safeFileStem(title)}.mp4`));
    }
    // 재생(<video>)이 탐색할 수 있도록 Range 요청을 지원한다.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : size - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end || start >= size) {
        return reply.status(416).header('Content-Range', `bytes */${size}`).send();
      }
      return reply
        .status(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Content-Length', end - start + 1)
        .send(fs.createReadStream(file, { start, end }));
    }
    return reply.header('Content-Length', size).send(fs.createReadStream(file));
  });

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

  return { app, store, renders, queue };
}

/** 다운로드 파일 이름으로 쓸 수 있게 제목을 정리한다(경로 구분자·제어문자 제거, 길이 제한). */
export function safeFileStem(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return Array.from(cleaned).slice(0, 80).join('') || '영상';
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
