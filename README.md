# Zombow — Survive the Horde 🏹🧟

**Zombow** is a fast-paced, low-poly 3rd-person survival archery game built entirely in the browser using raw **Three.js** and **WebGPU**. Test your aim and reflexes as you defend yourself against relentless waves of the undead in a vibrant, procedural tropical landscape!

## 🎮 Gameplay Features
*   **Professional Archery Combat:** Over-the-shoulder (OTS) camera mechanics with instant-snap aiming. Fire laser-accurate arrows that dynamically stick into targets and the environment using custom physics.
*   **Intelligent Zombie AI:** Zombies feature full state machines (idle, walk, attack, terror). Watch them dynamically react, scream, and track you down!
*   **Immersive 3D Spatial Audio:** Fully integrated positional audio. Hear zombies growl from their exact location in the 3D world, alongside dynamic background music and movement Foley (footsteps, jumping, shooting).
*   **Fair-Play Mechanics:** A strict 1-second cooldown on your bow forces you to make every shot count. You can't spam your way out of the apocalypse!
*   **Procedural World:** Experience a lush, low-poly jungle that generates infinitely as you explore. Features swaying trees, animated wind dust, and multi-sampled terrain height-mapping for smooth walking mechanics.

## 🚀 Technology Stack
*   **Engine:** Three.js (WebGPU Renderer)
*   **Framework:** Vite (Vanilla JS)
*   **Models:** Dynamically loaded `.glb` models compressed with Draco for lightning-fast delivery.
*   **Audio:** Custom `.dat` asset delivery to completely bypass aggressive browser extensions (like IDM) that ruin web-game experiences.

## 🛠️ Installation & Running Locally

1. **Clone the repository.**
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Start the local development server:**
   ```bash
   npm run dev
   ```
4. **Play the game** by navigating to `http://localhost:5173/` in your browser.

## 🎯 Controls
*   **WASD / Arrow Keys:** Move around the world.
*   **Mouse:** Look around and aim.
*   **Left Click:** Shoot an arrow (1-second cooldown).
*   **Spacebar:** Jump.
*   **Scroll Wheel:** Adjust camera zoom distance.

---
*Created as an exploration into high-performance, browser-based 3D game mechanics.*
