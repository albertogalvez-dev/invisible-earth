import * as THREE from 'three';
import './style.css';

const container = document.querySelector<HTMLElement>('#app');
if (!container) throw new Error('The application container was not found.');

const scene = new THREE.Scene();
scene.background = new THREE.Color('#03090e');
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 0, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.domElement.setAttribute('aria-label', 'Three-dimensional Earth visualization');
container.appendChild(renderer.domElement);

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
}
window.addEventListener('resize', resize);
renderer.setAnimationLoop(() => renderer.render(scene, camera));
