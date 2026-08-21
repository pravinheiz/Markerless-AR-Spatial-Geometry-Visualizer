import * as THREE from 'three';

/**
 * CONFIGURATION CONSTANTS
 */
const CONFIG = {
    SMOOTHING_ALPHA: 0.3,
    MIN_CONFIDENCE: 0.5,
    PINCH_THRESHOLD: 0.05,
    COLORS: {
        LEFT_HAND: 0x007AFF,
        RIGHT_HAND: 0x34C759,
        PINCH_ACTIVE: 0xFF9500,
        OBJECT_SELECTED: 0x00FF88
    }
};

/**
 * GLOBAL STATE
 */
const STATE = {
    mode: 'IDLE',
    gesture: 'NONE',
    hands: [],
    smoothedLandmarks: [],
    objects: [],
    selectedObject: null,
    startPoint: null,
    showSkeleton: true,
    fps: 0
};

// DOM Elements
const videoElement = document.getElementById('webcam-video');
const handCanvas = document.getElementById('hand-canvas');
const handCtx = handCanvas.getContext('2d');
const webglCanvas = document.getElementById('webgl-canvas');
const loadingScreen = document.getElementById('loading-screen');
const enableBtn = document.getElementById('enable-camera-btn');
const uiGesture = document.getElementById('gesture-status');
const uiMode = document.getElementById('mode-status');
const uiConf = document.getElementById('conf-fill');
const uiConfText = document.getElementById('conf-bar');
const crosshair = document.getElementById('crosshair');
const promptOverlay = document.getElementById('prompt-overlay');

// Three.js Globals
let scene, camera, renderer, raycaster, constructionPlane;
let clock = new THREE.Clock();

/**
 * SECTION 1: MEDIAPIPE SETUP (ROBUST VERSION)
 */
let handLandmarker = undefined;
let lastVideoTime = -1;

async function initMediaPipe() {
    const statusText = loadingScreen.querySelector('h2');
    const subText = loadingScreen.querySelector('p');

    try {
        statusText.innerText = "Loading Vision Tasks...";
        
        // Check if FilesetResolver is available
        if (typeof FilesetResolver === 'undefined') {
            throw new Error("MediaPipe Tasks Vision library not loaded. Check internet connection.");
        }

        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );

        statusText.innerText = "Initializing Hand Landmarker...";
        
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
                delegate: "CPU" // Force CPU for better compatibility in some browsers
            },
            runningMode: "VIDEO",
            numHands: 2
        });

        console.log("✅ MediaPipe Hand Landmarker loaded successfully.");
        statusText.innerText = "Camera Required";
        subText.innerText = "Click below to start the AR experience.";
        enableBtn.style.display = 'block';

    } catch (error) {
        console.error("❌ MediaPipe Initialization Error:", error);
        statusText.innerText = "Error Loading Models";
        subText.innerText = "Check console (F12) for details. Ensure ad-blockers are off.";
        subText.style.color = "#ff3b30";
    }
}

enableBtn.addEventListener('click', async () => {
    try {
        enableBtn.disabled = true;
        enableBtn.innerText = "Requesting Camera...";
        
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { 
                width: { ideal: 1280 }, 
                height: { ideal: 720 }, 
                facingMode: 'user' 
            }
        });
        
        videoElement.srcObject = stream;
        
        // Wait for video to actually play
        await videoElement.play();
        
        console.log("✅ Camera started successfully.");
        
        loadingScreen.style.opacity = '0';
        setTimeout(() => {
            loadingScreen.style.display = 'none';
            resizeCanvases();
            animate();
        }, 500);

    } catch (err) {
        console.error("❌ Camera Error:", err);
        alert("Camera access denied or not available.\n\nError: " + err.message);
        enableBtn.disabled = false;
        enableBtn.innerText = "Enable Camera";
    }
});

function resizeCanvases() {
    handCanvas.width = window.innerWidth;
    handCanvas.height = window.innerHeight;
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
}

window.addEventListener('resize', resizeCanvases);

/**
 * SECTION 2: ONE EURO FILTER
 */
