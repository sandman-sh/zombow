import * as THREE from 'three/webgpu'
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'
import Stats from 'stats-gl'
import {
  Fn, uniform, float, vec3, positionWorld,
  smoothstep, mix, mx_noise_float, time,
} from 'three/tsl'

const loaderStatus = document.getElementById('loader-status')
const loaderBar = document.getElementById('loader-bar')

function setLoading(text, pct) {
  if (loaderStatus) loaderStatus.textContent = text
  if (loaderBar) loaderBar.style.width = pct + '%'
}

setLoading('Preparing the apocalypse…', 10)

const GROUND_SIZE = 400
const GROUND_SEGMENTS = 200
const GROUND_Y_OFFSET = 0.0
const GROUND_SNAP = 8

const scene = new THREE.Scene()
scene.background = new THREE.Color('#87ceeb')
scene.fog = new THREE.Fog('#87ceeb', 80, 250)

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500)
camera.position.set(0, 5, 6)

// ─── Audio System ─────────────────────────────────────────────────────────
const audioListener = new THREE.AudioListener();
camera.add(audioListener);
const audioLoader = new THREE.AudioLoader();

const sounds = {
  bgm: new THREE.Audio(audioListener),
  run: new THREE.Audio(audioListener),
  backward: new THREE.Audio(audioListener),
  jump: new THREE.Audio(audioListener),
  shoot: new THREE.Audio(audioListener)
};
let zombieTerrorBuffer = null;

audioLoader.load('/background_music.dat', (b) => { sounds.bgm.setBuffer(b); sounds.bgm.setLoop(true); sounds.bgm.setVolume(0.4); if (gameStarted && !sounds.bgm.isPlaying) sounds.bgm.play(); });
audioLoader.load('/running.dat', (b) => { sounds.run.setBuffer(b); sounds.run.setLoop(true); sounds.run.setVolume(0.8); });
audioLoader.load('/backward_walk.dat', (b) => { sounds.backward.setBuffer(b); sounds.backward.setLoop(true); sounds.backward.setVolume(0.8); });
audioLoader.load('/jump.dat', (b) => { sounds.jump.setBuffer(b); sounds.jump.setVolume(0.6); });
audioLoader.load('/arrow_shoot.dat', (b) => { sounds.shoot.setBuffer(b); sounds.shoot.setVolume(0.8); });
audioLoader.load('/zombie_terror.dat', (b) => { zombieTerrorBuffer = b; });
// ──────────────────────────────────────────────────────────────────────────

const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
document.body.appendChild(renderer.domElement)
await renderer.init()

const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/')
const gltfLoader = new GLTFLoader()
gltfLoader.setDRACOLoader(dracoLoader)

const loadedTrees = []
const treeGeometries = new Set()
const treeFiles = [
  'banana_tree_low_poly.glb',
  'low_poly_dead_tree.glb',
  'low_poly_palm_tree.glb',
  'low_poly_tree.glb'
]

setLoading('Loading trees…', 20)

for (let i = 0; i < treeFiles.length; i++) {
  try {
    const model = await gltfLoader.loadAsync('/' + treeFiles[i])
    const tScene = model.scene
    
    const box = new THREE.Box3().setFromObject(tScene)
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    if (maxDim > 0) {
      // Normalize trees so their raw height = 1 unit (scaling done per-instance)
      const scale = 1 / maxDim
      tScene.scale.setScalar(scale)
    }

    tScene.traverse(c => {
      if (c.isMesh) {
        c.castShadow = true
        c.receiveShadow = true
        treeGeometries.add(c.geometry)
        if (c.material) c.material.needsUpdate = true
      }
    })
    
    const group = new THREE.Group()
    group.add(tScene)
    loadedTrees.push(group)
  } catch (e) {
    console.error('Failed to load tree:', treeFiles[i], e)
  }
  setLoading(`Planting forest… ${Math.round(((i + 1) / treeFiles.length) * 100)}%`, 20 + Math.round(((i + 1) / treeFiles.length) * 20))
}

let mainCharacter = null;
let characterMixer = null;
const characterActions = {};
let currentAction = 'idle';
let isShooting = false;
let isDead = false;
let isJumping = false;
let jumpVelocity = 0;
let jumpYOffset = 0;
const JUMP_FORCE = 7.0;
const GRAVITY = -18.0;
const CHARACTER_HEIGHT = 2.4;
const TREE_COLLISION_RADIUS = 0.8;
const CHARACTER_RADIUS = 0.4;
const treeColliders = [];

// Player health
let playerHealth = 100;
const PLAYER_MAX_HEALTH = 100;
let lastDamageTime = 0;

// Third-person camera — centered behind character
const CAM_DISTANCE = 6;
const CAM_HEIGHT = 2.0;
const CAM_SMOOTHING = 10;
let camYaw = Math.PI;
let camPitch = -0.05;

// ─── Zombie System ────────────────────────────────────────────────────────
const ZOMBIE_HEIGHT = 2.2;
const ZOMBIE_SPEED = 1.8;
const ZOMBIE_ATTACK_RANGE = 2.5;
const ZOMBIE_DETECT_RANGE = 40;
const ZOMBIE_DAMAGE = 15;
const ZOMBIE_ATTACK_COOLDOWN = 1.5;
const ZOMBIE_HEALTH = 2; // arrows to kill
const zombies = [];
let zombieTemplates = [];
let killCount = 0;
let currentWave = 1;
let zombiesSpawnedThisWave = 0;
let waveZombieCount = 5;
let waveSpawnTimer = 0;
let waveCompleted = false;
let gameStarted = false;

// Arrow projectile system
const arrows = [];
const ARROW_SPEED = 120; // Increased speed for laser-like straight aim
const ARROW_LIFETIME = 3;
let arrowModelTemplate = null;

// The arrow.glb will be loaded dynamically

const ACTION_MAP = { idle: 'idle', run: 'run', backward: 'backward', shoot: 'shoot', dead: 'dead', jump: 'jump' };
const USED_CLIPS = new Set(Object.values(ACTION_MAP));

// Weight-based animation system — all used actions run simultaneously,
// controlled purely by weight. No reset() means no restart glitch.
function playAnim(name) {
  if (currentAction === name) return;
  const clipName = ACTION_MAP[name];
  const next = characterActions[clipName];
  if (!next) return;

  // Fade out ALL actions, then fade in the target
  for (const key of USED_CLIPS) {
    const act = characterActions[key];
    if (act && key !== clipName) {
      act.fadeOut(0.25);
    }
  }

  // One-shot animations (shoot, dead, jump) need reset to replay from start
  if (name === 'dead' || name === 'shoot' || name === 'jump') {
    next.reset();
    next.setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true;
  }

  next.enabled = true;
  next.setEffectiveTimeScale(1);
  next.setEffectiveWeight(1);
  next.fadeIn(0.25);
  next.play();
  currentAction = name;
}

const stats = new Stats({ trackGPU: true })
document.body.appendChild(stats.dom)
stats.dom.style.display = 'none'
stats.init(renderer)

const perlin = new ImprovedNoise()
const landscapeSettings = { frequency: 0.004, amplitude: 14 }

function getLandscapeHeight(x, z) {
  const s = landscapeSettings.frequency
  const a = landscapeSettings.amplitude
  let h = 0
  h += perlin.noise(x * s, 0, z * s) * a
  h += perlin.noise(x * s * 2, 1, z * s * 2) * a * 0.5
  h += perlin.noise(x * s * 4, 2, z * s * 4) * a * 0.25
  return h
}
// getGroundHeight is defined later (line ~1166) with multi-sample terrain smoothing

