import * as THREE from 'three';

// --- CONFIGURATION ---
const CONFIG = {
    SMOOTHING_ALPHA: 0.3,
    PINCH_THRESHOLD: 0.05,
    GRAB_THRESHOLD: 0.15,
    COLORS: {
        LEFT: 0x007AFF,
        RIGHT: 0x34C759,
        PINCH: 0xFF9500,
        GRAB: 0xFF3B30,
        OBJECT: 0x00FF88
    }
};

// --- STATE ---
const STATE = {
    mode: 'IDLE', // IDLE, DRAWING, ROTATING, ZOOMING, EXTRUDING
    gesture: 'NONE',
    hands: [],
    smoothed: [],
    objects: [],
    selectedObject: null,
    startPoint: null,
    initialDist: 0,
    fistStart: 0,
    showSkeleton: true
};

// --- DOM ELEMENTS ---
const videoElement = document.getElementById('input-video');
const canvasElement = document.getElementById('output-canvas');
const canvasCtx = canvasElement.getContext('2d');
const webglCanvas = document.getElementById('webgl-canvas');
const uiGesture = document.getElementById('gesture-status');
const uiMode = document.getElementById('mode-status');
const uiConfFill = document.getElementById('conf-fill');
const uiConfText = document.getElementById('conf-text');
const crosshair = document.getElementById('crosshair');
const prompt = document.getElementById('prompt-overlay');
const loadingScreen = document.getElementById('loading-screen');

// --- THREE.JS GLOBALS ---
let scene, camera, renderer, raycaster, planeMesh;
let clock = new THREE.Clock();

// --- SECTION 1: MEDIAPIPE SETUP (LEGACY API) ---
function initMediaPipe() {
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

    // Use Camera Utility from Legacy API
    const cameraUtils = new Camera(videoElement, {
        onFrame: async () => {
            await hands.send({image: videoElement});
        },
        width: 1280,
        height: 720
    });

    cameraUtils.start()
        .then(() => {
            console.log("Camera started");
            loadingScreen.style.opacity = '0';
            setTimeout(() => loadingScreen.style.display = 'none', 500);
        })
        .catch(err => {
            console.error("Camera Error:", err);
            alert("Camera access failed. Please check permissions.");
        });
}

// --- SECTION 2: SMOOTHING (One Euro Filter Simplified) ---
class SimpleFilter {
    constructor(alpha) { this.alpha = alpha; this.prev = null; }
    update(val) {
        if (this.prev === null) { this.prev = val; return val; }
        const res = this.alpha * val + (1 - this.alpha) * this.prev;
        this.prev = res;
        return res;
    }
}
const filters = []; // Will hold filters for each landmark

// --- SECTION 3: GESTURE LOGIC ---
function onHandsResults(results) {
    // Resize canvas
    canvasElement.width = window.innerWidth;
    canvasElement.height = window.innerHeight;
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    STATE.hands = results.multiHandLandmarks || [];
    STATE.gesture = 'NONE';
    let avgConf = 0;

    if (STATE.hands.length === 0) {
        STATE.mode = 'IDLE';
        STATE.selectedObject = null;
        return;
    }

    // Process Hands
    STATE.hands.forEach((landmarks, idx) => {
        if (!filters[idx]) filters[idx] = Array(21).fill(null).map(() => new SimpleFilter(CONFIG.SMOOTHING_ALPHA));
        
        // Smooth landmarks
        const smoothLm = landmarks.map((lm, i) => ({
            x: filters[idx][i].update(lm.x),
            y: filters[idx][i].update(lm.y),
            z: filters[idx][i].update(lm.z)
        }));
        STATE.smoothed[idx] = smoothLm;
        avgConf += 1; // Simplified confidence

        // Draw Skeleton
        if (STATE.showSkeleton) {
            drawSkeleton(smoothLm, idx === 0 ? CONFIG.COLORS.LEFT : CONFIG.COLORS.RIGHT);
        }

        // Gesture Detection
        const thumb = smoothLm[4];
        const index = smoothLm[8];
        const dist = Math.hypot(thumb.x - index.x, thumb.y - index.y);

        if (dist < CONFIG.PINCH_THRESHOLD) {
            STATE.gesture = 'PINCH';
        } else {
            // Check for Grab (fingers curled) - simplified check
            const middleTip = smoothLm[12];
            const wrist = smoothLm[0];
            if (Math.hypot(middleTip.x - wrist.x, middleTip.y - wrist.y) < 0.3) {
                STATE.gesture = 'GRAB';
            } else {
                STATE.gesture = 'OPEN';
            }
        }

        // Two Hand Logic
        if (STATE.hands.length === 2 && STATE.gesture === 'PINCH') {
            const h1 = STATE.smoothed[0][0]; // Wrist 1
            const h2 = STATE.smoothed[1][0]; // Wrist 2
            const d = Math.hypot(h1.x - h2.x, h1.y - h2.y);
            
            if (STATE.initialDist === 0) STATE.initialDist = d;
            
            const ratio = d / STATE.initialDist;
            
            // Vertical Separation -> Extrude
            if (Math.abs(h1.y - h2.y) > 0.25) {
                STATE.mode = 'EXTRUDING';
                handleExtrusion(Math.abs(h1.y - h2.y));
            } 
            // Horizontal Spread -> Zoom
            else if (Math.abs(h1.x - h2.x) > 0.15) {
                STATE.mode = 'ZOOMING';
                handleZoom(ratio);
            }
        } else {
            STATE.initialDist = 0;
            if (STATE.mode === 'ZOOMING' || STATE.mode === 'EXTRUDING') STATE.mode = 'IDLE';
        }
    });

    updateUI(avgConf / STATE.hands.length);
    handleInteraction();
}

