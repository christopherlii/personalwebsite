/**
 * Overhead beach — water flowing in and out
 * Pure canvas, no external libs. Stylized top-down view.
 */
(function () {
  const canvas = document.getElementById('beach-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let width, height;
  let frame = 0;

  // Colors — match site sunset beach palette
  const SAND = '#f9f4eb';
  const WATER = 'rgba(107, 155, 176, 0.45)';
  const WATER_EDGE = 'rgba(107, 155, 176, 0.6)';
  const FOAM = 'rgba(255, 255, 255, 0.35)';

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.offsetWidth;
    height = canvas.offsetHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
  }

  // Organic wave edge: layered sines for irregular boundary
  function waveY(x, t) {
    return (
      0.2 * height +
      0.15 * height * Math.sin(x * 0.006 + t * 0.4) +
      0.08 * height * Math.sin(x * 0.012 + t * 0.65 + 1) +
      0.05 * height * Math.sin(x * 0.022 + t * 0.9 + 2) +
      0.04 * height * Math.sin(x * 0.035 + t * 0.5 + 3)
    );
  }

  // Tide: slow in/out (water flowing up and down the beach)
  function tideOffset(t) {
    return 0.1 * height * Math.sin(t * 0.12);
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);

    // Sand base
    ctx.fillStyle = SAND;
    ctx.fillRect(0, 0, width, height);

    const t = frame * 0.02;
    const tide = tideOffset(t);

    // Water shape — irregular top edge, fill below
    ctx.beginPath();
    ctx.moveTo(0, height + 10);

    const steps = 120;
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * (width + 20) - 10;
      const y = waveY(x, t) + tide;
      ctx.lineTo(x, y);
    }

    ctx.lineTo(width + 10, height + 10);
    ctx.closePath();

    // Water fill with slight depth gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(107, 155, 176, 0.4)');
    gradient.addColorStop(0.5, 'rgba(107, 155, 176, 0.5)');
    gradient.addColorStop(1, 'rgba(107, 155, 176, 0.35)');
    ctx.fillStyle = gradient;
    ctx.fill();

    // Edge highlight (water meeting sand)
    ctx.beginPath();
    ctx.moveTo(0, waveY(-10, t) + tide);
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * (width + 20) - 10;
      const y = waveY(x, t) + tide;
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = WATER_EDGE;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Foam specks along the edge (optional sparkle)
    ctx.fillStyle = FOAM;
    for (let i = 0; i < 15; i++) {
      const x = (i / 14) * width + Math.sin(t + i) * 20;
      const y = waveY(x, t) + tide + Math.cos(t * 1.2 + i) * 3;
      if (y > 0 && y < height) {
        ctx.beginPath();
        ctx.arc(x, y, 2 + Math.sin(t + i * 0.5) * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    frame++;
    requestAnimationFrame(draw);
  }

  function init() {
    resize();
    draw();
  }

  window.addEventListener('resize', resize);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
