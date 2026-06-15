// Particle-field background for the Constitutional DAO UI (Three.js).
//
// A deep 3D field of glowing particles drifting on a gentle flow, in the brand
// palette (purple / indigo / gold). Motion follows the 3d-spatial principles:
// eased drift (slow-in/out), arcing flow paths, depth/parallax staging toward
// the cursor, 60fps. Falls back silently to the CSS backdrop if WebGL / the CDN
// are unavailable. Respects prefers-reduced-motion.

const THREE_URL = "https://esm.sh/three@0.160.0";

function glowTexture(THREE) {
  const s = 64, c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.3, "rgba(220,210,255,0.85)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

async function start() {
  const canvas = document.getElementById("bg3d");
  if (!canvas) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let THREE;
  try { THREE = await import(THREE_URL); }
  catch (e) { console.warn("[bg] three.js failed to load; CSS backdrop stays", e); return; }

  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); }
  catch (e) { console.warn("[bg] WebGL unavailable; CSS backdrop stays", e); return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0f0f23, 0.0085);
  const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 400);
  camera.position.set(0, 0, 70);

  build(THREE, renderer, scene, camera, reduce);
}

function build(THREE, renderer, scene, camera, reduce) {
  const COUNT = 2600;
  const SPREAD = 130;
  const pos = new Float32Array(COUNT * 3);
  const col = new Float32Array(COUNT * 3);
  const seed = new Float32Array(COUNT); // per-particle phase for organic motion

  const palette = [
    new THREE.Color(0x8b5cf6), // purple
    new THREE.Color(0x6366f1), // indigo
    new THREE.Color(0xa78bfa), // light purple
    new THREE.Color(0xfbbf24), // gold (rare accent)
  ];

  for (let i = 0; i < COUNT; i++) {
    pos[i * 3] = (Math.random() - 0.5) * SPREAD;
    pos[i * 3 + 1] = (Math.random() - 0.5) * SPREAD * 0.7;
    pos[i * 3 + 2] = (Math.random() - 0.5) * SPREAD;
    seed[i] = Math.random() * Math.PI * 2;
    // gold is rare so it reads as an accent, not noise
    const c = palette[Math.random() < 0.08 ? 3 : Math.floor(Math.random() * 3)];
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));

  const mat = new THREE.PointsMaterial({
    size: 1.5,
    map: glowTexture(THREE),
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geo, mat);
  scene.add(points);

  // a second, sparse far layer for depth parallax
  const farGeo = geo.clone();
  const far = new THREE.Points(farGeo, mat.clone());
  far.material.opacity = 0.35;
  far.scale.set(2.2, 2.2, 2.2);
  scene.add(far);

  animate(THREE, renderer, scene, camera, points, far, pos, seed, COUNT, reduce);
}

function animate(THREE, renderer, scene, camera, points, far, basePos, seed, COUNT, reduce) {
  const attr = points.geometry.getAttribute("position");
  const arr = attr.array;

  // eased mouse-parallax target (staging / secondary action)
  const target = { x: 0, y: 0 };
  addEventListener("pointermove", (e) => {
    target.x = (e.clientX / innerWidth - 0.5) * 2;
    target.y = (e.clientY / innerHeight - 0.5) * 2;
  });

  function resize() {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  addEventListener("resize", resize);
  resize();

  const clock = new THREE.Clock();
  function frame() {
    const t = clock.getElapsedTime();

    // gentle flow-field drift: each particle follows an arc (sin/cos) around
    // its origin — slow-in/out via low-frequency trig, never linear.
    for (let i = 0; i < COUNT; i++) {
      const i3 = i * 3;
      const s = seed[i];
      arr[i3]     = basePos[i3]     + Math.sin(t * 0.15 + s) * 2.4;
      arr[i3 + 1] = basePos[i3 + 1] + Math.cos(t * 0.12 + s * 1.3) * 2.0;
      arr[i3 + 2] = basePos[i3 + 2] + Math.sin(t * 0.10 + s * 0.7) * 2.4;
    }
    attr.needsUpdate = true;

    points.rotation.y = t * 0.025;
    far.rotation.y = -t * 0.012;

    // ease camera toward cursor for depth parallax
    camera.position.x += (target.x * 12 - camera.position.x) * 0.03;
    camera.position.y += (-target.y * 8 - camera.position.y) * 0.03;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
    if (!reduce) requestAnimationFrame(frame);
  }
  if (reduce) renderer.render(scene, camera);
  else requestAnimationFrame(frame);
}

start();
