import * as THREE from 'three';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

// --- CONFIGURATION ---
const CONFIG = {
    smoothing: 0.6,
    pinchStart: 0.05,
    pinchEnd: 0.08,
    planeY: 0
};

// --- STATE ---
const STATE = {
    mode: 'IDLE', // IDLE, DRAWING, CONFIRMED, EXTRUDING
    gesture: 'NONE',
    isPinching: false,
    handCount: 0,
    landmarks: null,
    smoothedLandmarks: null,
    startPoint: null,
    currentPoint: null,
    activeMesh: null,
    shapeType: 'box', // box, cylinder, torus, octahedron
    trail: [] // For motion trails
};

// --- DOM ---
const video = document.getElementById('input-video');
const canvas = document.getElementById('output-canvas');
const ctx = canvas.getContext('2d');
const glCanvas = document.getElementById('webgl-canvas');
const uiMode = document.getElementById('mode-display');
const uiGesture = document.getElementById('gesture-display');
const uiShape = document.getElementById('shape-display');
const loadingScreen = document.getElementById('loading-screen');
const loadingText = document.getElementById('loading-text');
const startBtn = document.getElementById('start-camera-btn');

// --- THREE.JS GLOBALS ---
let scene, camera, renderer, raycaster, constructionPlane;
let handGroup, fingerJoints = [];

// --- INITIALIZATION ---
let handLandmarker = undefined;
let lastVideoTime = -1;

async function init() {
    initThreeJS();
    
    // 1. Load MediaPipe Models using Modern Tasks Vision
    loadingText.innerText = "Loading Neural Models...";
    
    try {
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );
        
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
                delegate: "GPU"
            },
            runningMode: "VIDEO",
            numHands: 2
        });

        loadingText.innerText = "Models Ready. Please Allow Camera.";
        startBtn.style.display = "block";
        
        startBtn.addEventListener('click', async () => {
            try {
                await startCamera();
                loadingScreen.style.opacity = 0;
                setTimeout(() => loadingScreen.style.display = 'none', 500);
                detectFrame();
            } catch (e) {
                alert("Camera access denied: " + e.message);
            }
        });

    } catch (error) {
        console.error(error);
        loadingText.innerText = "Error loading models. Check console.";
    }
}

function startCamera() {
    return navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: 'user' }
    }).then(stream => {
        video.srcObject = stream;
        return new Promise((resolve) => {
            video.onloadedmetadata = () => {
                video.play();
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                resolve();
            };
        });
    });
}

// --- MAIN LOOP ---
function detectFrame() {
    if (video.readyState < 2) {
        requestAnimationFrame(detectFrame);
        return;
    }

    const startTimeMs = performance.now();
    
    if (handLandmarker && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const results = handLandmarker.detectForVideo(video, startTimeMs);
        processResults(results);
    }
    
    renderThreeJS();
    requestAnimationFrame(detectFrame);
}

