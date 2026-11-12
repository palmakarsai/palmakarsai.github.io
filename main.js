import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';


const clock = new THREE.Clock();
let terrain;
let flagMixer;
let charMixer;
let errorcharMixer;
let noiseOverlay;
let planeMesh;
let plane;
let flagMesh;
let character;
let errorcharacter;
let noiseTurnedOff = false;
let errorCharacterOff = false;
let rawScrollTarget = 0; // accumulates every wheel event immediately, can be noisy
let scrollOffset = 0;    // filtered version — this is what the rest of your code should read
let touchStartY = 0;
let lastProgress = null;
let settleTimer = 0;
let currentSegmentIndex = -1;
let currentChatIndex = -1;
let scrollEnabled = true;
let cameraState = 'waiting'; // 'waiting' -> 'intro' -> 'scroll'

let fogScale = 1;                 // multiplies every fog.far value
const mobileFogScale = 1.7;       // fog distance multiplier on a full portrait phone



window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const skyColor = new THREE.Color(0x90D5FF).lerp(new THREE.Color(0xBE99E0), 0.45);


const scene = new THREE.Scene();
{
  const color = 0x000000;  // black
  const near = 10;
  const far = 100;
  scene.fog = new THREE.Fog(skyColor, 0.1, 22);
}

const gridHelper = new THREE.GridHelper( 100, 100 );
//scene.add( gridHelper );


// convert from three's linear working space to the sRGB values the canvas expects
const skySRGB = skyColor.getRGB(new THREE.Color(), THREE.SRGBColorSpace);
const bgR = Math.round(skySRGB.r * 255);
const bgG = Math.round(skySRGB.g * 255);
const bgB = Math.round(skySRGB.b * 255);

scene.background = skyColor;

const hemiLight = new THREE.HemisphereLight(0xF5BD7F, 0x22A1C7, 1);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xFF8500, 5);
dirLight.position.set(-60, 8, 40);
scene.add(dirLight);

dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
const s = 25; // half-size of the shadow box, make it cover the area the camera sees
dirLight.shadow.camera.left = -s;
dirLight.shadow.camera.right = s;
dirLight.shadow.camera.top = s;
dirLight.shadow.camera.bottom = -s;
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 150; // the light is ~75 units from the origin
dirLight.shadow.bias = -0.0005;
dirLight.shadow.normalBias = 0.05;


function makeSunTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');

  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.00, 'rgba(255, 255, 255, 1)');   // hot white core
  grad.addColorStop(0.02, 'rgba(255, 230, 190, 1)');
  grad.addColorStop(0.20, 'rgba(255, 150, 70, 0.5)');  // orange halo
  grad.addColorStop(1.00, 'rgba(255, 120, 40, 0)');    // fades to nothing
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
  fog: false,         // essential, see below
  toneMapped: false,  // keeps the core bright instead of greying it
}));

// Same direction as the light, but far away
sun.position.copy(dirLight.position).normalize().multiplyScalar(600);
sun.scale.setScalar(500); // bigger number = bigger sun
scene.add(sun);

const camera = new THREE.PerspectiveCamera( 48, window.innerWidth / window.innerHeight, 0.1, 1000 );

const adapter = await navigator.gpu.requestAdapter();

const device = await adapter.requestDevice({
  requiredLimits: {
    maxTextureArrayLayers: Math.min(adapter.limits.maxTextureArrayLayers, 2048),
  },
});

const renderer = new THREE.WebGPURenderer({
  antialias: true,
  device, // pass the pre-configured device
});

await renderer.init();

renderer.domElement.id = 'scene';
//console.log('scene id set', renderer.domElement);

renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

renderer.setPixelRatio( window.devicePixelRatio );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setAnimationLoop( animate );
document.body.appendChild( renderer.domElement );

// Noise texture setup
const noiseCanvas = document.createElement('canvas');
noiseCanvas.width = 2048;
noiseCanvas.height = 2048;
const noiseCtx = noiseCanvas.getContext('2d');


const renderRegion = document.getElementById('renderRegion');
renderRegion.appendChild(noiseCanvas);   // updateNoiseTexture() already draws into it

const _box = new THREE.Box3();
const _corner = new THREE.Vector3();