setLoading('Loading archer…', 45)
try {
  const model = await gltfLoader.loadAsync('/main.glb')
  mainCharacter = model.scene
  mainCharacter.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true } })
  const charBox = new THREE.Box3().setFromObject(mainCharacter)
  const charH = Math.max(charBox.getSize(new THREE.Vector3()).y, 0.01)
  mainCharacter.scale.setScalar(CHARACTER_HEIGHT / charH)
  const scaledBox = new THREE.Box3().setFromObject(mainCharacter)
  // Recenter the model horizontally so the visual center matches the Group origin.
  // This is CRITICAL — without it, rotation.y causes the character to orbit instead of spin in place.
  // Only shift X/Z. Keep Y untouched (footOffset handles vertical placement).
  const center = new THREE.Vector3()
  scaledBox.getCenter(center)
  mainCharacter.children.forEach(child => {
    child.position.x -= center.x
    child.position.z -= center.z
  })
  
  mainCharacter.userData.footOffset = -scaledBox.min.y
  mainCharacter.position.set(0, getLandscapeHeight(0, 0) + GROUND_Y_OFFSET + mainCharacter.userData.footOffset, 0)
  scene.add(mainCharacter)
  characterMixer = new THREE.AnimationMixer(mainCharacter)
  model.animations.forEach(clip => { characterActions[clip.name] = characterMixer.clipAction(clip) })


  // Stop ALL unused clips so they don't interfere
  for (const [name, action] of Object.entries(characterActions)) {
    if (!USED_CLIPS.has(name)) {
      action.stop();
      action.enabled = false;
    }
  }

  // Pre-start looping anims at weight 0 so they're always running in background
  // This means switching to them never needs reset() — just fade weight up
  const idleAct = characterActions['idle'];
  const runAct = characterActions['run'];
  if (runAct) {
    runAct.setLoop(THREE.LoopRepeat, Infinity);
    runAct.setEffectiveWeight(0);
    runAct.play();
  }
  const backwardAct = characterActions['backward'];
  if (backwardAct) {
    backwardAct.setLoop(THREE.LoopRepeat, Infinity);
    backwardAct.setEffectiveWeight(0);
    backwardAct.play();
  }
  if (idleAct) {
    idleAct.setLoop(THREE.LoopRepeat, Infinity);
    idleAct.setEffectiveWeight(1);
    idleAct.play();
  }

  // When one-shot animations finish, return to idle/run
  characterMixer.addEventListener('finished', (e) => {
    const clipName = e.action.getClip().name;
    if (clipName === 'shoot') {
      isShooting = false;
      currentAction = '__done__';
      const moving = keys.KeyW;
      playAnim(moving ? 'run' : 'idle');
    } else if (clipName === 'jump' && !isJumping) {
      currentAction = '__done__';
      const moving = keys.KeyW;
      playAnim(moving ? 'run' : 'idle');
    }
  });
} catch (e) { console.error('Failed to load main.glb', e) }

// ─── Load Zombie Templates ────────────────────────────────────────────────
setLoading('Spawning zombies…', 55)
try {
  const zombieFiles = ['zombie1.glb'];
  for (let zi = 0; zi < zombieFiles.length; zi++) {
    const zModel = await gltfLoader.loadAsync('/' + zombieFiles[zi]);
    const zScene = zModel.scene;
    zScene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true } });
    // Scale to ZOMBIE_HEIGHT
    const zBox = new THREE.Box3().setFromObject(zScene);
    const zH = Math.max(zBox.getSize(new THREE.Vector3()).y, 0.01);
    zScene.scale.setScalar(ZOMBIE_HEIGHT / zH);
    zScene.updateMatrixWorld(true);
    const scaledZBox = new THREE.Box3().setFromObject(zScene);
    const center = scaledZBox.getCenter(new THREE.Vector3());
    const colliderOffset = new THREE.Vector3(center.x, 0, center.z);
    // Do not manually shift children — it breaks the zombie's natural pivot point!
    // We just set footOffset if needed, but since we scale from origin, footOffset is mostly just -scaledZBox.min.y
    zombieTemplates.push({ scene: zScene, animations: zModel.animations, footOffset: -scaledZBox.min.y, colliderOffset: colliderOffset });
    setLoading(`Spawning zombies… ${zi + 1}/${zombieFiles.length}`, 55 + Math.round(((zi + 1) / zombieFiles.length) * 10));
  }

} catch (e) { console.error('Failed to load zombie models', e); }

setLoading('Loading arrow…', 60);
try {
  const arrowModel = await gltfLoader.loadAsync('/arrow.glb');
  const arrowScene = arrowModel.scene;
  
  // Collect all meshes from the loaded arrow and bake their world transforms
  // This eliminates all the nested Sketchfab rotation matrices so the arrow
  // sits cleanly at origin pointing along a known axis.
  const arrowMeshes = [];
  arrowScene.updateMatrixWorld(true);
  arrowScene.traverse(c => {
    if (c.isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
      // Bake the full world matrix into the geometry so we can place it in a flat Group
      const clonedGeo = c.geometry.clone();
      clonedGeo.applyMatrix4(c.matrixWorld);
      arrowMeshes.push(new THREE.Mesh(clonedGeo, c.material.clone()));
    }
  });
  
  // Build a clean group from the baked meshes
  const bakedGroup = new THREE.Group();
  arrowMeshes.forEach(m => { m.castShadow = true; m.receiveShadow = true; bakedGroup.add(m); });
  
  // Measure and normalize to ~1.2 units long
  const box = new THREE.Box3().setFromObject(bakedGroup);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const arrowScale = 1.2 / maxDim;
  
  // Center the arrow at origin and scale it.
  // Multiply X and Y by 2.5 to increase radial thickness, leaving Z (length) standard.
  bakedGroup.children.forEach(m => {
    m.geometry.translate(-center.x, -center.y, -center.z);
    m.geometry.scale(arrowScale * 2.5, arrowScale * 2.5, arrowScale);
  });
  
  // The arrow GLB's length is along the Z axis. 
  // We need it to point to -Z so lookAt() aims the tip forward.
  // If it's natively +Z (flying backwards), rotate 180° around Y.
  bakedGroup.children.forEach(m => {
    m.geometry.rotateY(Math.PI);
  });
  
  arrowModelTemplate = bakedGroup;

} catch (e) {
  console.error('Failed to load arrow model', e);
}

function spawnZombie() {
  if (!mainCharacter || zombieTemplates.length === 0) return;
  const templateIdx = Math.floor(Math.random() * zombieTemplates.length);
  const template = zombieTemplates[templateIdx];
  const zombieModel = SkeletonUtils.clone(template.scene);
  
  // Spawn at random angle around player
  const angle = Math.random() * Math.PI * 2;
  const dist = 25 + Math.random() * 10;
  const spawnX = mainCharacter.position.x + Math.cos(angle) * dist;
  const spawnZ = mainCharacter.position.z + Math.sin(angle) * dist;
  const groundH = getGroundHeight(spawnX, spawnZ);
  zombieModel.position.set(spawnX, groundH + GROUND_Y_OFFSET + template.footOffset, spawnZ);
  scene.add(zombieModel);
  
  // Setup animations
  const mixer = new THREE.AnimationMixer(zombieModel);
  const actions = {};
  const usedClips = ['walk', 'attack', 'terror', 'dead', 'idle'];
  template.animations.forEach(clip => {
    if (usedClips.includes(clip.name)) {
      actions[clip.name] = mixer.clipAction(clip);
    }
  });
  // Pre-start looping anims
  if (actions.walk) { actions.walk.setLoop(THREE.LoopRepeat, Infinity); actions.walk.setEffectiveWeight(0); actions.walk.play(); }
  if (actions.idle) { actions.idle.setLoop(THREE.LoopRepeat, Infinity); actions.idle.setEffectiveWeight(0); actions.idle.play(); }
  // Start with walk
  if (actions.walk) { actions.walk.setEffectiveWeight(1); }
  
  // Handle one-shot animations
  mixer.addEventListener('finished', (e) => {
    const clipName = e.action.getClip().name;
    if (clipName === 'dead') return; // stay dead
    if (clipName === 'attack') {
      zombie.currentAnim = '__done__';
    }
    if (clipName === 'terror') {
      zombie.currentAnim = '__done__';
    }
  });
  
  const zAudio = new THREE.PositionalAudio(audioListener);
  zAudio.setRefDistance(10);
  zAudio.setMaxDistance(50);
  zombieModel.add(zAudio);

  const zombie = {
    model: zombieModel,
    mixer: mixer,
    actions: actions,
    footOffset: template.footOffset,
    colliderOffset: template.colliderOffset,
    audio: zAudio,
    state: 'walk',
    currentAnim: 'walk',
    health: ZOMBIE_HEALTH,
    attackCooldown: 0,
    terrorTimer: 5 + Math.random() * 10,
    terrorDuration: 0,
    dead: false,
    deadTimer: 0,
  };
  zombies.push(zombie);
  return zombie;
}

function playZombieAnim(zombie, name) {
  if (zombie.currentAnim === name) return;
  const next = zombie.actions[name];
  if (!next) return;
  // Fade out all
  for (const key of ['walk', 'attack', 'terror', 'dead', 'idle']) {
    const act = zombie.actions[key];
    if (act && key !== name) act.fadeOut(0.25);
  }
  if (name === 'attack' || name === 'terror' || name === 'dead') {
    next.reset();
    next.setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true;
  }
  next.enabled = true;
  next.setEffectiveTimeScale(1);
  next.setEffectiveWeight(1);
  next.fadeIn(0.25);
  next.play();
  zombie.currentAnim = name;
}

