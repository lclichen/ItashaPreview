import { state, frameSrc, FRAMES, markDirty, ORTHO_FRAME_1BASED, VIEW_ORDER, setRestored } from './state';
import { initCanvasUI } from './canvasui';
import { initUI, startAutoPlay, toast, refreshLayersUI } from './ui';
import { startLoop } from './render';
import { loadAll } from './store';

async function restoreCache(): Promise<void> {
  try {
    const data = await loadAll();
    let count = 0;
    for (const vk of VIEW_ORDER) {
      if (data[vk].layers.length > 0) {
        state.views[vk].layers = data[vk].layers;
        count += data[vk].layers.length;
      }
      if (data[vk].mask) {
        state.views[vk].mask = data[vk].mask;
        state.views[vk].maskTouched = true;
      }
    }
    if (count > 0) {
      setRestored();
      refreshLayersUI();
      toast(`已恢复 ${count} 个缓存图层`);
    }
    setRestored();
  } catch {
    /* cache unavailable */
  }
}

async function loadFrames(): Promise<void> {
  let done = 0;
  await Promise.all(
    Array.from({ length: FRAMES }, async (_, i) => {
      const img = new Image();
      img.src = frameSrc(i);
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
      });
      state.frames[i] = img.complete && img.naturalWidth > 0 ? img : null;
      done++;
      if (done === FRAMES) state.framesLoaded = true;
    }),
  );
  const missing = state.frames.filter((f) => f === null).length;
  if (missing > 0) toast(`警告：${missing} 帧图片加载失败`, true);
  markDirty();
}

async function main(): Promise<void> {
  initUI();
  initCanvasUI();
  startLoop();
  startAutoPlay();
  await restoreCache();
  await loadFrames();
  const first = VIEW_ORDER.find((vk) => state.frames[ORTHO_FRAME_1BASED[vk] - 1]) ?? 'front';
  state.currentView = first;
  state.orbitFrame = ORTHO_FRAME_1BASED[first] - 1;
  (document.getElementById('orbitSlider') as HTMLInputElement).value = String(state.orbitFrame);
  markDirty();
}

main();