function getScreenRect(obj, pad = -20) {
  camera.updateMatrixWorld();                 // avoid a one-frame lag
  _box.setFromObject(obj);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    _corner.set(
      i & 1 ? _box.max.x : _box.min.x,
      i & 2 ? _box.max.y : _box.min.y,
      i & 4 ? _box.max.z : _box.min.z
    ).project(camera);

    if (_corner.z > 1) return null;           // behind the camera, so hide the region

    const x = (_corner.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-_corner.y * 0.5 + 0.5) * window.innerHeight;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }

  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  // fully off-screen
  if (maxX < 0 || maxY < 0 || minX > window.innerWidth || minY > window.innerHeight) return null;

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function enableShadows(obj, cast, receive) {
  obj.traverse((c) => {
    if (c.isMesh) { c.castShadow = cast; c.receiveShadow = receive; }
  });
}


/*----------------------------LOADER SETUP - MODELS LOADED ----------------------------------*/

const loader = new GLTFLoader();

loader.load( 'models/Terrain_big.glb', function ( gltf ) {

  terrain = gltf.scene;
  terrain.position.set(0,0,0);
  scene.add(terrain);
  //enableShadows(terrain, true, true);

}, undefined, function ( error ) {

  console.error( error );

} );


loader.load( 'models/Plane.glb', function ( gltf ) {

  plane = gltf.scene;
  plane.position.set(7,2,5.6);
  plane.rotation.set(-0.4, -8, -0.5);
  plane.scale.set(0.8, 0.8, 0.8);
  scene.add(plane);

  plane.traverse((child) => {
    if (child.isMesh){
      planeMesh = child;
    }
  });

  enableShadows(plane, true, false);

}, undefined, function ( error ) {

  console.error( error );

} );


const textureLoader = new THREE.TextureLoader();

const errorMaterial = new THREE.MeshBasicMaterial({
  color: 0xff01ff,
  side: THREE.DoubleSide
});
//const errorTexture = textureLoader.load('models/Flag/ErrorFlag.png');
const hunTexture = textureLoader.load('models/Flag/HungaryFlag.png');

// Match color space to your other textures (usually sRGB for base color maps)
//errorTexture.colorSpace = THREE.SRGBColorSpace;
hunTexture.colorSpace = THREE.SRGBColorSpace;

let fixedMaterial

loader.load('models/Flag/Flag.gltf', function (gltf) {
  const flag = gltf.scene;
  flag.position.set(8.8, 0.65, -3.5);
  flag.rotation.set(0.5,1.8,0);
  flag.scale.set(0.2,0.2,0.2);
  scene.add(flag);
  enableShadows(flag, true, false);
  
  flag.traverse((child) => {
    if (child.isMesh && child.name === 'flagCloth') {
      flagMesh = child;
    }
  });

  fixedMaterial = flagMesh.material;   // the material it loaded with (with hunTexture)
  flagMesh.material = errorMaterial;         // start broken

  // Set up the mixer if the glb has baked animation clips
  if (gltf.animations && gltf.animations.length > 0) {
    flagMixer = new THREE.AnimationMixer(flag);
    const action = flagMixer.clipAction(gltf.animations[0]); // first clip
    action.play();
  }

}, undefined, function (error) {
  console.error(error);
});

loader.load('models/Character.glb', function (gltf) {
  character = gltf.scene;
  character.position.set(0.3,2.6,0.7);
  character.rotation.set(0,-0.5,0);
  character.scale.set(0.8,0.8,0.8);
  scene.add(character);
  character.visible = false;
  enableShadows(character, true, false);

  // Set up the mixer if the glb has baked animation clips
  if (gltf.animations && gltf.animations.length > 0) {
    charMixer = new THREE.AnimationMixer(character);
    const action = charMixer.clipAction(gltf.animations[0]); // first clip
    action.play();
  }

}, undefined, function (error) {
  console.error(error);
});

loader.load('models/CharacterWrong.glb', function (gltf) {
  errorcharacter = gltf.scene;
  errorcharacter.position.set(0.3,2.6,0.7);
  errorcharacter.rotation.set(0,-0.5,0);
  errorcharacter.scale.set(0.8,0.8,0.8);
  scene.add(errorcharacter);
  enableShadows(errorcharacter, true, false);

  // Set up the mixer if the glb has baked animation clips
  if (gltf.animations && gltf.animations.length > 0) {
    errorcharMixer = new THREE.AnimationMixer(errorcharacter);
    const action = errorcharMixer.clipAction(gltf.animations[0]); // first clip
    action.play();
  }

}, undefined, function (error) {
  console.error(error);
});

