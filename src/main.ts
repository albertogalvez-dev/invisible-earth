import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadTerrain } from './terrain';
import { createGlobe, faceQuat, GLOBE_R, type Globe } from './globe';
import { sites } from './sites';
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
let terrainMesh: THREE.Mesh | undefined;
let globe: Globe | undefined;
let currentView: 'terrain' | 'globe' = 'terrain';
const toggle = document.createElement('button');
toggle.className = 'view-toggle';
toggle.textContent = 'Show Earth';
toggle.disabled = true;
container.appendChild(toggle);
const sitePicker = document.createElement('select');
sitePicker.className = 'site-picker';
sitePicker.setAttribute('aria-label', 'Focus the globe on a location');
sitePicker.hidden = true;
for (const site of sites) {
  const option = document.createElement('option');
  option.value = site.id;
  option.textContent = site.name;
  sitePicker.appendChild(option);
}
container.appendChild(sitePicker);
loadTerrain().then((terrain) => {
  terrainMesh = terrain;
  terrain.visible = currentView === 'terrain';
  scene.add(terrain);
  if (currentView === 'terrain') status.textContent = 'Venezuela terrain · Mapzen / AWS Terrain Tiles · drag to explore';
}).catch((error: unknown) => {
  console.error(error);
  status.textContent = 'Terrain could not be loaded. Check the data files.';
});

new THREE.TextureLoader().loadAsync('data/globe.png').then((texture) => {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  globe = createGlobe(sites.map((site) => ({ id: site.id, lat: site.latitude, lon: site.longitude })), texture, new THREE.Vector3(-0.55, 0.32, 0.75));
  globe.root.scale.setScalar(1 / GLOBE_R);
  const initial = sites[0];
  globe.spin.quaternion.copy(faceQuat(initial.latitude, initial.longitude, new THREE.Vector3(0, 0, 1)));
  globe.root.visible = false;
  scene.add(globe.root);
  toggle.disabled = false;
}).catch((error: unknown) => { console.error('Earth texture could not be loaded.', error); });

toggle.addEventListener('click', () => {
  if (!globe) return;
  currentView = currentView === 'terrain' ? 'globe' : 'terrain';
  globe.root.visible = currentView === 'globe';
  sitePicker.hidden = currentView !== 'globe';
  if (terrainMesh) terrainMesh.visible = currentView === 'terrain';
  controls.maxPolarAngle = currentView === 'globe' ? Math.PI : Math.PI / 2 - 0.04;
  camera.position.set(0, currentView === 'globe' ? 0 : 3.2, 5);
  controls.target.set(0, 0, 0);
  controls.update();
  toggle.textContent = currentView === 'terrain' ? 'Show Earth' : 'Show Venezuela terrain';
  status.textContent = currentView === 'globe' ? 'Earth · Mapzen / AWS Terrain Tiles · drag to explore' : 'Venezuela terrain · Mapzen / AWS Terrain Tiles · drag to explore';
});

sitePicker.addEventListener('change', () => {
  const site = sites.find((item) => item.id === sitePicker.value);
  if (!site || !globe) return;
  globe.spin.quaternion.copy(faceQuat(site.latitude, site.longitude, new THREE.Vector3(0, 0, 1)));
  camera.position.set(0, 0, 5);
  controls.target.set(0, 0, 0);
  controls.update();
});

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
}
window.addEventListener('resize', resize);
renderer.setAnimationLoop(() => { globe?.update(performance.now() / 1000, sitePicker.value, 0, 1, 0, 1); controls.update(); renderer.render(scene, camera); });
