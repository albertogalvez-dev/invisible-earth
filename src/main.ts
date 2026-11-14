import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadTerrain } from './terrain';
import './style.css';

const container = document.querySelector<HTMLElement>('#app');
if (!container) throw new Error('The application container was not found.');

const scene = new THREE.Scene();
scene.background = new THREE.Color('#03090e');
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 3.2, 5);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.domElement.setAttribute('aria-label', 'Interactive three-dimensional terrain');
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 1.8;
controls.maxDistance = 12;
controls.maxPolarAngle = Math.PI / 2 - 0.04;
scene.add(new THREE.HemisphereLight(0xe1f4ff, 0x18252b, 2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(-3, 6, -4);
scene.add(sun);

const status = document.createElement('div');
status.className = 'terrain-status';
status.textContent = 'Loading Venezuela terrain…';
container.appendChild(status);
loadTerrain().then((terrain) => {
  scene.add(terrain);
  status.textContent = 'Venezuela terrain · Mapzen / AWS Terrain Tiles · drag to explore';
}).catch((error: unknown) => {
  console.error(error);
  status.textContent = 'Terrain could not be loaded. Check the data files.';
});

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
}
window.addEventListener('resize', resize);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
