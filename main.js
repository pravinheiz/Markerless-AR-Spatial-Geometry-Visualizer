import * as THREE from 'three';

/**
 * CONFIGURATION
 */
const CONFIG = {
    SMOOTHING_ALPHA: 0.3,
    PINCH_THRESHOLD: 0.05,
    COLORS: {
        LEFT: 0x007AFF,
        RIGHT: 0x34C759,
        PINCH: 0xFF9500,
        GRAB: 0xFF3B30
    }
};

/**
 * STATE MANAGEMENT
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
    fps: 0,
    fistTimer: 0
};

// DOM Elements
const videoElement = document.getElementById('webcam-video');
const handCanvas = document.getElementById('hand-canvas');
const handCtx = handCanvas.getContext('2d');
const webglCanvas = document.getElementById('webgl-canvas');
const loadingScreen = document.getElementById('loading-screen');
const loadingMsg = document.getElementById('loading-msg');
const startBtn = document.getElementById('start-btn');
const uiGesture = document.getElementById('gesture-status');
const uiMode = document.getElementById('mode-status');
const uiConfFill = document.getElementById('conf-fill');
const uiConfText = document.getElementById('conf-bar');
const crosshair = document.getElementById('crosshair');
const promptOverlay = document.getElementById('prompt-overlay');

// Three.js Globals
let scene, camera, renderer, raycaster, constructionPlane;
let clock = new THREE.Clock();
let handsMediaPipe = null;
let filters = [];

/**
 * SECTION 1: MEDIAPIPE INITIALIZATION (LEGACY CDN METHOD)
 * This method is more stable for local files than Tasks Vision
 */
function initMediaPipe() {
    loadingMsg.innerText = "Loading Neural Models...";
    
    const hands = new Hands({locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }});

    hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.7
    });

    hands.onResults(onHandsResults);
    handsMediaPipe = hands;

    loadingMsg.innerText = "Models Loaded. Ready.";
    startBtn.style.display = 'block';
}

startBtn.addEventListener('click', async () => {
    try {
        loadingMsg.innerText = "Requesting Camera...";
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
        });
        
        videoElement.srcObject = stream;
        videoElement.play();

        videoElement.onloadeddata = () => {
            loadingScreen.style.opacity = '0';
            setTimeout(() => loadingScreen.style.display = 'none', 500);
            resizeCanvases();
            
            // Start detection loop
            detectFrame();
        };
    } catch (err) {
        loadingMsg.innerText = "Camera Error: " + err.message;
        loadingMsg.style.color = "red";
        console.error(err);
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
 * SECTION 2: DETECTION LOOP
 */
async function detectFrame() {
    if (videoElement.readyState === videoElement.HAVE_ENOUGH_DATA && handsMediaPipe) {
        await handsMediaPipe.send({image: videoElement});
    }
    requestAnimationFrame(detectFrame);
}

/**
 * SECTION 3: ONE EURO FILTER (SMOOTHING)
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

/**
 * SECTION 4: HAND RESULTS PROCESSING
 */
function onHandsResults(results) {
    STATE.hands = results.multiHandLandmarks;
    STATE.gesture = 'NONE';
    let avgConf = 0;

    if (STATE.hands.length === 0) {
        STATE.mode = 'IDLE';
        STATE.selectedObject = null;
        handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
        return 0;
    }

    handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);

    STATE.hands.forEach((landmarks, idx) => {
        // Smoothing
        if (!filters[idx]) filters[idx] = Array(21).fill(null).map(() => new OneEuroFilter(30, 2.0, 0.1));
        const smoothed = landmarks.map((lm, i) => ({
            x: filters[idx][i].filter(lm.x, performance.now()),
            y: filters[idx][i].filter(lm.y, performance.now()),
            z: filters[idx][i].filter(lm.z, performance.now()),
            visibility: lm.visibility || 1.0
        }));
        STATE.smoothedLandmarks[idx] = smoothed;
        avgConf += smoothed.reduce((a, b) => a + b.visibility, 0) / 21;

        // Draw Skeleton
        drawSkeleton(smoothed, idx === 0 ? 'Left' : 'Right');

        // Gesture Logic
        const thumb = smoothed[4];
        const index = smoothed[8];
        const dist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
        
        if (dist < CONFIG.PINCH_THRESHOLD) {
            STATE.gesture = 'PINCH';
            if (STATE.mode === 'IDLE') STATE.mode = 'SELECTING';
        } else {
            STATE.gesture = 'OPEN';
            if (STATE.mode === 'DRAWING') {
                finalizeShape();
                STATE.mode = 'IDLE';
                STATE.startPoint = null;
            }
        }

        // Two Hand Extrusion
        if (STATE.hands.length === 2 && STATE.gesture === 'PINCH') {
            const h1 = smoothed[0];
            const h2 = STATE.smoothedLandmarks[1][0];
            const vDiff = Math.abs(h1.y - h2.y);
            if (vDiff > 0.15) handleExtrusion(vDiff);
        }
    });

    return avgConf / STATE.hands.length;
}