/* ------------------------------ BUTTON SETUP -------------------------------------------*/

const startBtn = document.getElementById('startBtn');

startBtn.addEventListener('click', () => {
  if (!terrain) return; // model not loaded yet

  startBtn.disabled = true;

  const welcomeBox = document.getElementById('welcomeBox'); 
  welcomeBox.classList.add('started');
  renderer.domElement.classList.add('started');
  

  setTimeout(() => { 
    startExperience();
    unlockScroll();

  }, 500);

});


const textureBtn = document.getElementById('toggleTextureBtn');
// Button wiring
textureBtn.addEventListener('click', () => {
  if (!flagMesh) return; // model not loaded yet
  textureBtn.disabled = true;

  const composeBox = document.getElementById('composeBox1');
  const chatWindow = composeBox.previousElementSibling; // the .chat-window right before it

  const userText = composeBox.querySelector('.user-message').textContent;

  composeBox.classList.add('sent'); // hides it via display:none now

  const userMsg = document.createElement('p');
  userMsg.classList.add('message', 'user');
  userMsg.textContent = userText;
  chatWindow.appendChild(userMsg);

  fixedMaterial.map = hunTexture;
  fixedMaterial.needsUpdate = true;

  setTimeout(() => {
    const adminReply1 = document.createElement('p');
    adminReply1.classList.add('admin-message');
    adminReply1.textContent = "No worries, I'll take a look!";
    chatWindow.appendChild(adminReply1);
  }, 3000);
  

  setTimeout(() => {
    flagMesh.material = (flagMesh.material === errorMaterial) ? fixedMaterial : errorMaterial;
    const adminReply2 = document.createElement('p');
    adminReply2.classList.add('admin-message');
    adminReply2.textContent = "There we go! The texture should be showing up now.";
    chatWindow.appendChild(adminReply2);
    unlockScroll();
  }, 5000);

  
});

const renderBtn = document.getElementById('toggleRenderBtn');

renderBtn.addEventListener('click', () => {
  if (!planeMesh) return; // model not loaded yet
  renderBtn.disabled = true;


  const composeBox = document.getElementById('composeBox2');
  const chatWindow = composeBox.previousElementSibling; // the .chat-window right before it

  const userText = composeBox.querySelector('.user-message').textContent;

  composeBox.classList.add('sent');

  const userMsg = document.createElement('p');
  userMsg.classList.add('message', 'user');
  userMsg.textContent = userText;
  chatWindow.appendChild(userMsg);

  setTimeout(() => {
    const adminReply1 = document.createElement('p');
    adminReply1.classList.add('admin-message');
    adminReply1.textContent = " Let's see what's slowing it down.";
    chatWindow.appendChild(adminReply1);
  }, 2000);

  setTimeout(() => {
    const adminReply2 = document.createElement('p');
    adminReply2.classList.add('admin-message');
    adminReply2.textContent = "I've tweaked the render settings. It should be much faster now!";
    chatWindow.appendChild(adminReply2);

    noiseTurnedOff = !noiseTurnedOff;

     if (noiseTurnedOff) {
    renderRegion.style.display = 'none';
    }
    unlockScroll();
  }, 5000);

  
});

const characterBtn = document.getElementById('toggleCharacterBtn');

characterBtn.addEventListener('click', () => {
  if (!character || !errorcharacter) return; // model not loaded yet

  characterBtn.disabled = true;
  errorCharacterOff = !errorCharacterOff;

  const composeBox = document.getElementById('composeBox3');
  const chatWindow = composeBox.previousElementSibling; // the .chat-window right before it

  const userText = composeBox.querySelector('.user-message').textContent;

  composeBox.classList.add('sent');

  const userMsg = document.createElement('p');
  userMsg.classList.add('message', 'user');
  userMsg.textContent = userText;
  chatWindow.appendChild(userMsg);

  setTimeout(() => {
    const adminReply1 = document.createElement('p');
    adminReply1.classList.add('admin-message');
    adminReply1.textContent = "I always have a moment! Let's see...";
    chatWindow.appendChild(adminReply1);
    unlockScroll();
  }, 1000);


  setTimeout(() => {
    errorcharacter.visible = false;
    character.visible = true;

    const adminReply2 = document.createElement('p');
    adminReply2.classList.add('admin-message');
    adminReply2.textContent = "Turns out a few bones were missing! The right import settings fixed it.";
    chatWindow.appendChild(adminReply2);
    unlockScroll();
  }, 4000);

  
});