// --- GESTURE & MATH LOGIC ---
function processResults(results) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    STATE.handCount = results.landmarks.length;
    STATE.landmarks = results.landmarks[0] || null;
    
    let detectedGesture = 'NONE';
    let pinchDist = 1.0;

    if (STATE.landmarks) {
        // 1. Smoothing
        const raw = STATE.landmarks;
        if (!STATE.smoothedLandmarks) STATE.smoothedLandmarks = raw;
        
        for (let i = 0; i < 21; i++) {
            STATE.smoothedLandmarks[i] = {
                x: CONFIG.smoothing * raw[i].x + (1 - CONFIG.smoothing) * STATE.smoothedLandmarks[i].x,
                y: CONFIG.smoothing * raw[i].y + (1 - CONFIG.smoothing) * STATE.smoothedLandmarks[i].y,
                z: CONFIG.smoothing * raw[i].z + (1 - CONFIG.smoothing) * STATE.smoothedLandmarks[i].z
            };
        }

        const lm = STATE.smoothedLandmarks;
        
        // 2. Draw "Apple Vision Pro" Style Hand
        drawNeuralHand(lm);

        // 3. Pinch Detection (Thumb tip #4, Index tip #8)
        const thumbTip = lm[4];
        const indexTip = lm[8];
        pinchDist = Math.sqrt(
            Math.pow(thumbTip.x - indexTip.x, 2) + 
            Math.pow(thumbTip.y - indexTip.y, 2)
        );
        
        STATE.pinchDist = pinchDist;

        if (pinchDist < CONFIG.pinchStart) STATE.isPinching = true;
        else if (pinchDist > CONFIG.pinchEnd) STATE.isPinching = false;

        if (STATE.isPinching) detectedGesture = 'PINCH';
        
        // 4. Two Hand Logic
        if (results.landmarks.length > 1) {
            detectedGesture = 'TWO_HANDS';
            const lm2 = results.landmarks[1]; // Second hand (less smoothed for responsiveness)
            const distHands = Math.abs(lm[8].y - lm2[8].y);
            
            if (distHands > 0.2) handleExtrusion(distHands);
            else handleZoom(Math.abs(lm[8].x - lm2[8].x));
        }

        // 5. Interaction State Machine
        if (detectedGesture === 'PINCH' && !STATE.activeMesh) {
            STATE.mode = 'DRAWING';
            const pt = getRaycastPoint(indexTip);
            if (pt) {
                STATE.startPoint = pt;
                STATE.currentPoint = pt;
                determineShapeType(lm); // Creative shape selection
                createMesh();
            }
        } else if (STATE.mode === 'DRAWING' && STATE.isPinching) {
            const pt = getRaycastPoint(indexTip);
            if (pt) {
                STATE.currentPoint = pt;
                updateMesh();
                // Add to trail
                STATE.trail.push(pt.clone());
                if (STATE.trail.length > 20) STATE.trail.shift();
            }
        } else if (STATE.mode === 'DRAWING' && !STATE.isPinching) {
            STATE.mode = 'CONFIRMED';
            finalizeMesh();
        }
    } else {
        STATE.isPinching = false;
        STATE.smoothedLandmarks = null;
        if (STATE.mode === 'DRAWING') STATE.mode = 'IDLE';
    }

    // Update HUD
    uiMode.innerText = STATE.mode;
    uiGesture.innerText = detectedGesture;
    uiShape.innerText = STATE.shapeType.toUpperCase();
    
    // Color coding
    uiMode.style.color = STATE.mode === 'DRAWING' ? '#ffaa00' : '#00ff88';
}

function determineShapeType(lm) {
    // Creative Logic: Detect rough circular motion or hand orientation
    // For now, randomize or based on pinch height for demo variety
    const types = ['box', 'cylinder', 'torus', 'octahedron'];
    // Simple heuristic: Use Z-depth of hand to pick shape
    const z = lm[8].z; 
    if (z < -0.05) STATE.shapeType = 'torus';
    else if (z > 0.05) STATE.shapeType = 'octahedron';
    else STATE.shapeType = Math.random() > 0.5 ? 'box' : 'cylinder';
}

function getRaycastPoint(landmark) {
    // Convert Normalized Landmark to NDC
    const ndcX = -(landmark.x * 2 - 1);
    const ndcY = -(landmark.y * 2 - 1);
    
    const mouse = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(mouse, camera);
    
    const intersects = raycaster.intersectObject(constructionPlane);
    return intersects.length > 0 ? intersects[0].point : null;
}

// --- VISUALIZATION (NEURAL HAND) ---
function drawNeuralHand(lm) {
    // Draw connections manually on 2D canvas for "Stick" look
    const connections = [
        [0,1], [1,2], [2,3], [3,4], // Thumb
        [0,5], [5,6], [6,7], [7,8], // Index
        [0,9], [9,10], [10,11], [11,12], // Middle
        [0,13], [13,14], [14,15], [15,16], // Ring
        [0,17], [17,18], [18,19], [19,20], // Pinky
        [5,9], [9,13], [13,17] // Palm
    ];

    ctx.lineWidth = 2;
    
    // Draw Lines (Glowing Sticks)
    connections.forEach(([i, j]) => {
        const p1 = lm[i];
        const p2 = lm[j];
        
        ctx.beginPath();
        ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
        ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
        
        if (STATE.isPinching && (i===4 || j===4 || i===8 || j===8)) {
            ctx.strokeStyle = '#ff0088'; // Pink when pinching
            ctx.shadowBlur = 10;
            ctx.shadowColor = '#ff0088';
        } else {
            ctx.strokeStyle = '#00ff88';
            ctx.shadowBlur = 5;
            ctx.shadowColor = '#00ff88';
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
    });

    // Draw Joints (Nodes)
    lm.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x * canvas.width, p.y * canvas.height, i < 5 ? 4 : 3, 0, 2 * Math.PI);
        ctx.fillStyle = i === 8 ? '#ffffff' : '#00ff88'; // Highlight index tip
        ctx.fill();
    });
}