function drawSkeleton(landmarks, side) {
    if (!STATE.showSkeleton) return;
    const color = side === 'Left' ? CONFIG.COLORS.LEFT : CONFIG.COLORS.RIGHT;
    const c = new THREE.Color(color);
    
    handCtx.lineWidth = 3;
    handCtx.lineCap = 'round';
    handCtx.strokeStyle = `rgba(${c.r*255}, ${c.g*255}, ${c.b*255}, 0.6)`;
    
    const connections = [
        [0,1],[1,2],[2,3],[3,4], [0,5],[5,6],[6,7],[7,8],
        [0,9],[9,10],[10,11],[11,12], [0,13],[13,14],[14,15],[15,16],
        [0,17],[17,18],[18,19],[19,20], [5,9],[9,13],[13,17]
    ];

    handCtx.beginPath();
    connections.forEach(([i, j]) => {
        const p1 = landmarks[i];
        const p2 = landmarks[j];
        handCtx.moveTo(p1.x * window.innerWidth, p1.y * window.innerHeight);
        handCtx.lineTo(p2.x * window.innerWidth, p2.y * window.innerHeight);
    });
    handCtx.stroke();

    landmarks.forEach((lm, i) => {
        const x = lm.x * window.innerWidth;
        const y = lm.y * window.innerHeight;
        handCtx.beginPath();
        handCtx.arc(x, y, i===4||i===8 ? 8 : 5, 0, 2*Math.PI);
        handCtx.fillStyle = `rgba(${c.r*255}, ${c.g*255}, ${c.b*255}, ${lm.visibility})`;
        handCtx.fill();
        // Glow
        handCtx.shadowBlur = 15;
        handCtx.shadowColor = `rgba(${c.r*255}, ${c.g*255}, ${c.b*255}, 0.8)`;
        handCtx.stroke();
        handCtx.shadowBlur = 0;
    });
}

/**
 * SECTION 5: THREE.JS SETUP
 */
function initThreeJS() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, window.innerWidth/window.innerHeight, 0.1, 100);
    camera.position.set(0, 2, 5);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;

    const ambLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    scene.add(dirLight);

    const grid = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    grid.position.y = 0.01;
    scene.add(grid);

    const planeGeo = new THREE.PlaneGeometry(100, 100);
    const planeMat = new THREE.MeshBasicMaterial({ visible: false });
    constructionPlane = new THREE.Mesh(planeGeo, planeMat);
    constructionPlane.rotation.x = -Math.PI / 2;
    scene.add(constructionPlane);

    raycaster = new THREE.Raycaster();
    
    animate();
}

/**
 * SECTION 6: INTERACTION LOGIC
 */
function getRaycastPoint(lm) {
    if (!lm) return null;
    const ndcX = -(lm.x * 2 - 1);
    const ndcY = -(lm.y * 2 - 1);
    const mouse = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(constructionPlane);
    return intersects.length > 0 ? intersects[0].point : null;
}