function damagePlayer(amount) {
  if (isDead) return;
  playerHealth = Math.max(0, playerHealth - amount);
  lastDamageTime = performance.now();
  // Update HUD
  const hpBar = document.getElementById('health-bar');
  const hpText = document.getElementById('health-text');
  const vignette = document.getElementById('damage-vignette');
  if (hpBar) hpBar.style.width = (playerHealth / PLAYER_MAX_HEALTH * 100) + '%';
  if (hpText) hpText.textContent = Math.round(playerHealth);
  if (vignette) { vignette.style.opacity = '1'; setTimeout(() => { vignette.style.opacity = '0'; }, 300); }
  if (playerHealth <= 0) {
    isDead = true;
    playAnim('dead');
    // Show game over after a delay
    setTimeout(() => {
      document.exitPointerLock();
      const goScreen = document.getElementById('game-over');
      const finalKills = document.getElementById('final-kills');
      if (goScreen) goScreen.style.display = 'flex';
      if (finalKills) finalKills.textContent = 'Kills: ' + killCount;
    }, 2000);
  }
}

function shootArrow() {
  if (!mainCharacter || !arrowModelTemplate) return;
  if (sounds.shoot.buffer) {
    if (sounds.shoot.isPlaying) sounds.shoot.stop();
    sounds.shoot.play();
  }
  // Use a raycaster from the exact center of the screen (crosshair)
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  
  // Clone the pre-baked arrow template
  const arrowGroup = arrowModelTemplate.clone(true);
  
  // Try to find the left hand/bow position
  let bowPos = null;
  mainCharacter.traverse((c) => {
    if (c.isBone && c.name.toLowerCase().includes('lefthand')) {
      bowPos = new THREE.Vector3();
      c.getWorldPosition(bowPos);
    }
  });
  
  if (!bowPos) {
    // Fallback if no bone found: calculate shoulder/arm offset
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const right = new THREE.Vector3();
    right.crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const footOff = mainCharacter.userData.footOffset || 0;
    bowPos = mainCharacter.position.clone();
    bowPos.y += -footOff + CHARACTER_HEIGHT * 0.65;
    bowPos.addScaledVector(right, -0.3); // Left side
    bowPos.addScaledVector(dir, 0.4); // Slightly forward
  }
  
  // Find the exact world point the crosshair is looking at
  let targetPoint = raycaster.ray.at(100, new THREE.Vector3()); // Fallback
  const intersects = raycaster.intersectObjects(scene.children, true);
  
  for (let i = 0; i < intersects.length; i++) {
    const obj = intersects[i].object;
    // Ignore player character and arrows
    let isPlayerOrArrow = obj.isArrow === true;
    if (!isPlayerOrArrow) {
      obj.traverseAncestors(a => { if (a === mainCharacter || a.isArrow) isPlayerOrArrow = true; });
    }
    if (isPlayerOrArrow) continue;
    
    // Found the first valid surface/zombie hit
    targetPoint = intersects[i].point;
    break;
  }
  
  // Arrow aims from the bow directly to the precise target point
  const arrowDir = targetPoint.clone().sub(bowPos).normalize();
  
  // Offset start position so arrow doesn't clip through character's arm
  // Arrow is ~1.12 units long, so offset by 0.85 to align tail with bowstring
  const startPos = bowPos.clone().add(arrowDir.clone().multiplyScalar(0.85));
  
  arrowGroup.position.copy(startPos);
  arrowGroup.lookAt(startPos.x + arrowDir.x, startPos.y + arrowDir.y, startPos.z + arrowDir.z);
  scene.add(arrowGroup);
  
  arrows.push({
    mesh: arrowGroup,
    vel: arrowDir.multiplyScalar(ARROW_SPEED),
    life: ARROW_LIFETIME,
    stuck: false
  });
}

function updateZombies(dt) {
  if (!mainCharacter) return;
  const playerPos = mainCharacter.position;
  
  for (let i = zombies.length - 1; i >= 0; i--) {
    const z = zombies[i];
    z.mixer.update(dt);
    
    if (z.dead) {
      z.deadTimer += dt;
      // Sink into ground after 4 seconds
      if (z.deadTimer > 4) {
        z.model.position.y -= dt * 0.5;
        if (z.deadTimer > 6) {
          scene.remove(z.model);
          zombies.splice(i, 1);
        }
      }
      continue;
    }
    
    // Distance to player
    const dx = playerPos.x - z.model.position.x;
    const dz = playerPos.z - z.model.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    
    // Terror timer (random scream)
    z.terrorTimer -= dt;
    if (z.terrorTimer <= 0 && z.state !== 'attack' && z.state !== 'terror') {
      z.state = 'terror';
      z.terrorDuration = 2.8;
      playZombieAnim(z, 'terror');
      z.terrorTimer = 8 + Math.random() * 15;
      
      if (zombieTerrorBuffer && !z.audio.isPlaying) {
        z.audio.setBuffer(zombieTerrorBuffer);
        z.audio.setVolume(1.0);
        z.audio.play();
      }
    }
    
    // State machine
    if (z.state === 'terror') {
      z.terrorDuration -= dt;
      // Snap to ground even during terror
      const gH = getGroundHeight(z.model.position.x, z.model.position.z);
      z.model.position.y = gH + GROUND_Y_OFFSET + z.footOffset;
      if (z.terrorDuration <= 0 || z.currentAnim === '__done__') {
        z.state = 'walk';
        z.currentAnim = '__done__';
      }
    } else if (z.state === 'attack') {
      // Snap to ground during attack
      const gH = getGroundHeight(z.model.position.x, z.model.position.z);
      z.model.position.y = gH + GROUND_Y_OFFSET + z.footOffset;
      // Face player during attack
      z.model.rotation.y = Math.atan2(dx, dz);
      z.attackCooldown -= dt;
      // Damage only at attack animation midpoint (~1.3s into 2.67s attack)
      if (!z.attackDamageDealt && z.attackCooldown < ZOMBIE_ATTACK_COOLDOWN - 1.0) {
        if (dist < ZOMBIE_ATTACK_RANGE + 1.0) {
          damagePlayer(ZOMBIE_DAMAGE);
        }
        z.attackDamageDealt = true;
      }
      if (z.currentAnim === '__done__' || z.attackCooldown <= 0) {
        z.state = 'walk';
        z.currentAnim = '__done__';
      }
    } else {
      // Walk toward player
      if (dist < ZOMBIE_ATTACK_RANGE && dist > 0) {
        // Start attack
        z.state = 'attack';
        z.attackCooldown = ZOMBIE_ATTACK_COOLDOWN;
        z.attackDamageDealt = false;
        playZombieAnim(z, 'attack');
      } else if (dist < ZOMBIE_DETECT_RANGE && dist > 0) {
        // Walk toward player with Tree Collision
        const moveX = (dx / dist) * ZOMBIE_SPEED * dt;
        const moveZ = (dz / dist) * ZOMBIE_SPEED * dt;
        
        let nx = z.model.position.x + moveX;
        let nz = z.model.position.z + moveZ;
        
        if (checkTreeCollision(nx, z.model.position.z)) {
          nx = z.model.position.x; // Block X if hitting a tree
        }
        if (checkTreeCollision(z.model.position.x, nz)) {
          nz = z.model.position.z; // Block Z if hitting a tree
        }
        
        z.model.position.x = nx;
        z.model.position.z = nz;
        // Smooth face toward player
        const targetRot = Math.atan2(dx, dz);
        let rotDiff = targetRot - z.model.rotation.y;
        while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
        while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
        z.model.rotation.y += rotDiff * (1 - Math.exp(-5 * dt));
        // Snap to ground
        const gH = getGroundHeight(z.model.position.x, z.model.position.z);
        z.model.position.y = gH + GROUND_Y_OFFSET + z.footOffset;
        if (z.currentAnim !== 'walk') {
          playZombieAnim(z, 'walk');
        }
        // Sync walk animation speed to movement speed to prevent sliding
        if (z.actions.walk) {
          z.actions.walk.setEffectiveTimeScale(ZOMBIE_SPEED * 0.85);
        }
      } else {
        if (z.currentAnim !== 'idle') playZombieAnim(z, 'idle');
        // Snap to ground even when idle
        const gH = getGroundHeight(z.model.position.x, z.model.position.z);
        z.model.position.y = gH + GROUND_Y_OFFSET + z.footOffset;
      }
    }
  }
}