class OneEuroFilter {
    constructor(freq, minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
        this.freq = freq;
        this.minCutoff = minCutoff;
        this.beta = beta;
        this.dCutoff = dCutoff;
        this.x = null;
        this.dx = null;
        this.lastTime = null;
    }

    filter(value, timestamp) {
        if (this.lastTime === null) {
            this.lastTime = timestamp;
            this.x = value;
            this.dx = 0;
            return value;
        }
        const te = (timestamp - this.lastTime) / 1000.0;
        if (te <= 0) return value;
        const freq = 1.0 / te;
        const mdx = this.alpha(this.dCutoff, freq);
        const dx = (value - this.x) / te;
        const edx = this.smooth(dx, this.dx, mdx);
        const cutoff = this.minCutoff + this.beta * Math.abs(edx);
        const alpha = this.alpha(cutoff, freq);
        this.x = this.smooth(value, this.x, alpha);
        this.dx = edx;
        this.lastTime = timestamp;
        return this.x;
    }

    alpha(cutoff, freq) {
        const te = 1.0 / freq;
        const tau = 1.0 / (2 * Math.PI * cutoff);
        return 1.0 / (1.0 + tau / te);
    }

    smooth(value, prev, alpha) {
        return alpha * value + (1.0 - alpha) * prev;
    }
}

const filters = []; 

/**
 * SECTION 3: GESTURE RECOGNITION
 */
function detectGestures(results) {
    STATE.hands = results.landmarks;
    STATE.gesture = 'NONE';
    let avgConfidence = 0;

    if (STATE.hands.length === 0) {
        STATE.mode = 'IDLE';
        STATE.selectedObject = null;
        return 0;
    }

    STATE.hands.forEach((landmarks, handIndex) => {
        if (!filters[handIndex]) filters[handIndex] = Array(21).fill(null).map(() => new OneEuroFilter(30, 2.0, 0.1));
        
        const smoothed = landmarks.map((lm, i) => {
            const ts = performance.now();
            return {
                x: filters[handIndex][i].filter(lm.x, ts),
                y: filters[handIndex][i].filter(lm.y, ts),
                z: filters[handIndex][i].filter(lm.z, ts),
                visibility: lm.visibility || 1.0
            };
        });
        
        STATE.smoothedLandmarks[handIndex] = smoothed;
        avgConfidence += smoothed.reduce((acc, lm) => acc + lm.visibility, 0) / 21;

        const thumbTip = smoothed[4];
        const indexTip = smoothed[8];
        const pinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);

        if (pinchDist < CONFIG.PINCH_THRESHOLD) {
            STATE.gesture = 'PINCH';
            if (STATE.mode === 'IDLE') STATE.mode = 'SELECTING';
        } else {
            STATE.gesture = 'OPEN';
        }

        // Two Hand Logic
        if (STATE.hands.length === 2 && STATE.gesture === 'PINCH') {
             const h1 = STATE.smoothedLandmarks[0][0];
             const h2 = STATE.smoothedLandmarks[1][0];
             const dist = Math.hypot(h1.x - h2.x, h1.y - h2.y);
             
             if (Math.abs(h1.y - h2.y) > 0.2) {
                 STATE.mode = 'EXTRUDING';
                 handleExtrusion(Math.abs(h1.y - h2.y));
             } else {
                 STATE.mode = 'ZOOMING';
                 handleZoom(dist);
             }
        }
    });

    return avgConfidence / STATE.hands.length;
}

/**
 * SECTION 4: THREE.JS SCENE
 */
function initThreeJS() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 2, 6);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    scene.add(dirLight);

    const gridHelper = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    gridHelper.position.y = 0.01;
    scene.add(gridHelper);

    const planeGeo = new THREE.PlaneGeometry(100, 100);
    const planeMat = new THREE.MeshBasicMaterial({ visible: false });
    constructionPlane = new THREE.Mesh(planeGeo, planeMat);
    constructionPlane.rotation.x = -Math.PI / 2;
    scene.add(constructionPlane);

    raycaster = new THREE.Raycaster();
}

/**
 * SECTION 5: RAYCASTING
 */
function getRaycastPoint(landmark) {
    if (!landmark) return null;
    const ndcX = -(landmark.x * 2 - 1); 
    const ndcY = -(landmark.y * 2 - 1);
    const mouse = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(constructionPlane);
    if (intersects.length > 0) return intersects[0].point;
    return null;
}

