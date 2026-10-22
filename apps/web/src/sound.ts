// 알림음: 파일 없이 Web Audio로 만든다.
// 브라우저는 사용자가 한 번 누르기 전에는 소리를 막으므로, 첫 클릭·키 입력 때 AudioContext를 깨워 둔다.
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try { ctx ??= new AudioContext(); } catch { return null; }
  return ctx;
}
const unlock = () => { void audio()?.resume().catch(() => {}); };
addEventListener("pointerdown", unlock, { once: true });
addEventListener("keydown", unlock, { once: true });

/** 귓속말 "띠링": 높은 음 두 개가 짧게 이어진다 */
export function playWhisperDing() {
  const c = audio();
  if (!c || c.state !== "running") return;
  const t0 = c.currentTime;
  for (const [i, freq] of [1318.5, 1760].entries()) { // E6 → A6
    const t = t0 + i * 0.12, osc = c.createOscillator(), gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  }
}