function updateArrows(dt) {
  const ARROW_GRAVITY = 0; // Removed gravity so arrows fly perfectly straight
  for (let i = arrows.length - 1; i >= 0; i--) {
    const a = arrows[i];
    a.life -= dt;
    if (a.life <= 0) {
      if (a.mesh.parent) a.mesh.parent.remove(a.mesh);
      arrows.splice(i, 1);
      continue;
    }
    
    if (a.stuck) continue; // Skip physics if embedded
    
    // Apply gravity to velocity
    a.vel.y -= ARROW_GRAVITY * dt;
    
    // Move arrow by velocity
    const oldPosX = a.mesh.position.x;
    const oldPosY = a.mesh.position.y;
    const oldPosZ = a.mesh.position.z;
    
    a.mesh.position.x += a.vel.x * dt;
    a.mesh.position.y += a.vel.y * dt;
    a.mesh.position.z += a.vel.z * dt;
    
    // Rotate arrow to follow velocity direction (realistic arc)
    const speed = a.vel.length();
    if (speed > 0.1) {
      const lookTarget = a.mesh.position.clone().add(a.vel.clone().normalize());
      a.mesh.lookAt(lookTarget);
    }
    
    // Remove if arrow hits ground
    const arrowGroundH = getGroundHeight(a.mesh.position.x, a.mesh.position.z) + GROUND_Y_OFFSET;
    if (a.mesh.position.y < arrowGroundH) {
      a.stuck = true;
      a.life = 5; // Stick in ground for 5s
      continue;
    }
    
    // Check collision with zombies
    let hitZombie = false;
    for (let j = 0; j < zombies.length; j++) {
      const z = zombies[j];
      if (z.dead) continue;
      
      // Continuous Collision Detection (CCD): check current pos AND midpoint
      const midX = (oldPosX + a.mesh.position.x) * 0.5;
      const midY = (oldPosY + a.mesh.position.y) * 0.5;
      const midZ = (oldPosZ + a.mesh.position.z) * 0.5;
      
      const offset = z.colliderOffset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), z.model.rotation.y);
      const colX = z.model.position.x + offset.x;
      const colZ = z.model.position.z + offset.z;
      
      const dx1 = a.mesh.position.x - colX;
      const dz1 = a.mesh.position.z - colZ;
      const dy1 = a.mesh.position.y - z.model.position.y;
      
      const dx2 = midX - colX;
      const dz2 = midZ - colZ;
      const dy2 = midY - z.model.position.y;
      
      const distSq1 = dx1 * dx1 + dz1 * dz1;
      const distSq2 = dx2 * dx2 + dz2 * dz2;
      
      const hit1 = distSq1 < 2.5 && dy1 > -0.5 && dy1 < ZOMBIE_HEIGHT + 0.5;
      const hit2 = distSq2 < 2.5 && dy2 > -0.5 && dy2 < ZOMBIE_HEIGHT + 0.5;
      
      if (hit1 || hit2) { // Much larger, highly reliable hitbox
        // Hit!
        z.health--;
        
        a.stuck = true;
        a.life = 5; // Stick in zombie for 5s
        z.model.attach(a.mesh); // Attach to zombie seamlessly preserving world transform
        hitZombie = true;
        
        if (z.health <= 0) {
          z.dead = true;
          z.state = 'dead';
          playZombieAnim(z, 'dead');
          killCount++;
          const killEl = document.getElementById('kill-count');
          if (killEl) killEl.textContent = killCount;
        }
        break;
      }
    }
  }
}

function updateWaveSystem(dt) {
  if (!gameStarted || isDead) return;
  
  const aliveZombies = zombies.filter(z => !z.dead).length;
  // Determine max zombies allowed on screen based on the current wave
  const maxZombiesOnScreen = Math.min(5 + currentWave * 3, 30);
  
  waveSpawnTimer -= dt;
  
  // Continuously spawn zombies to maintain the horde size
  if (waveSpawnTimer <= 0 && aliveZombies < maxZombiesOnScreen) {
    spawnZombie();
    zombiesSpawnedThisWave++;
    // Spawn faster as waves increase
    const spawnDelay = Math.max(0.5, 2.0 - (currentWave * 0.1));
    waveSpawnTimer = spawnDelay + Math.random() * 1.0;
  }
  
  // Progress to the next wave dynamically after every 10 kills
  if (killCount >= currentWave * 10) {
    currentWave++;
    const waveEl = document.getElementById('wave-number');
    if (waveEl) waveEl.textContent = currentWave;
  }
}

const biomeSettings = {
  waterLevel: -5.0, sandEnd: -1.0, dirtEnd: 2.0, transitionWidth: 1.8,
  sandColor1: '#c2b280', sandColor2: '#d4c698',
  dirtColor1: '#5c4033', dirtColor2: '#4a3020',
  grassColor1: '#4a9632', grassColor2: '#285919',
  waterColor: '#1ca3ec', waterColorDeep: '#0044aa',
}

const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
scene.add(ambientLight)
const redAmbient = new THREE.AmbientLight(0x2d5a27, 0.4)
scene.add(redAmbient)
const shadowRedFill = new THREE.HemisphereLight(0xe0f7fa, 0x2d5a27, 0.6)
scene.add(shadowRedFill)

const dirLight = new THREE.DirectionalLight(0xfff0d8, 3.5)
dirLight.position.set(10, 20, 10)
dirLight.castShadow = true
dirLight.shadow.mapSize.set(2048, 2048)
dirLight.shadow.camera.near = 0.5
dirLight.shadow.camera.far = 80
dirLight.shadow.camera.left = -20
dirLight.shadow.camera.right = 20
dirLight.shadow.camera.top = 20
dirLight.shadow.camera.bottom = -20
dirLight.shadow.bias = -0.0005
dirLight.shadow.normalBias = 0.02
scene.add(dirLight)
scene.add(dirLight.target)

const lightSettings = { azimuth: 320, elevation: 45 }

const waterLevel = uniform(biomeSettings.waterLevel)
const sandEnd = uniform(biomeSettings.sandEnd)
const dirtEnd = uniform(biomeSettings.dirtEnd)
const transitionWidth = uniform(biomeSettings.transitionWidth)
const sandColor1 = uniform(new THREE.Color(biomeSettings.sandColor1))
const sandColor2 = uniform(new THREE.Color(biomeSettings.sandColor2))
const dirtColor1 = uniform(new THREE.Color(biomeSettings.dirtColor1))
const dirtColor2 = uniform(new THREE.Color(biomeSettings.dirtColor2))
const grassColor1 = uniform(new THREE.Color(biomeSettings.grassColor1))
const grassColor2 = uniform(new THREE.Color(biomeSettings.grassColor2))
const waterColor = uniform(new THREE.Color(biomeSettings.waterColor))
const waterColorDeep = uniform(new THREE.Color(biomeSettings.waterColorDeep))

const groundMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 })
groundMat.colorNode = Fn(() => {
  const wx = positionWorld.x; const wz = positionWorld.z; const h = positionWorld.y
  const n = mx_noise_float(vec3(wx.mul(0.15), float(0), wz.mul(0.15))).mul(0.5).add(0.5)
  const tn = mx_noise_float(vec3(wx.mul(0.06), float(0), wz.mul(0.06))).mul(transitionWidth)
  const adjustedH = h.add(tn)
  const halfTW = transitionWidth.mul(0.5)
  const sandT = smoothstep(sandEnd.sub(halfTW), sandEnd.add(halfTW), adjustedH)
  const grassT = smoothstep(dirtEnd.sub(halfTW), dirtEnd.add(halfTW), adjustedH)
  const sand = mix(sandColor1, sandColor2, n)
  const dirt = mix(dirtColor1, dirtColor2, n)
  const grass = mix(grassColor1, grassColor2, n)
  const surfaceColor = mix(mix(sand, dirt, sandT), grass, grassT)
  const underwaterDarken = smoothstep(waterLevel.add(float(0.5)), waterLevel.sub(float(1.5)), h)
  const underwaterTint = vec3(0.08, 0.12, 0.1)
  return mix(surfaceColor, underwaterTint, underwaterDarken)
})()

const groundGeo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, GROUND_SEGMENTS, GROUND_SEGMENTS)
const groundMesh = new THREE.Mesh(groundGeo, groundMat)
groundMesh.rotation.x = -Math.PI / 2
groundMesh.receiveShadow = true
scene.add(groundMesh)

