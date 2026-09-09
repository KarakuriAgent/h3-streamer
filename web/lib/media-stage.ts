/**
 * Director から届いたトラックを 1 本の MediaStream にまとめ、`<video>` に流す。
 *
 * 送出は自前合成（SPEC §8-B）にする予定なので、ここは「合成の入力」を持つ層として
 * 独立させてある。compositor ページは同じ MediaStage を使い、
 * `stream` / `element` を canvas に描いて `canvas.captureStream()` → MediaRecorder →
 * WebSocket でデーモンへ送る、という形で上に載せられる。
 */
export class MediaStage {
  readonly stream = new MediaStream();

  constructor(readonly element: HTMLVideoElement) {
    element.srcObject = this.stream;
  }

  /** 解像度。トラックが来る前は 0 になるので、合成側はフォールバックを持つこと。 */
  get width(): number {
    return this.element.videoWidth;
  }

  get height(): number {
    return this.element.videoHeight;
  }

  addTracks(incoming: MediaStream): string[] {
    const kinds: string[] = [];
    for (const track of incoming.getTracks()) {
      this.stream.addTrack(track);
      kinds.push(track.kind);
    }
    this.element.srcObject = this.stream;
    return kinds;
  }

  clear(): void {
    for (const track of this.stream.getTracks()) this.stream.removeTrack(track);
  }

  play(): Promise<void> {
    return this.element.play();
  }

  /** 現在フレームを PNG の data URL で返す（`h3 frame`）。 */
  captureFrame(fallbackWidth = 1280, fallbackHeight = 720): string {
    const canvas = document.createElement("canvas");
    canvas.width = this.width || fallbackWidth;
    canvas.height = this.height || fallbackHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2d context unavailable");
    context.drawImage(this.element, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  }
}