// --- SHAPE CREATION ---
function createMesh() {
    if (STATE.activeMesh) scene.remove(STATE.activeMesh);

    let geo;
    const mat = new THREE.MeshStandardMaterial({ 
        color: 0x0088ff, 
        roughness: 0.2, 
        metalness: 0.5,
        transparent: true, 
        opacity: 0.6,
        side: THREE.DoubleSide
    });

    switch(STATE.shapeType) {
        case 'box': geo = new THREE.BoxGeometry(0.1, 0.1, 0.1); break;
        case 'cylinder': geo = new THREE.CylinderGeometry(0.05, 0.05, 0.1, 16); break;
        case 'torus': geo = new THREE.TorusGeometry(0.05, 0.02, 8, 16); break;
        case 'octahedron': geo = new THREE.OctahedronGeometry(0.06); break;
    }

    STATE.activeMesh = new THREE.Mesh(geo, mat);
    scene.add(STATE.activeMesh);
}

function updateMesh() {
    if (!STATE.activeMesh || !STATE.startPoint || !STATE.currentPoint) return;

    const dx = Math.abs(STATE.currentPoint.x - STATE.startPoint.x);
    const dz = Math.abs(STATE.currentPoint.z - STATE.startPoint.z);
    const cx = (STATE.startPoint.x + STATE.currentPoint.x) / 2;
    const cz = (STATE.startPoint.z + STATE.currentPoint.z) / 2;

    STATE.activeMesh.position.set(cx, CONFIG.planeY, cz);

    if (STATE.shapeType === 'box' || STATE.shapeType === 'cylinder') {
        STATE.activeMesh.scale.set(dx * 10, 1, dz * 10);
    } else if (STATE.shapeType === 'torus') {
        const scale = Math.max(dx, dz) * 5;
        STATE.activeMesh.scale.set(scale, scale, scale);
    } else if (STATE.shapeType === 'octahedron') {
        STATE.activeMesh.scale.set(dx * 10, dz * 10, dx * 10);
    }
}

function finalizeMesh() {
    if (STATE.activeMesh) {
        STATE.activeMesh.material.opacity = 0.9;
        STATE.activeMesh.material.color.setHex(0x00ff88);
        STATE.activeMesh = null; // Reset reference to allow new shape
    }
}

function handleExtrusion(separation) {
    if (!STATE.activeMesh && scene.children.some(c => c.isMesh && c !== constructionPlane)) {
        // Find the last added mesh that isn't the plane
        const meshes = scene.children.filter(c => c.isMesh && c !== constructionPlane);
        const target = meshes[meshes.length - 1];
        
        STATE.mode = 'EXTRUDING';
        const height = separation * 4;
        
        // Simple scaling extrusion for demo
        target.scale.y = height;
        target.position.y = height / 2;
        target.material.color.setHex(0xff0088);
    }
}

function handleZoom(separation) {
    const targetZ = 8 - (separation * 10);
    camera.position.z += (targetZ - camera.position.z) * 0.1;
}

// --- THREE.JS SETUP ---
function initThreeJS() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);
    scene.fog = new THREE.Fog(0x111111, 5, 20);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 4, 6);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;

    // Lights
    const amb = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(amb);
    const dir = new THREE.DirectionalLight(0xffffff, 1);
    dir.position.set(5, 10, 5);
    dir.castShadow = true;
    scene.add(dir);

    // Grid
    const grid = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    scene.add(grid);

    // Invisible Plane for Raycasting
    const planeGeo = new THREE.PlaneGeometry(100, 100);
    const planeMat = new THREE.MeshBasicMaterial({ visible: false });
    constructionPlane = new THREE.Mesh(planeGeo, planeMat);
    constructionPlane.rotation.x = -Math.PI / 2;
    scene.add(constructionPlane);

    raycaster = new THREE.Raycaster();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

function renderThreeJS() {
    // Draw Motion Trail in 3D
    if (STATE.trail.length > 1) {
        // Could add a LineLoop here for 3D trail visualization
    }
    renderer.render(scene, camera);
}

// Start
init();