function handleInteraction() {
    if (STATE.smoothedLandmarks.length === 0) return;
    const indexTip = STATE.smoothedLandmarks[0][8];
    const pt = getRaycastPoint(indexTip);

    if (pt) {
        crosshair.classList.remove('hidden');
        const vec = pt.clone().project(camera);
        crosshair.style.left = `${(vec.x * .5 + .5) * window.innerWidth}px`;
        crosshair.style.top = `${(-(vec.y * .5) + .5) * window.innerHeight}px`;
    } else {
        crosshair.classList.add('hidden');
    }

    if (STATE.gesture === 'PINCH') {
        promptOverlay.classList.remove('hidden');
        if (STATE.mode === 'SELECTING' && pt) {
            STATE.startPoint = pt;
            STATE.mode = 'DRAWING';
            createPreview();
        } else if (STATE.mode === 'DRAWING' && pt) {
            updatePreview(pt);
        }
    } else {
        promptOverlay.classList.add('hidden');
    }
}

function createPreview() {
    if (STATE.selectedObject) scene.remove(STATE.selectedObject);
    const geo = new THREE.RingGeometry(0.05, 0.08, 32);
    const mat = new THREE.MeshBasicMaterial({ color: CONFIG.COLORS.PINCH, side: THREE.DoubleSide, transparent: true, opacity: 0.8 });
    STATE.selectedObject = new THREE.Mesh(geo, mat);
    STATE.selectedObject.rotation.x = -Math.PI / 2;
    STATE.selectedObject.position.copy(STATE.startPoint);
    scene.add(STATE.selectedObject);
}

function updatePreview(curr) {
    if (!STATE.selectedObject || !STATE.startPoint) return;
    scene.remove(STATE.selectedObject);
    
    const w = Math.abs(curr.x - STATE.startPoint.x);
    const d = Math.abs(curr.z - STATE.startPoint.z);
    const cx = (STATE.startPoint.x + curr.x) / 2;
    const cz = (STATE.startPoint.z + curr.z) / 2;

    const geo = new THREE.BoxGeometry(Math.max(w, 0.1), 0.1, Math.max(d, 0.1));
    const mat = new THREE.MeshStandardMaterial({ color: CONFIG.COLORS.LEFT, roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0.6 });
    STATE.selectedObject = new THREE.Mesh(geo, mat);
    STATE.selectedObject.position.set(cx, 0.05, cz);
    STATE.selectedObject.castShadow = true;
    scene.add(STATE.selectedObject);
}

function finalizeShape() {
    if (STATE.selectedObject) {
        STATE.selectedObject.material.opacity = 1.0;
        STATE.objects.push(STATE.selectedObject);
        STATE.selectedObject = null;
    }
}

function handleExtrusion(sep) {
    if (STATE.objects.length === 0) return;
    const obj = STATE.objects[STATE.objects.length - 1];
    const scale = 1 + (sep * 4);
    obj.scale.y = THREE.MathUtils.lerp(obj.scale.y, scale, 0.1);
    obj.position.y = obj.scale.y / 2;
    obj.material.color.setHex(CONFIG.COLORS.RIGHT);
}

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    STATE.fps = Math.round(1/delta);
    document.getElementById('fps-counter').innerText = STATE.fps;

    // UI Updates
    uiGesture.innerText = STATE.gesture;
    uiMode.innerText = `Mode: ${STATE.mode}`;
    uiGesture.style.color = STATE.gesture === 'PINCH' ? '#FF9500' : '#34C759';
    
    // Simple confidence mockup based on hand presence
    const conf = STATE.hands.length > 0 ? 0.9 : 0.0;
    uiConfFill.style.width = `${conf * 100}%`;
    uiConfText.innerText = `${Math.round(conf*100)}%`;

    handleInteraction();
    renderer.render(scene, camera);
}

// Controls
document.getElementById('reset-scene').addEventListener('click', () => {
    STATE.objects.forEach(o => { scene.remove(o); o.geometry.dispose(); o.material.dispose(); });
    STATE.objects = [];
});
document.getElementById('toggle-skeleton').addEventListener('click', (e) => {
    STATE.showSkeleton = !STATE.showSkeleton;
    e.target.innerText = STATE.showSkeleton ? "Hide Skeleton" : "Show Skeleton";
});

// Bootstrap
initMediaPipe();
initThreeJS();