/* -------------------------- SCROLL SETUP -------------------------------------------------*/

const MAX_STEP = 100;          // cap per event so a trackpad fling can't run far ahead
const KEY_STEP = 80;          // one arrow press ≈ one wheel notch

const LOCK_RANGE = 40;   // in rawScrollTarget units, see note below
let lockCenter = 0;

function getScrollBounds() {
  return scrollEnabled
    ? [800, 1900]
    : [lockCenter - LOCK_RANGE, lockCenter + LOCK_RANGE];
}

let ignoreInputUntil = 0;

function lockScroll(viewIndex) {
  scrollEnabled = false;
  lockCenter = THREE.MathUtils.mapLinear(viewIndex / (viewSequence.length - 1), 0, 1, 800, 1900);
  rawScrollTarget = THREE.MathUtils.clamp(rawScrollTarget, lockCenter - LOCK_RANGE, lockCenter + LOCK_RANGE);
}

function unlockScroll() {
  scrollEnabled = true;
  rawScrollTarget = scrollOffset;              // continue from where the camera visibly is
  ignoreInputUntil = performance.now() + 400;  // swallow the trackpad inertia tail
}

function applyScroll(delta) {
  if (performance.now() < ignoreInputUntil) return;
  delta = THREE.MathUtils.clamp(delta, -MAX_STEP, MAX_STEP);
  const [min, max] = getScrollBounds();
  rawScrollTarget = THREE.MathUtils.clamp(rawScrollTarget - delta * 0.1, min, max);
}


window.addEventListener('wheel', (event) => {
  event.preventDefault();
  applyScroll(event.deltaY);
}, { passive: false });


const keysDown = { up: false, down: false };
const KEY_SPEED = 250; // rawScrollTarget units per second

window.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea')) return;
  if (event.key === 'ArrowDown') { keysDown.down = true; event.preventDefault(); }
  if (event.key === 'ArrowUp')   { keysDown.up = true;   event.preventDefault(); }
});

window.addEventListener('keyup', (event) => {
  if (event.key === 'ArrowDown') keysDown.down = false;
  if (event.key === 'ArrowUp')   keysDown.up = false;
});

// lose focus while holding a key -> keyup never fires
window.addEventListener('blur', () => { keysDown.up = keysDown.down = false; });

function updateKeyScroll(delta) {
  const dir = (keysDown.up ? 1 : 0) - (keysDown.down ? 1 : 0);
  if (dir === 0) return;
  const [min, max] = getScrollBounds();
  rawScrollTarget = THREE.MathUtils.clamp(rawScrollTarget + dir * KEY_SPEED * delta, min, max);
}

window.addEventListener('touchstart', (event) => {
  touchStartY = event.touches[0].clientY;
}, { passive: false });

window.addEventListener('touchmove', (event) => {
  event.preventDefault();
  const touchY = event.touches[0].clientY;
  const deltaY = touchStartY - touchY;
  touchStartY = touchY;
  if (performance.now() < ignoreInputUntil) return;
  const [min, max] = getScrollBounds();
  rawScrollTarget = THREE.MathUtils.clamp(rawScrollTarget + deltaY, min, max);
}, { passive: false }); 

function toggleScroll(toggle){
  if (toggle === "on" && scrollEnabled == false)
  {
    scrollEnabled = true;
  }
  else if (toggle === "off" && scrollEnabled == true)
  {
    scrollEnabled = false;
  }
}