/**
 * SECTION 6: INTERACTION
 */
function handleInteraction() {
    const primaryHand = STATE.smoothedLandmarks[0];
    if (!primaryHand) return;

    const indexTip = primaryHand[8];
    const worldPoint = getRaycastPoint(indexTip);

    if (worldPoint && STATE.showSkeleton) {
        crosshair.classList.remove('hidden');
        const vec = worldPoint.clone();
        vec.project(camera);
        const x = (vec.x * .5 + .5) * window.innerWidth;
        const y = (-(vec.y * .5) + .5) * window.innerHeight;
        crosshair.style.left = `${x}px`;
        crosshair.style.top = `${y}px`;
    } else {
        crosshair.classList.add('hidden');
    }

    if (STATE.gesture === 'PINCH') {
        promptOverlay.classList.remove('hidden');
        if (STATE.mode === 'SELECTING' && worldPoint) {
            STATE.startPoint = worldPoint;
            STATE.mode = 'DRAWING';
            createShapePreview();
        } else if (STATE.mode === 'DRAWING' && worldPoint) {
            updateShapePreview(worldPoint);
        }
    } else {
        promptOverlay.classList.add('hidden');
        if (STATE.mode === 'DRAWING') {
            finalizeShape();
            STATE.mode = 'IDLE';
            STATE.startPoint = null;
        }
    }
}

function createShapePreview() {
    if (STATE.selectedObject) scene.remove(STATE.selectedObject);
    const geometry = new THREE.RingGeometry(0.05, 0.08, 32);
    const material = new THREE.MeshBasicMaterial({ color: CONFIG.COLORS.PINCH_ACTIVE, side: THREE.DoubleSide, transparent: true, opacity: 0.8 });
    STATE.selectedObject = new THREE.Mesh(geometry, material);
    STATE.selectedObject.rotation.x = -Math.PI / 2;
    STATE.selectedObject.position.copy(STATE.startPoint);
    scene.add(STATE.selectedObject);
}

function updateShapePreview(currentPoint) {
    if (!STATE.selectedObject || !STATE.startPoint) return;
    scene.remove(STATE.selectedObject);

    const width = Math.abs(currentPoint.x - STATE.startPoint.x);
    const depth = Math.abs(currentPoint.z - STATE.startPoint.z);
    const centerX = (STATE.startPoint.x + currentPoint.x) / 2;
    const centerZ = (STATE.startPoint.z + currentPoint.z) / 2;

    const geometry = new THREE.BoxGeometry(Math.max(width, 0.1), 0.1, Math.max(depth, 0.1));
    const material = new THREE.MeshStandardMaterial({ color: CONFIG.COLORS.OBJECT_SELECTED, roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0.6 });
    STATE.selectedObject = new THREE.Mesh(geometry, material);
    STATE.selectedObject.position.set(centerX, 0.05, centerZ);
    STATE.selectedObject.castShadow = true;
    scene.add(STATE.selectedObject);
}

function finalizeShape() {
    if (STATE.selectedObject) {
        STATE.selectedObject.material.opacity = 1.0;
        STATE.selectedObject.material.color.setHex(CONFIG.COLORS.LEFT_HAND);
        STATE.objects.push(STATE.selectedObject);
        STATE.selectedObject = null;
    }
}

function handleExtrusion(separation) {
    if (!STATE.objects.length) return;
    const lastObj = STATE.objects[STATE.objects.length - 1];
    const targetScale = 1 + (separation * 5);
    lastObj.scale.y = THREE.MathUtils.lerp(lastObj.scale.y, targetScale, 0.1);
    lastObj.position.y = lastObj.scale.y / 2;
    lastObj.material.color.setHex(CONFIG.COLORS.RIGHT_HAND);
}

function handleZoom(dist) {
    if (STATE.initialTwoHandDist === 0) STATE.initialTwoHandDist = dist;
    const scale = dist / STATE.initialTwoHandDist;
    const targetFOV = 45 / scale;
    camera.fov = THREE.MathUtils.lerp(camera.fov, targetFOV, 0.05);
    camera.updateProjectionMatrix();
}

