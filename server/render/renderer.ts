import fs from 'node:fs';
import path from 'node:path';
import { DURATION_MAX_SEC, DURATION_MIN_SEC, VIDEO } from '../../shared/limits';
import { buildAss } from './ass';
import { RenderError, imageDecodeFailed } from './errors';
import { escapeFilterValue, run } from './ffmpeg';
import { loadMeasurer } from './font';

export interface RenderScene {
  text: string;
  durationSec: number;
  imagePath: string;
}

export interface RenderInput {
  scenes: RenderScene[];
  /** 이 작업 전용 임시 폴더. 결과 파일 `output.mp4` 도 여기에 만든다. */
  workDir: string;
}

export interface RenderHooks {
  /** 2 = 장면 화면 만들기, 3 = MP4 파일로 저장 (화면의 단계 목록과 같은 번호) */
  onStep(step: 2 | 3): void;
  signal: AbortSignal;
}

export interface RenderResult {
  outputPath: string;
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface Renderer {
  render(input: RenderInput, hooks: RenderHooks): Promise<RenderResult>;
}

export interface FfmpegRendererOptions {
  ffmpegPath: string;
  ffprobePath: string;
  fontsDir: string;
  timeoutMs: number;
}

export class FfmpegRenderer implements Renderer {
  constructor(private readonly o: FfmpegRendererOptions) {}

  async render(input: RenderInput, hooks: RenderHooks): Promise<RenderResult> {
    const { ffmpegPath, ffprobePath, fontsDir, timeoutMs } = this.o;
    const { scenes, workDir } = input;
    const base = { cwd: workDir, timeoutMs, signal: hooks.signal };

    const fontFile = path.join(fontsDir, 'NotoSansKR-SemiBold.ttf');
    if (!fs.existsSync(fontFile)) {
      throw new RenderError('FONT_MISSING', '자막 글꼴을 찾을 수 없어요', '서버의 fonts 폴더에 Noto Sans KR 글꼴이 있어야 해요.', fontsDir);
    }
    const measurer = loadMeasurer(fontFile);
    fs.mkdirSync(workDir, { recursive: true });
    hooks.onStep(2);

    // 1) 이미지를 장면별로 먼저 한 번씩 디코딩해 본다. 실패하면 몇 번째 장면인지 알 수 있다.
    for (const [i, s] of scenes.entries()) {
      try {
        await run(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-i', s.imagePath, '-frames:v', '1', '-f', 'null', '-'], base);
      } catch (e) {
        if (e instanceof RenderError && e.code === 'RENDER_FAILED') throw imageDecodeFailed(i + 1, e.detail);
        throw e;
      }
    }

    // 2) 장면별 자막 파일과 ffmpeg 인자
    scenes.forEach((s, i) => {
      if (!(s.durationSec >= DURATION_MIN_SEC && s.durationSec <= DURATION_MAX_SEC)) {
        throw new RenderError('INTERNAL', '영상을 만드는 중에 문제가 생겼어요', '장면 길이가 올바르지 않아요.', `scene ${i + 1}: ${s.durationSec}`);
      }
      fs.writeFileSync(path.join(workDir, `s${i}.ass`), buildAss(s.text, s.durationSec, measurer), 'utf8');
    });

    const { width, height, fps } = VIDEO;
    const fonts = escapeFilterValue(fontsDir);
    const inputs = scenes.flatMap((s, i) => ['-loop', '1', '-framerate', String(fps), '-t', String(s.durationSec), '-i', scenes[i]!.imagePath]);
    // 이미지는 프레임 배경색 위에 올린다. 투명 PNG 의 투명 영역(과 그 아래 숨은 색)이 그대로 비치지 않고,
    // 미리보기(어두운 프레임 배경 위에 이미지)와 같게 보이도록 하기 위해서다. 불투명 이미지는 결과가 같다.
    const chains = scenes.map(
      (s, i) =>
        `color=c=0x${VIDEO.background}:s=${width}x${height}:r=${fps}:d=${s.durationSec}[bg${i}];` +
        `[${i}:v]format=rgba,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[fg${i}];` +
        // overlay 는 장면마다 마지막 프레임을 하나 잃는다(30초 영상이 29.9초가 됨). 프레임을 몇 개 복제해 붙인 뒤
        // 정확한 프레임 수(길이×fps)로 자르면 어떤 길이에서도 결과가 같다.
        `[bg${i}][fg${i}]overlay=shortest=1:format=auto,format=yuv420p,fps=${fps},` +
        `tpad=stop_mode=clone:stop=5,trim=end_frame=${s.durationSec * fps},setpts=PTS-STARTPTS,` +
        `subtitles=s${i}.ass:fontsdir=${fonts}[v${i}]`,
    );
    const concat = `${scenes.map((_, i) => `[v${i}]`).join('')}concat=n=${scenes.length}:v=1:a=0[v]`;
    const args = [
      '-hide_banner', '-nostdin', '-y', '-v', 'error',
      ...inputs,
      '-filter_complex', [...chains, concat].join(';'),
      '-map', '[v]', '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-movflags', '+faststart',
      'output.mp4',
    ];
    await run(ffmpegPath, args, base);

    // 3) 결과 확인: 길이·해상도·소리 없음
    hooks.onStep(3);
    const outputPath = path.join(workDir, 'output.mp4');
    const probe = await run(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', outputPath],
      base,
    );
    const info = JSON.parse(probe.stdout) as { streams: Array<{ codec_type: string; width?: number; height?: number }>; format: { duration: string } };
    const v = info.streams.find((s) => s.codec_type === 'video');
    const result: RenderResult = {
      outputPath,
      durationSec: Number(info.format.duration),
      width: v?.width ?? 0,
      height: v?.height ?? 0,
      hasAudio: info.streams.some((s) => s.codec_type === 'audio'),
    };
    const expected = scenes.reduce((a, s) => a + s.durationSec, 0);
    if (result.width !== width || result.height !== height || result.hasAudio || Math.abs(result.durationSec - expected) > 0.5) {
      throw new RenderError(
        'OUTPUT_INVALID',
        '완성된 영상을 확인하지 못했어요',
        '잠시 후 다시 시도해 주세요.',
        `기대: ${width}x${height}, 소리 없음, ${expected}초 / 실제: ${JSON.stringify(result)}`,
      );
    }
    return result;
  }
}