/*------------------------------ CAMERA SETUP ------------------------------*/

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
  topDown: makeView({ x: 0, y: 15, z: 0 }, { x: -90, y: 0, z: 0 }),
  camstart:  makeView({ x: 20, y: 0.2, z: -13 }, { x: 352.2, y: -250, z: 0 }),
  cam0: makeView({ x: 12, y: 0.8, z: -7 }, { x: 352.2, y: -232.4, z: 0 }),
  cam1: makeView({ x: 11, y: 1, z: -5.6 }, { x: 352.2, y: -252.4, z: 0 }),
  cam2: makeView({ x: 8, y: 2.5, z: -4 }, { x: 0, y: -216, z: -5 }),
  cam3: makeView({x: 4, y: 4.5, z: 0 }, {x: 10, y: -225, z:-10}),
  cam4: makeView({x: 3, y: 6.5, z: 1.5}, {x: 10, y: -225, z:-10}),
};

// ---- mobile framing -------------------------------------------------------
// Snapshot of the desktop views
const desktopViews = {};
for (const [name, v] of Object.entries(cameraViews)) {
  desktopViews[name] = { position: v.position.clone(), quaternion: v.quaternion.clone() };
}

// World units to dolly each view straight back on a full portrait phone.
const mobilePullBack = { camstart: 4, cam0: 3, cam1: 2, cam2: 4, cam3: 2.5, cam4: 3 };

// Optional nudge in camera space {x: right, y: up}. Moving the camera up slides
// the subject DOWN in the frame (toward the story text), and vice versa.
const mobileNudge = {
   cam1: { x: -1, y: 0 },
   cam2: { x: 0, y: 1 },
   cam3: { x: 2, y: 1 },
   cam4: { x: 2, y: 3},
};

const _back = new THREE.Vector3();

function applyViewsForAspect() {
  const aspect = window.innerWidth / window.innerHeight;
  // 0 at aspect >= 1.3 (desktop/landscape) ... 1 at aspect <= 0.5 (tall phone)
  const t = THREE.MathUtils.clamp((1.3 - aspect) / 0.8, 0, 1);
  fogScale = 1 + (mobileFogScale - 1) * t;  

  for (const name in cameraViews) {
    const base = desktopViews[name];
    const view = cameraViews[name];
    const n = mobileNudge[name] ?? { x: 0, y: 0 };
    _back.set(n.x * t, n.y * t, (mobilePullBack[name] ?? 0) * t)
         .applyQuaternion(base.quaternion);          // local +Z = backwards
    view.position.copy(base.position).add(_back);
    view.quaternion.copy(base.quaternion);
  }

  // before the intro starts nothing else moves the camera, so update it here
  if (cameraState === 'waiting') {
    camera.position.copy(cameraViews.camstart.position);
    camera.quaternion.copy(cameraViews.camstart.quaternion);
    scene.fog.far = 22 * fogScale; 
  }
}
applyViewsForAspect();
window.addEventListener('resize', applyViewsForAspect);

camera.position.copy(cameraViews.camstart.position);
camera.quaternion.copy(cameraViews.camstart.quaternion);

// Order matters — this defines the path scroll moves along
//const viewSequence = [cameraViews.cam0, cameraViews.cam1, cameraViews.cam2, cameraViews.cam3, cameraViews.cam4];
const viewSequence = [
  { ...cameraViews.cam0 },
  { ...cameraViews.cam1 },
  { ...cameraViews.cam2 },
  { ...cameraViews.cam3 },
  { ...cameraViews.cam4 },
];

const chatSequence = [
  { ...cameraViews.cam1, revealTimer: 0, revealed: false, firsttime: true },
  { ...cameraViews.cam2, revealTimer: 0, revealed: false, firsttime: true },
  { ...cameraViews.cam3, revealTimer: 0, revealed: false, firsttime: true },
];


function getScaledProgress(progress) {
  const segmentCount = viewSequence.length - 1;
  return progress * segmentCount; // continuous value, e.g. 0 to 2 for 3 views
}

function applyScrollCamera(progress, scaled, scrollEnabled) {
  // progress: 0 to 1 across the whole sequence
  const segmentCount = viewSequence.length - 1;
  const index = Math.min(Math.floor(scaled), segmentCount - 1);
  const localT = scaled - index; // 0–1 within this segment
  const eased = localT * localT * (3 - 2 * localT);

  const from = viewSequence[index];
  const to = viewSequence[index + 1];

  camera.position.lerpVectors(from.position, to.position, eased);
  camera.quaternion.slerpQuaternions(from.quaternion, to.quaternion, eased);
  
  const activeIndex = localT < 0.5 ? index : index + 1;
  updateActiveLabel(activeIndex);
  updateActiveChat(activeIndex);
}