let _groundPending = false
let _groundTargetX = 0, _groundTargetZ = 0
let _groundRow = 0
let _groundBuffer = null 
const GROUND_ROWS_PER_FRAME = 80 
const _groundSegsP1 = GROUND_SEGMENTS + 1

function updateGround(px, pz) {
  _groundTargetX = px; _groundTargetZ = pz
  _groundRow = 0
  _groundPending = true
  if (!_groundBuffer || _groundBuffer.length !== _groundSegsP1 * _groundSegsP1) {
    _groundBuffer = new Float32Array(_groundSegsP1 * _groundSegsP1)
  }
}

function tickGround() {
  if (!_groundPending) return
  const posAttr = groundGeo.attributes.position
  const endRow = Math.min(_groundSegsP1, _groundRow + GROUND_ROWS_PER_FRAME)
  const px = _groundTargetX, pz = _groundTargetZ
  for (let row = _groundRow; row < endRow; row++) {
    for (let col = 0; col < _groundSegsP1; col++) {
      const idx = row * _groundSegsP1 + col
      const lx = posAttr.getX(idx); const ly = posAttr.getY(idx)
      _groundBuffer[idx] = getLandscapeHeight(lx + px, pz - ly) + GROUND_Y_OFFSET
    }
  }
  _groundRow = endRow
  if (_groundRow >= _groundSegsP1) {
    for (let i = 0; i < _groundSegsP1 * _groundSegsP1; i++) {
      posAttr.setZ(i, _groundBuffer[i])
    }
    posAttr.needsUpdate = true
    groundMesh.position.x = px; groundMesh.position.z = pz
    groundGeo.computeVertexNormals()
    _groundPending = false
  }
}

function updateGroundSync(px, pz) {
  groundMesh.position.x = px; groundMesh.position.z = pz
  const posAttr = groundGeo.attributes.position
  const total = posAttr.count
  for (let i = 0; i < total; i++) {
    const lx = posAttr.getX(i); const ly = posAttr.getY(i)
    posAttr.setZ(i, getLandscapeHeight(lx + px, pz - ly) + GROUND_Y_OFFSET)
  }
  posAttr.needsUpdate = true
  groundGeo.computeVertexNormals()
}

updateGroundSync(0, 0)

const waterMat = new THREE.MeshStandardNodeMaterial({
  transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.3, side: THREE.DoubleSide,
})
waterMat.colorNode = Fn(() => {
  const wx = positionWorld.x; const wz = positionWorld.z
  const n = mx_noise_float(vec3(wx.mul(0.04).add(time.mul(0.15)), float(0), wz.mul(0.04).add(time.mul(0.1)))).mul(0.5).add(0.5)
  return mix(waterColorDeep, waterColor, n)
})()

const waterGeo = new THREE.PlaneGeometry(GROUND_SIZE + 100, GROUND_SIZE + 100, 2, 2)
const waterMesh = new THREE.Mesh(waterGeo, waterMat)
waterMesh.rotation.x = -Math.PI / 2
waterMesh.position.y = biomeSettings.waterLevel
waterMesh.receiveShadow = true
scene.add(waterMesh)

setLoading('Building the wasteland…', 65)

// ─── Input System ──────────────────────────────────────────────────────
const keys = {}

function startGame() {
  if (audioListener.context.state === 'suspended') {
    audioListener.context.resume();
  }
  if (!gameStarted) {
    gameStarted = true;
    waveSpawnTimer = 1;
    if (sounds.bgm.buffer && !sounds.bgm.isPlaying) sounds.bgm.play();
  }
}

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  // Prevent default browser actions for movement keys (stops scrolling and accidental save dialogs)
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
    e.preventDefault();
  }
  
  // K key removed — death only from zombie attacks
  if (e.code === 'Space' && !isDead && !isJumping) {
    isJumping = true;
    jumpVelocity = JUMP_FORCE;
    jumpYOffset = 0.01;
    playAnim('jump');
    if (sounds.jump.buffer && !sounds.jump.isPlaying) sounds.jump.play();
  }
  // Start zombie waves on any input
  if (!gameStarted && (e.code === 'KeyW' || e.code === 'Space')) {
    startGame();
  }
})
addEventListener('keyup', (e) => { keys[e.code] = false })
addEventListener('blur', () => { for (const k in keys) keys[k] = false; })

let isPointerLocked = false;
let lastShootTime = 0;
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  
  if (audioListener.context.state === 'suspended') {
    audioListener.context.resume();
  }

  if (!isPointerLocked) { renderer.domElement.requestPointerLock(); return; }
  
  const now = performance.now();
  // Ensure player can only fire 1 arrow per 0.3 seconds
  if (!isDead && !isShooting && (now - lastShootTime >= 300)) { 
    lastShootTime = now;
    isShooting = true; 
    playAnim('shoot'); 
    shootArrow(); 
    startGame(); 
  }
});
document.addEventListener('pointerlockchange', () => {
  isPointerLocked = document.pointerLockElement === renderer.domElement;
  if (!isPointerLocked) isShooting = false;
  if (isPointerLocked && !gameStarted) { gameStarted = true; waveSpawnTimer = 1; }
});
addEventListener('mouseup', (e) => { if (e.button === 0) isShooting = false; })
addEventListener('mousemove', (e) => {
  if (isPointerLocked) {
    camYaw -= e.movementX * 0.003;
    camPitch += e.movementY * 0.002;
    // Clamp pitch: -0.6 (look up) to 0.15 (look down) — prevents aiming too far down
    camPitch = Math.max(-0.6, Math.min(0.15, camPitch));
  }
})
addEventListener('contextmenu', (e) => e.preventDefault())
let camDistMul = 1.0;
addEventListener('wheel', (e) => { camDistMul = Math.max(0.4, Math.min(2.0, camDistMul + e.deltaY * 0.001)); })

const _dustMat4 = new THREE.Matrix4()
const _dustScale = new THREE.Vector3()
const _dustPos = new THREE.Vector3()

const dustQuadGeo = new THREE.PlaneGeometry(1, 1)
const dustCanvas = document.createElement('canvas')
dustCanvas.width = 64; dustCanvas.height = 64
const dustCtx = dustCanvas.getContext('2d')
const gradient = dustCtx.createRadialGradient(32, 32, 0, 32, 32, 32)
gradient.addColorStop(0, 'rgba(255,255,255,1)')
gradient.addColorStop(0.2, 'rgba(255,255,255,0.8)')
gradient.addColorStop(0.5, 'rgba(255,255,255,0.35)')
gradient.addColorStop(0.75, 'rgba(255,255,255,0.1)')
gradient.addColorStop(1, 'rgba(255,255,255,0)')
dustCtx.fillStyle = gradient; dustCtx.fillRect(0, 0, 64, 64)
const dustTexture = new THREE.CanvasTexture(dustCanvas)

// ─── Ambient Wind Dust ──────────────────────────────────────────────────
const WIND_DUST_COUNT = 1500
const windDustData = []
for (let i = 0; i < WIND_DUST_COUNT; i++) {
  windDustData.push({
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    life: 0, maxLife: 0,
    size: 0, opacity: 0,
    wobblePhase: Math.random() * Math.PI * 2,
    wobbleSpeed: 1.5 + Math.random() * 2.5,
    wobbleAmp: 0.3 + Math.random() * 0.8,
  })
}

const windSettings = {
  dirX: -3.5, dirZ: 1.8, gustStrength: 2.5, turbulence: 1.2,
  spawnRadius: 60, spawnHeight: 25, particleSize: 1.5, sizeVariance: 1.5,
  lifetime: 4, lifetimeVariance: 3, opacity: 0.35, drag: 0.985,
  colorR: 0.4, colorG: 0.8, colorB: 0.2,
}

const windDustMat = new THREE.MeshBasicMaterial({
  color: new THREE.Color(0.4, 0.8, 0.2),
  transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.15, map: dustTexture,
})
const windDustIMesh = new THREE.InstancedMesh(dustQuadGeo, windDustMat, WIND_DUST_COUNT)
windDustIMesh.frustumCulled = false
windDustIMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
const windDustColors = new Float32Array(WIND_DUST_COUNT * 3).fill(1)
windDustIMesh.instanceColor = new THREE.InstancedBufferAttribute(windDustColors, 3)
windDustIMesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
for (let i = 0; i < WIND_DUST_COUNT; i++) { _dustMat4.makeScale(0, 0, 0); windDustIMesh.setMatrixAt(i, _dustMat4) }
windDustIMesh.instanceMatrix.needsUpdate = true
scene.add(windDustIMesh)

