import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/*
  Background version of scene.js for every page except the landing page.
  - draws into <canvas id="bg"> that is already in the page
  - fixed camera with a tiny slow drift (or fully still if the visitor prefers reduced motion)
  - the view is chosen per page:  <body data-bg-view="cam2">
*/

const canvas = document.getElementById('bg');
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------- camera views (same as scene.js) ---------------------------- */
function makeView(position, rotationDeg) {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rotationDeg.x),
    THREE.MathUtils.degToRad(rotationDeg.y),
    THREE.MathUtils.degToRad(rotationDeg.z)
  );
  return {
    position: new THREE.Vector3(position.x, position.y, position.z),
    quaternion: new THREE.Quaternion().setFromEuler(euler),
  };
}

const cameraViews = {
  camstart: makeView({ x: 20, y: 0.2, z: -13 }, { x: 352.2, y: -250, z: 0 }),
  cam0: makeView({ x: 12, y: 0.8, z: -7 }, { x: 352.2, y: -232.4, z: 0 }),
  cam1: makeView({ x: 11, y: 1, z: -5.6 }, { x: 352.2, y: -252.4, z: 0 }),
  cam2: makeView({ x: 8, y: 2.5, z: -4 }, { x: 0, y: -216, z: -5 }),
  cam3: makeView({ x: 4, y: 4.5, z: 0 }, { x: 10, y: -225, z: -10 }),
  cam4: makeView({ x: 3, y: 6.5, z: 1.5 }, { x: 10, y: -225, z: -10 }),
};

const viewName = document.body.dataset.bgView;
const view = cameraViews[viewName] || cameraViews.cam3;   // default view for pages that pick none

/* ---------------------------- renderer ---------------------------- */
async function createRenderer() {
  let device;
  try {
    // same device setup as scene.js, but a missing GPU adapter no longer crashes the page
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) {
      device = await adapter.requestDevice({
        requiredLimits: {
          maxTextureArrayLayers: Math.min(adapter.limits.maxTextureArrayLayers, 2048),
        },
      });
    }
  } catch (e) { /* fall back to the default backend */ }

  const r = new THREE.WebGPURenderer({ canvas, antialias: true, ...(device ? { device } : {}) });
  await r.init();                       // falls back to WebGL2 by itself if WebGPU is unavailable
  return r;
}

async function start() {
  const renderer = await createRenderer();

  /* ---------------------------- scene (same look as scene.js) ---------------------------- */
  const skyColor = new THREE.Color(0x90D5FF).lerp(new THREE.Color(0xBE99E0), 0.45);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(skyColor, 0.1, 22);
  scene.background = skyColor;

  scene.add(new THREE.HemisphereLight(0xF5BD7F, 0x22A1C7, 1));

  const dirLight = new THREE.DirectionalLight(0xFF8500, 5);
  dirLight.position.set(-60, 8, 40);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  const s = 25;
  dirLight.shadow.camera.left = -s;
  dirLight.shadow.camera.right = s;
  dirLight.shadow.camera.top = s;
  dirLight.shadow.camera.bottom = -s;
  dirLight.shadow.camera.near = 1;
  dirLight.shadow.camera.far = 150;
  dirLight.shadow.bias = -0.0005;
  dirLight.shadow.normalBias = 0.05;
  scene.add(dirLight);

  function makeSunTexture() {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0.00, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.02, 'rgba(255, 230, 190, 1)');
    grad.addColorStop(0.20, 'rgba(255, 150, 70, 0.5)');
    grad.addColorStop(1.00, 'rgba(255, 120, 40, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  const sun = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeSunTexture(),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  }));
  sun.position.copy(dirLight.position).normalize().multiplyScalar(600);
  sun.scale.setScalar(500);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.copy(view.position);
  camera.quaternion.copy(view.quaternion);

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;          // light and terrain never move, so render shadows once
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));   // a background doesn't need full resolution
  renderer.setSize(window.innerWidth, window.innerHeight, false);   // false = leave the CSS size alone

  /* ---------------------------- terrain ---------------------------- */
  new GLTFLoader().load('/models/Terrain_big.glb', (gltf) => {
    scene.add(gltf.scene);
    renderer.shadowMap.needsUpdate = true;
  }, undefined, (err) => console.error(err));

  /* ---------------------------- loop ---------------------------- */
  let frames = 0;
  function animate(time) {
    if (!still) {
      const t = time * 0.001;                      // slow sway around the chosen view
      camera.position.set(
        view.position.x + Math.sin(t * 0.15) * 0.25,
        view.position.y + Math.sin(t * 0.11) * 0.08,
        view.position.z + Math.cos(t * 0.13) * 0.25
      );
    }
    renderer.render(scene, camera);

    // reduced motion: draw a few frames (the model streams in), then stop completely
    if (still && ++frames > 120) renderer.setAnimationLoop(null);
  }
  renderer.setAnimationLoop(animate);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    if (still) renderer.render(scene, camera);
  });
}

start().catch((e) => {
  console.warn('Background scene unavailable, using the plain background.', e);
  canvas.style.display = 'none';
});