let introT = 0;
const introDuration = 3; // seconds
const fogStart = { far: 22 };
const fogEnd   = { far: 11 };

const easeInOut = (t) => t * t * (3 - 2 * t);

function startExperience() {
  introT = 0;
  cameraState = 'intro';
}

function updateIntro(delta) {
  introT = Math.min(introT + delta / introDuration, 1);
  const eased = easeInOut(introT);

  const from = cameraViews.camstart;
  const to = cameraViews.cam0;

  scene.fog.far = THREE.MathUtils.lerp(fogStart.far, fogEnd.far, eased) * fogScale;
  camera.position.lerpVectors(from.position, to.position, eased);
  camera.quaternion.slerpQuaternions(from.quaternion, to.quaternion, eased);

  if (introT >= 1) {
    cameraState = 'scroll';
  }
}


function animatePlane(scaled){
  if (!planeMesh) return; // model not loaded yet

  const from = new THREE.Vector3(14, -0.4, 6);
  const to = new THREE.Vector3(-15, 4, -1);

  const planeStart = 1; // starts partway through segment 1→2, after leaving cam1 but before reaching cam2
  const planeEnd = 4;     // wherever you want it fully arrived

  const t = THREE.MathUtils.clamp(
    (scaled - planeStart) / (planeEnd - planeStart),
    0, 1
  );
  const eased = t * t * (3 - 2 * t);

  plane.position.lerpVectors(from, to, eased);
}



/* ------------------------- BUCKET RENDER REVEAL ------------------------- */

const renderDuration = 2.5;   // total seconds for all buckets to finish
const bucketsAcross = 10;     // buckets along the longer side of the region
const activeBuckets = 2;      // how many "threads" get brackets at once
const blackHold = 0.01;       // delay after the camera stops before rendering starts
const restNoise = 0;       // residual grain left in finished buckets
const noiseFps = 24;          // grain refresh + bracket redraw rate
const fixDuration = 1.0;      // fade-out time once the problem is "fixed"

let noiseLevel = 1;           // 1 = still "rendering", fades to 0 after the fix
let noiseClock = 0;
let noiseFrozen = false;
noiseCanvas.style.imageRendering = 'auto';

const grainScale = 1;
const maxNoiseSide = 640;

// bucket state
let bucketPx = 32;
let bCols = 0, bRows = 0;
let bucketOrder = [];         // bucket indices, centre first
let bucketAlpha = null;       // Uint8Array, 255 = pending, restNoise*255 = done
let renderedCount = 0;
let bucketClock = 0;

function buildBuckets(w, h) {
  bucketPx = Math.ceil(Math.max(w, h) / bucketsAcross);
  bCols = Math.ceil(w / bucketPx);
  bRows = Math.ceil(h / bucketPx);
  bucketAlpha = new Uint8Array(bCols * bRows);

  const cx = (bCols - 1) / 2;
  const cy = (bRows - 1) / 2;
  bucketOrder = [];
  for (let y = 0; y < bRows; y++) {
    for (let x = 0; x < bCols; x++) {
      const dx = x - cx, dy = y - cy;
      bucketOrder.push({
        i: y * bCols + x,
        d: Math.hypot(dx, dy),
        a: Math.atan2(dy, dx),
      });
    }
  }
  // closest to centre first; angle as tie-break gives the spiral feel
  bucketOrder.sort((p, q) => (p.d - q.d) || (p.a - q.a));
  bucketOrder = bucketOrder.map((b) => b.i);

  resetBuckets();
}

function resetBuckets() {
  if (bucketAlpha) bucketAlpha.fill(255);
  renderedCount = 0;
  bucketClock = 0;
  noiseFrozen = false;
}

function updateNoiseTexture() {
  if (!bucketAlpha) return;
  const w = noiseCanvas.width, h = noiseCanvas.height;
  const imageData = noiseCtx.createImageData(w, h);
  const data = imageData.data;

  for (let by = 0; by < bRows; by++) {
    for (let bx = 0; bx < bCols; bx++) {
      const a = bucketAlpha[by * bCols + bx];
      const x0 = bx * bucketPx, x1 = Math.min(x0 + bucketPx, w);
      const y0 = by * bucketPx, y1 = Math.min(y0 + bucketPx, h);

      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          const t = Math.random();
          data[i]     = 20 + (bgR - 20) * t;
          data[i + 1] = 20 + (bgG - 20) * t;
          data[i + 2] = 20 + (bgB - 20) * t;
          data[i + 3] = a;
        }
      }
    }
  }
  noiseCtx.putImageData(imageData, 0, 0);
  drawBucketBrackets();
}