// ─── Rocks & Bushes Scatter (persistent cell-based) ─────────────────────
const _rockGeoCache = []
function createRockGeometry(seed) {
  if (_rockGeoCache.length < 12) {
    for (let g = 0; g < 12; g++) {
      const geo = new THREE.SphereGeometry(1, 24, 16)
      const pos = geo.attributes.position
      const freq1 = 1.5 + g * 0.3, freq2 = 2.8 + g * 0.2
      for (let i = 0; i < pos.count; i++) {
        const nx = pos.getX(i), ny = pos.getY(i), nz = pos.getZ(i)
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
        const ux = nx / len, uy = ny / len, uz = nz / len
        const n1 = Math.sin(ux * freq1 + uz * freq2 + g) * Math.cos(uy * freq1 * 1.3 + g * 0.7)
        const n2 = Math.sin(ux * freq2 * 2.1 + uy * 3.7 + g * 1.1) * 0.5
        const disp = (n1 * 0.12 + n2 * 0.06)
        const squashY = 0.45 + ((Math.sin(g * 2.1) + 1) * 0.5) * 0.4
        pos.setX(i, nx * (1 + disp))
        pos.setY(i, ny * squashY * (1 + disp * 0.5))
        pos.setZ(i, nz * (1 + disp))
      }
      geo.computeVertexNormals()
      _rockGeoCache.push(geo)
    }
  }
  return _rockGeoCache[Math.floor(((seed * 7.31) % 1 + 1) % 1 * 12)]
}

const _bushGeoCache = []
function createBushGeometry(seed) {
  if (_bushGeoCache.length < 6) {
    for (let g = 0; g < 6; g++) {
      const merged = new THREE.Group()
      const count = 3 + (g % 3)
      for (let i = 0; i < count; i++) {
        const r = 0.3 + ((Math.sin(g * 3.1 + i * 2.7) + 1) * 0.5) * 0.4
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), bushMats[0])
        const ax = (Math.sin(g * 1.3 + i * 4.1) * 0.5) * 0.6
        const az = (Math.cos(g * 2.7 + i * 3.3) * 0.5) * 0.6
        sphere.position.set(ax, r * 0.6 + Math.abs(Math.sin(g + i)) * 0.15, az)
        sphere.scale.y = 0.7 + Math.abs(Math.cos(g * 0.8 + i)) * 0.3
        merged.add(sphere)
      }
      _bushGeoCache.push(merged)
    }
  }
  return _bushGeoCache[Math.floor(((seed * 5.17) % 1 + 1) % 1 * 6)].clone()
}

const SCATTER_CELL = 14
const SCATTER_RANGE = 12
const rockMat = new THREE.MeshStandardMaterial({ color: '#8a7d6b', roughness: 0.92, metalness: 0.05 })
const rockMat2 = new THREE.MeshStandardMaterial({ color: '#7a6e5a', roughness: 0.95, metalness: 0.03 })
const rockMat3 = new THREE.MeshStandardMaterial({ color: '#6d6050', roughness: 0.88, metalness: 0.08 })
const rockMats = [rockMat, rockMat2, rockMat3]

const bushMat = new THREE.MeshStandardMaterial({ color: '#4a9632', roughness: 0.85, metalness: 0 })
const bushMat2 = new THREE.MeshStandardMaterial({ color: '#285919', roughness: 0.9, metalness: 0 })
const bushMat3 = new THREE.MeshStandardMaterial({ color: '#3d8c40', roughness: 0.82, metalness: 0 })
const bushMats = [bushMat, bushMat2, bushMat3]

const scatterGroup = new THREE.Group()
scene.add(scatterGroup)
const scatterCells = new Map()

const _sharedGeos = new Set([..._rockGeoCache, ...treeGeometries])

function seededRand(x, z, seed) {
  let n = Math.sin(x * 12.9898 + z * 78.233 + seed * 43.1234) * 43758.5453
  return n - Math.floor(n)
}

function buildCell(cellX, cellZ) {
  const key = cellX + ',' + cellZ
  if (scatterCells.has(key)) return
  const objs = []
  const wx0 = cellX * SCATTER_CELL, wz0 = cellZ * SCATTER_CELL
  const r1 = seededRand(wx0, wz0, 1)
  const r2 = seededRand(wx0, wz0, 2)

  if (r1 < 0.28) {
    const wx = wx0 + (seededRand(wx0, wz0, 3) - 0.5) * SCATTER_CELL * 0.8
    const wz = wz0 + (seededRand(wx0, wz0, 4) - 0.5) * SCATTER_CELL * 0.8
    const h = getLandscapeHeight(wx, wz) + GROUND_Y_OFFSET
    if (h >= biomeSettings.waterLevel - 0.5) {
      const scale = 0.3 + seededRand(wx0, wz0, 5) * 1.2
      const geo = createRockGeometry(r1 + cellX * 0.137 + cellZ * 0.293)
      const mat = rockMats[Math.floor(seededRand(wx0, wz0, 6) * 3)]
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(wx, h - 0.15 * scale, wz)
      mesh.rotation.set(seededRand(wx0, wz0, 7) * 0.4, seededRand(wx0, wz0, 8) * Math.PI * 2, seededRand(wx0, wz0, 9) * 0.3)
      mesh.scale.set(scale, scale * (0.5 + seededRand(wx0, wz0, 10) * 0.6), scale)
      mesh.castShadow = true; mesh.receiveShadow = true
      scatterGroup.add(mesh); objs.push(mesh)
    }
  }

  if (r2 < 0.22) {
    const wx = wx0 + (seededRand(wx0, wz0, 11) - 0.5) * SCATTER_CELL * 0.8
    const wz = wz0 + (seededRand(wx0, wz0, 12) - 0.5) * SCATTER_CELL * 0.8
    const h = getLandscapeHeight(wx, wz) + GROUND_Y_OFFSET
    if (h >= biomeSettings.sandEnd - 0.5) {
      const scale = 0.5 + seededRand(wx0, wz0, 13) * 0.8
      const bg = createBushGeometry(seededRand(wx0, wz0, 16))
      const mat = bushMats[Math.floor(seededRand(wx0, wz0, 14) * 3)]
      bg.traverse(c => { if (c.isMesh) { c.material = mat; c.castShadow = true; c.receiveShadow = true } })
      bg.position.set(wx, h - 0.05, wz)
      bg.scale.setScalar(scale)
      bg.rotation.y = seededRand(wx0, wz0, 15) * Math.PI * 2
      scatterGroup.add(bg); objs.push(bg)
    }
  }

  const rTree = seededRand(wx0, wz0, 40)
  if (rTree < 0.40 && loadedTrees.length > 0) {
    // Reduced tree density — only one tree per cell, 40% chance
    const treeCount = 1
    for (let t = 0; t < treeCount; t++) {
      const wx = wx0 + (seededRand(wx0, wz0, 41 + t) - 0.5) * SCATTER_CELL * 0.9
      const wz = wz0 + (seededRand(wx0, wz0, 42 + t) - 0.5) * SCATTER_CELL * 0.9
      const h = getLandscapeHeight(wx, wz) + GROUND_Y_OFFSET
      if (h >= biomeSettings.sandEnd + 0.5) { 
        let treeIdx = Math.floor(seededRand(wx0, wz0, 43 + t) * loadedTrees.length)
        
        // Spawn low_poly_tree (index 3) everywhere (90%), make dead tree (index 1) rare (3%)
        const biasRand = seededRand(wx0, wz0, 99 + t)
        if (biasRand < 0.90) treeIdx = 3; // low_poly_tree
        else if (biasRand < 0.93) treeIdx = 1; // low_poly_dead_tree
        
        const tree = loadedTrees[treeIdx].clone()
        
        // Trees between 6-12 units tall (realistic: a human is 1.8, trees 3-7x taller)
        const treeScale = 6.0 + seededRand(wx0, wz0, 44 + t) * 6.0
        tree.position.set(wx, h, wz)
        tree.scale.setScalar(treeScale)
        tree.rotation.y = seededRand(wx0, wz0, 45 + t) * Math.PI * 2
        
        const tilt = 0.04
        tree.rotation.x = (seededRand(wx0, wz0, 46 + t) - 0.5) * tilt
        tree.rotation.z = (seededRand(wx0, wz0, 47 + t) - 0.5) * tilt

        scatterGroup.add(tree)
        objs.push(tree)
        // Register tree as a collider — radius scales with tree size
        treeColliders.push({ x: wx, z: wz, r: TREE_COLLISION_RADIUS * (treeScale / 6.0), cellKey: key })
      }
    }
  }

  scatterCells.set(key, objs)
}

