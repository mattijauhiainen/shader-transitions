const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const CELL = 6;
const GAP = 1;
const PITCH = CELL + GAP;
const DURATION = 2000;
const PAUSE = 1500;

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function animateTo(duration: number, fn: (t: number) => void) {
  return new Promise<void>(resolve => {
    const start = performance.now();
    function frame() {
      const t = easeInOut(Math.min((performance.now() - start) / duration, 1));
      fn(t);
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

type Cell = { r: number; g: number; b: number; radius: number };
type FrameData = { cells: Cell[]; cols: number; rows: number; bg: [number, number, number] };

function computeFrame(img: HTMLImageElement): FrameData {
  const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
  const w = img.width * scale, h = img.height * scale;
  const x = (canvas.width - w) / 2, y = (canvas.height - h) / 2;

  const offscreen = new OffscreenCanvas(canvas.width, canvas.height);
  const offCtx = offscreen.getContext("2d")!;
  offCtx.drawImage(img, x, y, w, h);
  const { data } = offCtx.getImageData(0, 0, canvas.width, canvas.height);

  const cols = Math.ceil(canvas.width / PITCH);
  const rows = Math.ceil(canvas.height / PITCH);
  const lumas: number[] = [];
  const cells: Cell[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const startX = col * PITCH;
      const startY = row * PITCH;
      const cellW = Math.min(CELL, canvas.width - startX);
      const cellH = Math.min(CELL, canvas.height - startY);
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < cellH; dy++) {
        for (let dx = 0; dx < cellW; dx++) {
          const i = ((startY + dy) * canvas.width + (startX + dx)) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2];
        }
      }
      const n = cellW * cellH;
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
      lumas.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
      cells.push({ r, g, b, radius: 0 });
    }
  }

  const minLuma = Math.min(...lumas);
  const maxLuma = Math.max(...lumas);
  cells.forEach((cell, i) => {
    cell.radius = Math.sqrt((lumas[i] - minLuma) / (maxLuma - minLuma)) * (CELL / 2);
  });

  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (let i = 0; i < data.length; i += 16) {
    sumR += data[i]; sumG += data[i + 1]; sumB += data[i + 2]; count++;
  }

  return {
    cells, cols, rows,
    bg: [Math.round(sumR / count * 0.25), Math.round(sumG / count * 0.25), Math.round(sumB / count * 0.25)],
  };
}

function draw(from: FrameData, to: FrameData, t: number) {
  const r = Math.round(from.bg[0] + (to.bg[0] - from.bg[0]) * t);
  const g = Math.round(from.bg[1] + (to.bg[1] - from.bg[1]) * t);
  const b = Math.round(from.bg[2] + (to.bg[2] - from.bg[2]) * t);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const [frame, scale] of [[from, 1 - t], [to, t]] as [FrameData, number][]) {
    const { cells, cols, rows } = frame;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const { r, g, b, radius } = cells[row * cols + col];
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.arc(col * PITCH + CELL / 2, row * PITCH + CELL / 2, radius * scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

async function runSlideshow(paths: string[]) {
  let frame = computeFrame(await loadImage(paths[0]));

  for (let i = 0; ; i = (i + 1) % paths.length) {
    const nextFramePromise = loadImage(paths[(i + 1) % paths.length]).then(computeFrame);
    draw(frame, frame, 0);
    await sleep(PAUSE);
    const next = await nextFramePromise;
    await animateTo(DURATION, t => draw(frame, next, t));
    frame = next;
  }
}

const paths: string[] = await fetch("/images").then(r => r.json());
runSlideshow(paths);