function drawBucketBrackets() {
  const end = Math.min(renderedCount + activeBuckets, bucketOrder.length);
  const w = noiseCanvas.width, h = noiseCanvas.height;

  noiseCtx.strokeStyle = '#ffffff';
  noiseCtx.lineWidth = 2;
  const len = bucketPx * 0.3;

  for (let k = renderedCount; k < end; k++) {
    const idx = bucketOrder[k];
    const x0 = (idx % bCols) * bucketPx + 1;
    const y0 = Math.floor(idx / bCols) * bucketPx + 1;
    const x1 = Math.min(x0 + bucketPx, w) - 2;
    const y1 = Math.min(y0 + bucketPx, h) - 2;

    noiseCtx.beginPath();
    // top-left
    noiseCtx.moveTo(x0, y0 + len); noiseCtx.lineTo(x0, y0); noiseCtx.lineTo(x0 + len, y0);
    // top-right
    noiseCtx.moveTo(x1 - len, y0); noiseCtx.lineTo(x1, y0); noiseCtx.lineTo(x1, y0 + len);
    // bottom-right
    noiseCtx.moveTo(x1, y1 - len); noiseCtx.lineTo(x1, y1); noiseCtx.lineTo(x1 - len, y1);
    // bottom-left
    noiseCtx.moveTo(x0 + len, y1); noiseCtx.lineTo(x0, y1); noiseCtx.lineTo(x0, y1 - len);
    noiseCtx.stroke();
  }
}

function sizeNoiseCanvas(rect) {
  // snap to steps of 32 so it doesn't resize on every frame while the camera moves
  const snap = (v) => Math.min(maxNoiseSide, Math.max(32, Math.round(v / grainScale / 32) * 32));
  const w = snap(rect.w);
  const h = snap(rect.h);
  if (noiseCanvas.width !== w || noiseCanvas.height !== h || !bucketAlpha) {
    noiseCanvas.width = w;     // resizing clears the canvas
    noiseCanvas.height = h;
    buildBuckets(w, h);        // new grid + reset
    updateNoiseTexture();
  }
}

function updateNoiseReveal(progress, delta) {
  if (!plane) { renderRegion.style.display = 'none'; return; }

  if (noiseTurnedOff) noiseLevel = Math.max(0, noiseLevel - delta / fixDuration);
  if (noiseLevel === 0) { renderRegion.style.display = 'none'; return; }

  const changed = lastProgress === null || Math.abs(progress - lastProgress) > 0.0005;
  lastProgress = progress;
  settleTimer = changed ? 0 : settleTimer + delta;
  if (changed) resetBuckets();   // camera moved -> the "render" restarts

  const rect = getScreenRect(plane);
  if (!rect) { renderRegion.style.display = 'none'; return; }

  const offsetX = 0;
  const offsetY = 20;
  renderRegion.style.display = 'block';
  renderRegion.style.transform = `translate(${rect.x + offsetX}px, ${rect.y + offsetY}px)`;
  renderRegion.style.width  = rect.w + 'px';
  renderRegion.style.height = rect.h + 'px';

  sizeNoiseCanvas(rect);

  if (settleTimer < blackHold) {
    noiseCanvas.style.opacity = 0;          // nothing rendered yet
    renderRegion.style.opacity = noiseLevel;
    return;
  }

  noiseCanvas.style.opacity = 1;
  renderRegion.style.opacity = noiseLevel;

  const total = bucketOrder.length;
  let advanced = false;

  if (renderedCount < total) {
    bucketClock += delta;
    const interval = renderDuration / total;
    while (bucketClock >= interval && renderedCount < total) {
      bucketClock -= interval;
      bucketAlpha[bucketOrder[renderedCount]] = Math.round(restNoise * 255);
      renderedCount++;
      advanced = true;
    }

    noiseClock += delta;
    if (advanced || noiseClock > 1 / noiseFps) {
      noiseClock = 0;
      updateNoiseTexture();   // grain flicker + brackets follow the active buckets
    }
  } else if (!noiseFrozen) {
    updateNoiseTexture();     // final frame, no brackets left
    noiseFrozen = true;
  }
}