function removeCell(key) {
  const objs = scatterCells.get(key)
  if (!objs) return
  for (const obj of objs) {
    scatterGroup.remove(obj)
    obj.traverse(c => {
      if (c.geometry && !_rockGeoCache.includes(c.geometry) && !_sharedGeos?.has(c.geometry) && !_bushGeoCache.some(bg => { let found = false; bg.traverse(bc => { if (bc.geometry === c.geometry) found = true }); return found })) {
        c.geometry.dispose()
      }
    })
  }
  // Remove associated tree colliders
  for (let i = treeColliders.length - 1; i >= 0; i--) {
    if (treeColliders[i].cellKey === key) treeColliders.splice(i, 1);
  }
  scatterCells.delete(key)
}

let _lastScatterCX = null, _lastScatterCZ = null
let _scatterBuildQueue = []
const SCATTER_CELLS_PER_FRAME = 2
const MAX_SCATTER_CELLS = 800

function updateScatter(px, pz) {
  const cx = Math.round(px / SCATTER_CELL)
  const cz = Math.round(pz / SCATTER_CELL)
  if (cx === _lastScatterCX && cz === _lastScatterCZ) return
  _lastScatterCX = cx; _lastScatterCZ = cz
  const maxDist = SCATTER_RANGE + 2
  let removed = 0
  for (const key of [...scatterCells.keys()]) {
    if (removed >= 12) break
    const sep = key.indexOf(',')
    const kx = parseInt(key.substring(0, sep))
    const kz = parseInt(key.substring(sep + 1))
    if (Math.abs(kx - cx) > maxDist || Math.abs(kz - cz) > maxDist) {
      removeCell(key)
      removed++
    }
  }
  if (scatterCells.size < MAX_SCATTER_CELLS) {
    _scatterBuildQueue = []
    for (let gx = -SCATTER_RANGE; gx <= SCATTER_RANGE; gx++) {
      for (let gz = -SCATTER_RANGE; gz <= SCATTER_RANGE; gz++) {
        const key = (cx + gx) + ',' + (cz + gz)
        if (!scatterCells.has(key)) {
          _scatterBuildQueue.push({ cx: cx + gx, cz: cz + gz, d: gx * gx + gz * gz })
        }
      }
    }
    _scatterBuildQueue.sort((a, b) => a.d - b.d)
    if (_scatterBuildQueue.length > 80) _scatterBuildQueue.length = 80
  }
}

function tickScatterBuild() {
  if (scatterCells.size >= MAX_SCATTER_CELLS) return
  const count = Math.min(SCATTER_CELLS_PER_FRAME, _scatterBuildQueue.length)
  for (let i = 0; i < count; i++) {
    const item = _scatterBuildQueue.shift()
    const key = item.cx + ',' + item.cz
    if (scatterCells.has(key)) continue
    buildCell(item.cx, item.cz)
  }
}

updateScatter(0, 0)
while (_scatterBuildQueue.length > 0) tickScatterBuild()

let windDustIndex = 0
let windTime = 0

function spawnWindDust(cx, cy, cz) {
  const i = windDustIndex % WIND_DUST_COUNT; windDustIndex++
  const d = windDustData[i]
  const angle = Math.random() * Math.PI * 2
  const dist = Math.random() * windSettings.spawnRadius
  d.x = cx + Math.cos(angle) * dist
  d.z = cz + Math.sin(angle) * dist
  d.y = cy + 0.5 + Math.random() * windSettings.spawnHeight
  d.vx = windSettings.dirX * (0.6 + Math.random() * 0.4)
  d.vy = (Math.random() - 0.4) * 0.5
  d.vz = windSettings.dirZ * (0.6 + Math.random() * 0.4)
  d.maxLife = windSettings.lifetime + Math.random() * windSettings.lifetimeVariance
  d.life = d.maxLife
  d.size = windSettings.particleSize + Math.random() * windSettings.sizeVariance
  d.opacity = windSettings.opacity * (0.3 + Math.random() * 0.7)
  d.wobblePhase = Math.random() * Math.PI * 2
}

function updateWindDust(dt, cx, cy, cz) {
  windTime += dt
  const gustX = Math.sin(windTime * 0.7) * windSettings.gustStrength
  const gustZ = Math.cos(windTime * 0.5) * windSettings.gustStrength * 0.6
  for (let i = 0; i < WIND_DUST_COUNT; i++) {
    const d = windDustData[i]
    if (d.life <= 0) {
      _dustMat4.makeScale(0, 0, 0)
      windDustIMesh.setMatrixAt(i, _dustMat4)
      windDustColors[i*3] = 0; windDustColors[i*3+1] = 0; windDustColors[i*3+2] = 0
      continue
    }
    d.life -= dt
    const turbX = Math.sin(windTime * 3.1 + d.wobblePhase) * windSettings.turbulence
    const turbZ = Math.cos(windTime * 2.7 + d.wobblePhase * 1.3) * windSettings.turbulence * 0.8
    const wobble = Math.sin(windTime * d.wobbleSpeed + d.wobblePhase) * d.wobbleAmp
    d.vx += (gustX + turbX) * dt
    d.vy += wobble * dt * 0.5
    d.vz += (gustZ + turbZ) * dt
    d.vx *= windSettings.drag; d.vy *= windSettings.drag; d.vz *= windSettings.drag
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt
    if (d.y < biomeSettings.waterLevel + 0.3) d.y = biomeSettings.waterLevel + 0.3 + Math.random() * 0.5
    const t = Math.max(0, d.life / d.maxLife)
    const fadeIn = Math.min(1, (d.maxLife - d.life) * 3)
    const fadeOut = t < 0.3 ? t / 0.3 : 1
    const alpha = fadeIn * fadeOut
    const s = (d.size * 0.08) * alpha
    const distFromCam = Math.sqrt((d.x - cx) ** 2 + (d.z - cz) ** 2)
    const distFade = Math.max(0, 1 - distFromCam / (windSettings.spawnRadius * 1.2))
    windDustColors[i*3] = windSettings.colorR
    windDustColors[i*3+1] = windSettings.colorG
    windDustColors[i*3+2] = windSettings.colorB
    _dustPos.set(d.x, d.y, d.z)
    _dustScale.set(s * distFade, s * distFade, s * distFade)
    _dustMat4.compose(_dustPos, camera.quaternion, _dustScale)
    windDustIMesh.setMatrixAt(i, _dustMat4)
  }
  windDustIMesh.instanceMatrix.needsUpdate = true
  windDustIMesh.instanceColor.needsUpdate = true
}

let lastGroundX = 0, lastGroundZ = 0
const clock = new THREE.Clock()

// Check if a position collides with any tree
function checkTreeCollision(x, z) {
  for (let i = 0; i < treeColliders.length; i++) {
    const t = treeColliders[i];
    const dx = x - t.x;
    const dz = z - t.z;
    const distSq = dx * dx + dz * dz;
    const minDist = CHARACTER_RADIUS + t.r;
    if (distSq < minDist * minDist) {
      const dist = Math.sqrt(distSq);
      return { hit: true, nx: dx / dist, nz: dz / dist, overlap: minDist - dist };
    }
  }
  return { hit: false };
}

// Terrain height — sample 8 points around the character at its collision radius
// to ensure the character is always above the highest point under its feet
function getGroundHeight(x, z) {
  const R = 0.5; // slightly larger than CHARACTER_RADIUS for safety
  const h0 = getLandscapeHeight(x, z);
  const h1 = getLandscapeHeight(x + R, z);
  const h2 = getLandscapeHeight(x - R, z);
  const h3 = getLandscapeHeight(x, z + R);
  const h4 = getLandscapeHeight(x, z - R);
  const h5 = getLandscapeHeight(x + R * 0.7, z + R * 0.7);
  const h6 = getLandscapeHeight(x - R * 0.7, z + R * 0.7);
  const h7 = getLandscapeHeight(x + R * 0.7, z - R * 0.7);
  const h8 = getLandscapeHeight(x - R * 0.7, z - R * 0.7);
  return Math.max(h0, h1, h2, h3, h4, h5, h6, h7, h8) + 0.05;
}

let _targetRotY = Math.PI; // smooth rotation target

