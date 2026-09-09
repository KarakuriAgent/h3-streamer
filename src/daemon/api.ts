import { Router, type Request, type Response } from "express";
import type { Daemon } from "./index.ts";
import { DirectorError, SessionEndedError } from "./director.ts";
import { assertDirection, buildPrompt, DirectionBlockedError } from "./prompt.ts";
import { TtsError } from "./tts.ts";
import type { DirectorPromptRequest } from "../shared/protocol.ts";

interface ErrorBody {
  ok: false;
  error: string;
  message: string;
  /** direction_blocked のとき、当たった禁止語。 */
  hits?: string[];
  /** session_ended のとき、セッションが終わった理由。 */
  reason?: string;
}

/** 例外を CLI に返す JSON にする。テストから直接呼べるように export してある。 */
export function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
  // セッションが死んでいる間の speak / direct。何も消費していないことを示す。
  if (error instanceof SessionEndedError) {
    return {
      status: 409,
      body: { ok: false, error: error.code, reason: error.reason, message: error.message },
    };
  }
  // 禁止語に当たった direction は Director に送らない（SPEC §3.1）。
  if (error instanceof DirectionBlockedError) {
    return {
      status: 422,
      body: { ok: false, error: error.code, hits: error.hits, message: error.message },
    };
  }
  if (error instanceof TtsError) {
    return { status: 503, body: { ok: false, error: error.code, message: error.message } };
  }
  if (error instanceof DirectorError) {
    return { status: 409, body: { ok: false, error: error.code, message: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/FAL_KEY/.test(message)) {
    return { status: 503, body: { ok: false, error: "fal_key_missing", message } };
  }
  return { status: 500, body: { ok: false, error: "internal_error", message } };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * CLI 向けのローカル HTTP API。127.0.0.1 のみで待ち受ける（index.ts が bind する）。
 * すべて JSON を返し、失敗時は `{ ok: false, error, message }`。
 */
export function createApiRouter(daemon: Daemon): Router {
  const router = Router();

  const wrap =
    (handler: (request: Request, response: Response) => Promise<void> | void) =>
    async (request: Request, response: Response): Promise<void> => {
      try {
        await handler(request, response);
      } catch (error) {
        const { status, body } = toErrorBody(error);
        daemon.state.log("error", `${request.method} ${request.path}: ${body.message}`);
        response.status(status).json(body);
      }
    };

  router.get("/status", wrap(async (_request, response) => {
    response.json(await daemon.status());
  }));

  router.get("/comments", wrap((request, response) => {
    const limit = Number(request.query.limit ?? 20);
    const comments = daemon.state.comments(Number.isFinite(limit) ? limit : 20).map((c) => ({
      id: c.id,
      author: c.author,
      text: c.text,
      published_at: c.publishedAt,
    }));
    response.json({ ok: true, comments });
  }));

  // `h3 comments skip`：生成できないコメントを発話せずに使用済みにする。
  router.post("/comments/skip", wrap((request, response) => {
    const body = request.body as Record<string, unknown>;
    const commentId = asString(body.comment_id ?? body.id);
    if (!commentId) {
      response.status(400).json({ ok: false, error: "missing_comment_id", message: "--id is required" });
      return;
    }
    const reason = asString(body.reason) ?? "skipped by operator";
    const result = daemon.skipComment(commentId, reason);
    response.status(result.ok === true ? 200 : 409).json(result);
  }));

  router.post("/speak", wrap(async (request, response) => {
    const body = request.body as Record<string, unknown>;
    const text = asString(body.text);
    if (!text) {
      response.status(400).json({ ok: false, error: "missing_text", message: "--text is required" });
      return;
    }
    const commentId = asString(body.comment_id);
    if (commentId && daemon.state.isCommentUsed(commentId)) {
      response
        .status(409)
        .json({ ok: false, error: "comment_already_used", comment_id: commentId });
      return;
    }
    response.json(
      await daemon.speak({
        text,
        direction: asString(body.direction),
        emotion: asString(body.emotion),
        commentId,
      }),
    );
  }));

  router.post("/direct", wrap(async (request, response) => {
    const direction = asString((request.body as Record<string, unknown>).direction);
    if (!direction) {
      response
        .status(400)
        .json({ ok: false, error: "missing_direction", message: "--direction is required" });
      return;
    }
    response.json(await daemon.direct(direction));
  }));

  router.get("/wait", wrap(async (request, response) => {
    const timeoutSec = Number(request.query.timeout ?? 60);
    const event = await daemon.state.waitForEvent(
      (Number.isFinite(timeoutSec) ? Math.max(1, timeoutSec) : 60) * 1000,
    );
    if (event === null) {
      const now = Date.now();
      response.json({
        event: "timeout",
        elapsed_sec: daemon.state.elapsedSec(now),
        queue_remaining_sec: daemon.state.queueRemainingSec(now),
        comments_pending: daemon.state.pendingCount(),
        session_remaining_sec: daemon.state.sessionRemainingSec(now),
      });
      return;
    }
    response.json(event);
  }));

  router.post("/overlay", wrap((request, response) => {
    const body = request.body as Record<string, unknown>;
    if (typeof body.highlight === "string") daemon.overlay.setHighlight(body.highlight);
    if (body.highlight === null) daemon.overlay.setHighlight(null);
    if (typeof body.subtitle === "string") daemon.overlay.setSubtitle(body.subtitle);
    if (body.subtitle === null) daemon.overlay.setSubtitle(null);
    if (typeof body.comments === "boolean") daemon.overlay.setCommentsVisible(body.comments);
    if (typeof body.subtitles === "boolean") {
      daemon.overlay.subtitlesEnabled = body.subtitles;
      if (!body.subtitles) daemon.overlay.setSubtitle(null);
    }
    response.json({ ok: true, overlay: daemon.overlay.snapshot });
  }));

  router.post("/session/restart", wrap(async (request, response) => {
    const reason = asString((request.body as Record<string, unknown>).reason) ?? "manual";
    response.json(await daemon.restartSession(reason, "restart"));
  }));

  // `h3 reset`：見た目が崩れたときに映像を初期画像・default_scene へ戻す。
  // 中身は session restart と同じで、意図（trigger）だけが違う。
  router.post("/reset", wrap(async (request, response) => {
    const reason = asString((request.body as Record<string, unknown>).reason) ?? "visual drift";
    response.json(await daemon.restartSession(reason, "reset"));
  }));

  /**
   * `h3 audio test`：任意の wav を compositor に直接再生させる（SPEC §5.1）。
   *
   * Director セッションを開かずに「TTS wav → WebAudio → MediaRecorder → ffmpeg」
   * の経路と再生時刻の精度だけを確かめるための検証用コマンド。
   */
  router.post("/audio/test", wrap((request, response) => {
    const body = request.body as Record<string, unknown>;
    const wav = asString(body.wav);
    if (!wav) {
      response.status(400).json({ ok: false, error: "missing_wav", message: "--wav is required" });
      return;
    }
    const atMs = Number(body.at_ms);
    const delayMs = Number(body.delay_ms);
    response.json(
      daemon.audioTest(
        wav,
        Number.isFinite(atMs) && atMs > 0 ? atMs : null,
        Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 3000,
      ),
    );
  }));

  // ---------- 送出（SPEC §8） ----------

  router.get("/broadcast", wrap((_request, response) => {
    response.json({ ok: true, broadcast: daemon.broadcaster.status() });
  }));

  router.post("/broadcast/start", wrap(async (_request, response) => {
    const started = await daemon.broadcaster.start();
    response.json({ ok: true, started, broadcast: daemon.broadcaster.status() });
  }));

  router.post("/broadcast/stop", wrap(async (_request, response) => {
    await daemon.broadcaster.stop();
    response.json({ ok: true, broadcast: daemon.broadcaster.status() });
  }));

  router.post("/frame", wrap(async (_request, response) => {
    const dataUrl = await daemon.director.captureFrame();
    response.json({ ok: true, data_url: dataUrl });
  }));

  router.get("/log", wrap((request, response) => {
    const tail = Number(request.query.tail ?? 50);
    response.json({ ok: true, lines: daemon.state.tailLog(Number.isFinite(tail) ? tail : 50) });
  }));

  router.post("/stop", wrap((_request, response) => {
    // TTS サーバーは外部プロセス。デーモンは起動も停止もしない。
    response.json({ ok: true, stopped: daemon.stoppedComponents(), tts: "external" });
    setTimeout(() => void daemon.shutdown(), 50);
  }));

  return router;
}

/**
 * speak / direct が Director に送る prompt メッセージを組み立てる。
 * direction が禁止語に当たっていたら `DirectionBlockedError` を投げて送信させない。
 *
 * `prompt_version` はここでは付けない。セッション内で必ず増やす必要があるので、
 * 採番は `DirectorController.prompt()` が持つ。
 */
export function buildDirectorPrompt(
  daemon: Daemon,
  direction: string | null,
  speech: string | null,
  audioUrl: string | null,
): DirectorPromptRequest {
  assertDirection(direction, daemon.config.direction_blocklist);
  return {
    type: "prompt",
    prompt: buildPrompt({ visual: daemon.character.visual, direction, speech }),
    replan: true,
    ...(audioUrl ? { audio_url: audioUrl, audio_behavior: "queue" as const } : {}),
  };
}