function updateActiveLabel(index) {
  if (index === currentSegmentIndex) return;
  currentSegmentIndex = index;

  document.querySelectorAll('.view-text').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.view) === index);
  });
}

function updateActiveChat(index) {
  if (index === currentChatIndex) return;
  currentChatIndex = index;

  

  document.querySelectorAll('.view-chat').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.view) === index);
  });

}

const revealDelay = 1.5;
const arrivalThreshold = 0.2; // how close `scaled` must be to a view's index to count as "arrived"
const leaveThreshold = 0.25; // how long the chat bubble stayes while scrolling


function updateChatReveal(scaled, delta) {
  chatSequence.forEach((view, i) => {
    const distance = Math.abs(scaled - i - 1);
    const isNearEnoughToStart = distance < arrivalThreshold;
    const isFarEnoughToLeave = distance > leaveThreshold;

    if (view.revealed) {
      if (isFarEnoughToLeave) {
        view.revealed = false;
        view.revealTimer = 0;
      }
    } else if (isNearEnoughToStart) {
      if (view.firsttime && scrollEnabled) {
        lockScroll(i + 1);          // only when actually arrived
      }
      view.revealTimer += delta;
      if (view.revealTimer >= revealDelay) {
        view.revealed = true;
        view.firsttime = false;
      }
    }

    const chatEl = document.querySelector(`.view-chat[data-view="${i + 1}"]`);
    if (chatEl) chatEl.classList.toggle('revealed', view.revealed);
  });
}

function updateViewTextFade(scaled) {

  const plateauWidth = 0.25; // distance from center where opacity stays at 1 (full visibility zone)
  const fadeWidth = 0.25;    // additional distance beyond the plateau over which it fades to 0

  viewSequence.forEach((view, i) => {
    const distance = Math.abs(scaled - i);

    let opacity;
    if (distance <= plateauWidth) {
      opacity = 1; // fully visible, flat top
    } else if (distance <= plateauWidth + fadeWidth) {
      const t = (distance - plateauWidth) / fadeWidth; // 0 at start of fade, 1 at end
      opacity = 1 - t;
    } else {
      opacity = 0; // fully faded, dead zone
    }

    const el = document.querySelector(`.view-text[data-view="${i}"]`);
    if (!el) return;

    el.style.opacity = opacity;
    el.style.filter = `blur(${(1 - opacity) * 8}px)`; // 8px max blur when fully faded
  });
}

function updateScrollFog(scaled) {
  const t = THREE.MathUtils.clamp(scaled - 3, 0, 1); // 0 at cam3, 1 at cam4
  const eased = t * t * (3 - 2 * t);
  scene.fog.far = THREE.MathUtils.lerp(fogEnd.far, 30, eased) * fogScale;
}




function animate(time) {
  const delta = clock.getDelta();

  if (flagMixer) flagMixer.update(delta);
  if (charMixer && character.visible) charMixer.update(delta);
  if (errorcharMixer && errorcharacter.visible) errorcharMixer.update(delta);

  if (cameraState === 'waiting') {
    renderer.render(scene, camera);
    return;
  }

  if (cameraState === 'intro') {
    updateIntro(delta);
    renderer.render(scene, camera);
    return;
  }


  // cameraState === 'scroll': your existing logic

  //scrollEnabled = true;
  updateKeyScroll(delta);
  // low-pass filter scrollOffset itself, before it's used for ANYTHING
  const smoothing = 1 - Math.exp(-6 * delta); // 6 ≈ similar feel to your 0.1 at 60fps
  scrollOffset = THREE.MathUtils.lerp(scrollOffset, rawScrollTarget, smoothing);

  const progress = THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(scrollOffset, 800, 1900, 0, 1), 0, 1);
 

  const scaled = getScaledProgress(progress)

  applyScrollCamera(progress, scaled);
  updateScrollFog(scaled);
  animatePlane(scaled);
  updateNoiseReveal(progress, delta);
  updateViewTextFade(scaled);
  updateChatReveal(scaled, delta);

  renderer.render(scene, camera);
  
  

}