function updateCameraMovement(dt) {
  if (mainCharacter && !isDead) {
    const RUN_SPEED = 4.0; // realistic jog speed
    const speed = RUN_SPEED * dt;
    const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw)).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    let moved = false;
    const moveDir = new THREE.Vector3();
    
    let isMovingBackward = false;

    // All direction keys contribute to BOTH movement AND facing direction
    if (keys.KeyW || keys.ArrowUp) { moveDir.add(fwd); moved = true; }
    if (keys.KeyS || keys.ArrowDown) {
      moveDir.addScaledVector(fwd, -1);
      moved = true;
      if (!keys.KeyW && !keys.ArrowUp) isMovingBackward = true;
    }
    if (keys.KeyA || keys.ArrowLeft) { moveDir.addScaledVector(right, -1); moved = true; }
    if (keys.KeyD || keys.ArrowRight) { moveDir.add(right); moved = true; }

    if (moved && !isShooting) {
      moveDir.normalize();

      if (isMovingBackward) {
        // Face forward relative to the camera while moving backward
        _targetRotY = Math.atan2(fwd.x, fwd.z);
        mainCharacter.rotation.y = _targetRotY;
      } else {
        // INSTANT rotation — snap character to face movement direction immediately
        _targetRotY = Math.atan2(moveDir.x, moveDir.z);
        mainCharacter.rotation.y = _targetRotY;
      }

      const stepX = moveDir.x * speed;
      const stepZ = moveDir.z * speed;
      let newX = mainCharacter.position.x + stepX;
      let newZ = mainCharacter.position.z + stepZ;

      // Multi-step collision: check both axes separately for wall sliding
      const colFull = checkTreeCollision(newX, newZ);
      if (colFull.hit) {
        const colX = checkTreeCollision(newX, mainCharacter.position.z);
        const colZ = checkTreeCollision(mainCharacter.position.x, newZ);
        if (!colX.hit) {
          newX = newX; newZ = mainCharacter.position.z;
        } else if (!colZ.hit) {
          newX = mainCharacter.position.x; newZ = newZ;
        } else {
          newX = mainCharacter.position.x;
          newZ = mainCharacter.position.z;
        }
      }
      mainCharacter.position.x = newX;
      mainCharacter.position.z = newZ;

      // Play run or backward animation when moving
      if (!isJumping) playAnim(isMovingBackward ? 'backward' : 'run');
    } else if (!isShooting && !isJumping) {
      playAnim('idle');
    }
    
    // Snap character to face aim direction when shooting
    if (isShooting) {
      const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw)).normalize();
      mainCharacter.rotation.y = Math.atan2(fwd.x, fwd.z);
    }

    // Jump physics
    if (isJumping) {
      jumpVelocity += GRAVITY * dt;
      jumpYOffset += jumpVelocity * dt;
      if (jumpYOffset <= 0) { jumpYOffset = 0; jumpVelocity = 0; isJumping = false; }
    }

    // Snap to terrain — use smoothed ground height to prevent clipping
    const footOff = mainCharacter.userData.footOffset || 0;
    const groundH = getGroundHeight(mainCharacter.position.x, mainCharacter.position.z);
    mainCharacter.position.y = groundH + GROUND_Y_OFFSET + footOff + jumpYOffset;

    // Handle movement audio
    if (!isDead && moved && !isJumping && !isShooting) {
      if (isMovingBackward) {
        if (sounds.run.isPlaying) sounds.run.stop();
        if (sounds.backward.buffer && !sounds.backward.isPlaying) sounds.backward.play();
      } else {
        if (sounds.backward.isPlaying) sounds.backward.stop();
        if (sounds.run.buffer && !sounds.run.isPlaying) sounds.run.play();
      }
    } else {
      if (sounds.run.isPlaying) sounds.run.stop();
      if (sounds.backward.isPlaying) sounds.backward.stop();
    }
  }

  // ─── Third-Person Camera (Over-The-Shoulder, pitch-aware for aiming) ───
  if (mainCharacter) {
    const charPos = mainCharacter.position;
    const dist = CAM_DISTANCE * camDistMul;

    // Camera orbits around character using spherical coords (yaw + pitch)
    const footOff = mainCharacter.userData.footOffset || 0;
    const lookTargetY = charPos.y - footOff + CHARACTER_HEIGHT * 0.7; // Shoulder height
    
    // Over-The-Shoulder Offset (Move camera slightly to the right)
    const rightX = Math.cos(camYaw);
    const rightZ = -Math.sin(camYaw);
    const shoulderOffset = 0.8;
    
    const idealX = charPos.x + Math.sin(camYaw) * Math.cos(camPitch) * dist + rightX * shoulderOffset;
    const idealZ = charPos.z + Math.cos(camYaw) * Math.cos(camPitch) * dist + rightZ * shoulderOffset;
    const idealY = lookTargetY + Math.sin(camPitch) * dist + CAM_HEIGHT * 0.3;

    // Keep camera above terrain
    const camGroundH = getGroundHeight(idealX, idealZ) + GROUND_Y_OFFSET;
    const clampedY = Math.max(idealY, camGroundH + 0.5);

    // Smooth follow
    const lerpFactor = 1 - Math.exp(-CAM_SMOOTHING * dt);
    camera.position.x += (idealX - camera.position.x) * lerpFactor;
    camera.position.y += (clampedY - camera.position.y) * lerpFactor;
    camera.position.z += (idealZ - camera.position.z) * lerpFactor;

    // Look at target offset by the same shoulder offset so the aim line is parallel
    const targetX = charPos.x + rightX * shoulderOffset;
    const targetZ = charPos.z + rightZ * shoulderOffset;
    camera.lookAt(targetX, lookTargetY, targetZ);
  }
}

async function animate() {
  try {
    const dt = Math.min(clock.getDelta(), 0.1)
    if (characterMixer) characterMixer.update(dt)
    updateCameraMovement(dt)
    updateZombies(dt)
    updateArrows(dt)
    updateWaveSystem(dt)
    
    // Use character position as the scene center, fallback to camera
    const px = mainCharacter ? mainCharacter.position.x : camera.position.x
    const pz = mainCharacter ? mainCharacter.position.z : camera.position.z
    const py = mainCharacter ? mainCharacter.position.y : 0
    
    const snapX = Math.round(px / GROUND_SNAP) * GROUND_SNAP
    const snapZ = Math.round(pz / GROUND_SNAP) * GROUND_SNAP
    if (snapX !== lastGroundX || snapZ !== lastGroundZ) { 
      lastGroundX = snapX
      lastGroundZ = snapZ
      updateGround(snapX, snapZ) 
    }

    tickGround()
    tickScatterBuild()

    if (!animate._scatterFrame) animate._scatterFrame = 0
    if (++animate._scatterFrame % 20 === 0) {
      updateScatter(px, pz)
      if (scatterCells.size > MAX_SCATTER_CELLS * 0.9) {
        const cx = Math.round(px / SCATTER_CELL)
        const cz = Math.round(pz / SCATTER_CELL)
        const maxDist = SCATTER_RANGE + 2
        let cleaned = 0
        for (const key of [...scatterCells.keys()]) {
          if (cleaned >= 20) break
          const sep = key.indexOf(',')
          const kx = parseInt(key.substring(0, sep))
          const kz = parseInt(key.substring(sep + 1))
          if (Math.abs(kx - cx) > maxDist || Math.abs(kz - cz) > maxDist) {
            removeCell(key); cleaned++
          }
        }
      }
    }

    waterMesh.position.x = px; waterMesh.position.z = pz

    const azRad = (lightSettings.azimuth * Math.PI) / 180
    const elRad = (lightSettings.elevation * Math.PI) / 180
    const lightDist = 30
    dirLight.position.set(
      px + Math.cos(elRad) * Math.sin(azRad) * lightDist,
      py + Math.sin(elRad) * lightDist,
      pz + Math.cos(elRad) * Math.cos(azRad) * lightDist)
    const lightTargetPos = new THREE.Vector3(px, py, pz)
    dirLight.target.position.copy(lightTargetPos); dirLight.target.updateMatrixWorld()

    for (let s = 0; s < 3; s++) {
      spawnWindDust(px, py, pz)
    }
    updateWindDust(dt, camera.position.x, camera.position.y, camera.position.z)

    renderer.render(scene, camera)
    stats.update()
    try { await renderer.resolveTimestampsAsync('render'); await renderer.resolveTimestampsAsync('compute') } catch (e) {}
  } catch (err) { console.error('Animation loop error:', err) }
}

setLoading('Enter the apocalypse…', 100)
const loaderEl = document.getElementById('loader')
if (loaderEl) { setTimeout(() => { loaderEl.style.opacity = '0'; setTimeout(() => loaderEl.remove(), 800) }, 500) }

renderer.setAnimationLoop(animate)

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix()
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight)
})