document.getElementById('reset-scene').addEventListener('click', () => {
    STATE.objects.forEach(obj => {
        scene.remove(obj);
        obj.geometry.dispose();
        obj.material.dispose();
    });
    STATE.objects = [];
});

document.getElementById('toggle-skeleton').addEventListener('click', (e) => {
    STATE.showSkeleton = !STATE.showSkeleton;
    e.target.innerText = STATE.showSkeleton ? "Hide Skeleton" : "Show Skeleton";
});

/**
 * SECTION 7: DRAW SKELETON
 */
function drawHandSkeleton(landmarks, handedness) {
    if (!STATE.showSkeleton) return;
    const color = handedness === 'Left' ? CONFIG.COLORS.LEFT_HAND : CONFIG.COLORS.RIGHT_HAND;
    const hexColor = new THREE.Color(color);
    
    handCtx.lineWidth = 2;
    handCtx.lineCap = 'round';
    handCtx.lineJoin = 'round';

    const connections = [
        [0,1], [1,2], [2,3], [3,4], [0,5], [5,6], [6,7], [7,8],
        [0,9], [9,10], [10,11], [11,12], [0,13], [13,14], [14,15], [15,16],
        [0,17], [17,18], [18,19], [19,20], [5,9], [9,13], [13,17]
    ];

    handCtx.beginPath();
    connections.forEach(([i, j]) => {
        const p1 = landmarks[i];
        const p2 = landmarks[j];
        const x1 = p1.x * window.innerWidth;
        const y1 = p1.y * window.innerHeight;
        const x2 = p2.x * window.innerWidth;
        const y2 = p2.y * window.innerHeight;
        handCtx.moveTo(x1, y1);
        handCtx.lineTo(x2, y2);
    });
    
    handCtx.strokeStyle = `rgba(${hexColor.r*255}, ${hexColor.g*255}, ${hexColor.b*255}, 0.6)`;
    handCtx.stroke();

    landmarks.forEach((lm, i) => {
        const x = lm.x * window.innerWidth;
        const y = lm.y * window.innerHeight;
        const radius = (i === 4 || i === 8) ? 6 : 4;
        handCtx.beginPath();
        handCtx.arc(x, y, radius, 0, 2 * Math.PI);
        handCtx.fillStyle = `rgba(${hexColor.r*255}, ${hexColor.g*255}, ${hexColor.b*255}, ${lm.visibility})`;
        handCtx.fill();
        handCtx.shadowBlur = 10;
        handCtx.shadowColor = `rgba(${hexColor.r*255}, ${hexColor.g*255}, ${hexColor.b*255}, 0.8)`;
        handCtx.stroke();
        handCtx.shadowBlur = 0;
    });
}

/**
 * SECTION 8: UI UPDATES
 */
function updateUI(confidence) {
    uiGesture.innerText = STATE.gesture;
    uiMode.innerText = `Mode: ${STATE.mode}`;
    if (STATE.gesture === 'PINCH') uiGesture.style.color = '#FF9500';
    else uiGesture.style.color = '#34C759';
    const confPct = Math.round(confidence * 100);
    uiConf.style.width = `${confPct}%`;
    uiConfText.innerText = `${confPct}%`;
}

/**
 * SECTION 9: ANIMATION LOOP
 */
function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const delta = clock.getDelta();
    STATE.fps = Math.round(1 / delta);
    document.getElementById('fps-counter').innerText = STATE.fps;

    if (videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
        if (now - lastVideoTime >= 1000 / 30) {
            lastVideoTime = now;
            if (handLandmarker) {
                try {
                    const results = handLandmarker.detectForVideo(videoElement, now);
                    const confidence = detectGestures(results);
                    handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
                    results.landmarks.forEach((lm, idx) => {
                        const handedness = results.handednesses[idx]?.categoryName || 'Right';
                        drawHandSkeleton(lm, handedness);
                    });
                    handleInteraction();
                    updateUI(confidence);
                } catch (e) {
                    console.warn("Detection error:", e);
                }
            }
        }
    }
    renderer.render(scene, camera);
}

// Start
console.log("Starting initialization...");
initMediaPipe();
initThreeJS();