function drawSkeleton(landmarks, color) {
    const connections = [
        [0,1],[1,2],[2,3],[3,4], [0,5],[5,6],[6,7],[7,8],
        [0,9],[9,10],[10,11],[11,12], [0,13],[13,14],[14,15],[15,16],
        [0,17],[17,18],[18,19],[19,20], [5,9],[9,13],[13,17]
    ];
    
    canvasCtx.strokeStyle = `rgba(${new THREE.Color(color).r*255}, ${new THREE.Color(color).g*255}, ${new THREE.Color(color).b*255}, 0.6)`;
    canvasCtx.lineWidth = 3;
    canvasCtx.lineCap = 'round';

    connections.forEach(([i, j]) => {
        const p1 = landmarks[i];
        const p2 = landmarks[j];
        canvasCtx.beginPath();
        canvasCtx.moveTo(p1.x * canvasElement.width, p1.y * canvasElement.height);
        canvasCtx.lineTo(p2.x * canvasElement.width, p2.y * canvasElement.height);
        canvasCtx.stroke();
    });

    landmarks.forEach((lm, i) => {
        canvasCtx.beginPath();
        canvasCtx.arc(lm.x * canvasElement.width, lm.y * canvasElement.height, (i===4||i===8)?8:5, 0, 2*Math.PI);
        canvasCtx.fillStyle = `rgba(${new THREE.Color(color).r*255}, ${new THREE.Color(color).g*255}, ${new THREE.Color(color).b*255}, 0.9)`;
        canvasCtx.fill();
    });
}

// --- SECTION 4: INTERACTION & MATH ---
function getRaycastPoint(lm) {
    if (!lm) return null;
    const ndcX = -(lm.x * 2 - 1);
    const ndcY = -(lm.y * 2 - 1);
    const mouse = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(planeMesh);
    return intersects.length > 0 ? intersects[0].point : null;
}

function handleInteraction() {
    const hand = STATE.smoothed[0];
    if (!hand) return;
    const indexTip = hand[8];
    const worldPt = getRaycastPoint(indexTip);

    // Crosshair
    if (worldPt && STATE.showSkeleton) {
        crosshair.classList.remove('hidden');
        const vec = worldPt.clone().project(camera);
        crosshair.style.left = `${(vec.x * .5 + .5) * window.innerWidth}px`;
        crosshair.style.top = `${(-(vec.y * .5) + .5) * window.innerHeight}px`;
    } else {
        crosshair.classList.add('hidden');
    }

    // Pinch Logic
    if (STATE.gesture === 'PINCH') {
        prompt.classList.remove('hidden');
        if (STATE.mode === 'IDLE' && worldPt) {
            STATE.mode = 'DRAWING';
            STATE.startPoint = worldPt;
            createPreview();
        } else if (STATE.mode === 'DRAWING' && worldPt) {
            updatePreview(worldPt);
        } else if (STATE.mode === 'ROTATING' && STATE.selectedObject && worldPt) {
            // Rotate object based on hand X movement
            const delta = worldPt.x - STATE.lastPt.x;
            STATE.selectedObject.rotation.y += delta * 2;
        }
        STATE.lastPt = worldPt;
    } else {
        prompt.classList.add('hidden');
        if (STATE.mode === 'DRAWING') {
            finalizeShape();
            STATE.mode = 'IDLE';
            STATE.startPoint = null;
            STATE.selectedObject = null;
        }
        if (STATE.mode === 'ROTATING') {
            STATE.mode = 'IDLE';
            STATE.selectedObject = null;
        }
    }

    // Grab Logic (Rotate)
    if (STATE.gesture === 'GRAB' && STATE.objects.length > 0) {
        // Find closest object
        // Simplified: Just grab the last one for demo
        STATE.selectedObject = STATE.objects[STATE.objects.length - 1];
        STATE.mode = 'ROTATING';
        uiGesture.innerText = "ROTATING";
        uiGesture.style.color = "#FF3B30";
    }
}

function createPreview() {
    if (STATE.selectedObject) scene.remove(STATE.selectedObject);
    const geo = new THREE.RingGeometry(0.05, 0.08, 32);
    const mat = new THREE.MeshBasicMaterial({ color: CONFIG.COLORS.PINCH, side: THREE.DoubleSide, transparent: true, opacity: 0.8 });
    STATE.selectedObject = new THREE.Mesh(geo, mat);
    STATE.selectedObject.rotation.x = -Math.PI/2;
    STATE.selectedObject.position.copy(STATE.startPoint);
    scene.add(STATE.selectedObject);
}

function updatePreview(pt) {
    if (!STATE.selectedObject || !STATE.startPoint) return;
    scene.remove(STATE.selectedObject);
    
    const w = Math.abs(pt.x - STATE.startPoint.x);
    const d = Math.abs(pt.z - STATE.startPoint.z);
    const cx = (STATE.startPoint.x + pt.x) / 2;
    const cz = (STATE.startPoint.z + pt.z) / 2;

    const geo = new THREE.BoxGeometry(w, 0.1, d);
    const mat = new THREE.MeshStandardMaterial({ color: CONFIG.COLORS.OBJECT, roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0.6 });
    STATE.selectedObject = new THREE.Mesh(geo, mat);
    STATE.selectedObject.position.set(cx, 0.05, cz);
    scene.add(STATE.selectedObject);
}

function finalizeShape() {
    if (STATE.selectedObject) {
        STATE.selectedObject.material.opacity = 1.0;
        STATE.selectedObject.material.color.setHex(CONFIG.COLORS.LEFT);
        STATE.objects.push(STATE.selectedObject);
        STATE.selectedObject = null;
    }
}

function handleExtrusion(sep) {
    if (STATE.objects.length === 0) return;
    const obj = STATE.objects[STATE.objects.length - 1];
    const h = 1 + (sep * 4);
    obj.scale.y = h;
    obj.position.y = h / 2;
    obj.material.color.setHex(CONFIG.COLORS.RIGHT);
}

function handleZoom(ratio) {
    const targetFOV = 45 / ratio;
    camera.fov += (targetFOV - camera.fov) * 0.1;
    camera.updateProjectionMatrix();
}

function updateUI(conf) {
    uiGesture.innerText = STATE.gesture;
    uiMode.innerText = `Mode: ${STATE.mode}`;
    
    if (STATE.mode === 'ZOOMING') uiGesture.innerText = "ZOOMING";
    if (STATE.mode === 'EXTRUDING') uiGesture.innerText = "EXTRUDING";
    
    const pct = Math.min(100, conf * 100);
    uiConfFill.style.width = `${pct}%`;
    uiConfText.innerText = `${Math.round(pct)}%`;
}

// --- SECTION 5: INIT THREE.JS ---
function initThree() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, window.innerWidth/window.innerHeight, 0.1, 100);
    camera.position.set(0, 3, 6);
    camera.lookAt(0,0,0);

    renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0); // Transparent!

    // Lights
    const amb = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(amb);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 5);
    scene.add(dir);

    // Grid
    const grid = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    scene.add(grid);

    // Raycast Plane
    const geo = new THREE.PlaneGeometry(100, 100);
    const mat = new THREE.MeshBasicMaterial({ visible: false });
    planeMesh = new THREE.Mesh(geo, mat);
    planeMesh.rotation.x = -Math.PI/2;
    scene.add(planeMesh);

    raycaster = new THREE.Raycaster();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

// Buttons
document.getElementById('toggle-skeleton').onclick = (e) => {
    STATE.showSkeleton = !STATE.showSkeleton;
    e.target.innerText = STATE.showSkeleton ? "Hide Skeleton" : "Show Skeleton";
};
document.getElementById('reset-scene').onclick = () => {
    STATE.objects.forEach(o => scene.remove(o));
    STATE.objects = [];
};

// Loop
function animate() {
    requestAnimationFrame(animate);
    document.getElementById('fps-counter').innerText = Math.round(1/clock.getDelta());
    renderer.render(scene, camera);
}

// Start
initThree();
initMediaPipe();
animate();
