import * as THREE from 'three';

/**
 * CONFIGURATION CONSTANTS
 */
const CONFIG = {
    SMOOTHING_ALPHA: 0.3,
    MIN_CONFIDENCE: 0.5,
    PINCH_THRESHOLD: 0.05,
    GRAB_THRESHOLD: 0.15,
    ROTATION_SENSITIVITY: 0.05, // Sensitivity for wrist twist
    ZOOM_SENSITIVITY: 0.002,
    COLORS: {
        LEFT_HAND: 0x007AFF,
        RIGHT_HAND: 0x34C759,
        PINCH_ACTIVE: 0xFF9500,
        GRAB_ACTIVE: 0xFF3B30,
        OBJECT_SELECTED: 0x00FF88,
        OBJECT_ROTATING: 0xFFFFFF
    }
};

/**
 * GLOBAL STATE
 */
const STATE = {
    mode: 'IDLE',           // IDLE, DRAWING, MANIPULATING, ROTATING, ZOOMING, EXTRUDING
    gesture: 'NONE',
    hands: [],
    smoothedLandmarks: [],
    objects: [],
    selectedObject: null,
    startPoint: null,
    initialTwoHandDist: 0,
    lastZoomDist: 0,
    fistStartTime: 0,
    showSkeleton: true,
    fps: 0,
    // For Rotation Logic
    lastWristAngle: 0,
    isRotating: false
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
const fpsCounter = document.getElementById('fps-counter');

// Three.js Globals
let scene, camera, renderer, raycaster, constructionPlane;
let clock = new THREE.Clock();

/**
 * SECTION 1: MEDIAPIPE SETUP (Legacy CDN for Stability)
 */
let handLandmarker = undefined;
let lastVideoTime = -1;

async function initMediaPipe() {
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
        console.log("MediaPipe Loaded");
        loadingScreen.querySelector('h2').innerText = "Camera Required";
        loadingScreen.querySelector('p').innerText = "Click to Enable AR";
        enableBtn.style.display = 'block';
    } catch (e) {
        console.error("MP Load Error:", e);
        loadingScreen.querySelector('h2').innerText = "Load Error";
        loadingScreen.querySelector('p').innerText = "Check Internet / AdBlocker";
        enableBtn.style.display = 'none';
    }
}

enableBtn.addEventListener('click', async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
        });
        videoElement.srcObject = stream;
        videoElement.play();
        videoElement.onloadeddata = () => {
            loadingScreen.style.opacity = '0';
            setTimeout(() => loadingScreen.style.display = 'none', 500);
            resizeCanvases();
            animate();
        };
    } catch (err) {
        alert("Camera access denied.");
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
        this.freq = freq; this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
        this.x = null; this.dx = null; this.lastTime = null;
    }
    filter(value, timestamp) {
        if (this.lastTime === null) { this.lastTime = timestamp; this.x = value; this.dx = 0; return value; }
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
    smooth(value, prev, alpha) { return alpha * value + (1.0 - alpha) * prev; }
}
const filters = [];

/**
 * SECTION 3: GESTURE & MATH LOGIC
 */
function detectGestures(results) {
    STATE.hands = results.landmarks;
    STATE.gesture = 'NONE';
    let avgConfidence = 0;

    if (STATE.hands.length === 0) {
        STATE.mode = 'IDLE';
        STATE.isRotating = false;
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
        const middleTip = smoothed[12];
        const ringTip = smoothed[16];
        const pinkyTip = smoothed[20];
        const wrist = smoothed[0];

        const pinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
        
        // Check Finger Extension
        const isFingerExtended = (tip, wrist, pip) => {
            return Math.hypot(tip.x - wrist.x, tip.y - wrist.y) > Math.hypot(pip.x - wrist.x, pip.y - wrist.y) * 1.2;
        };
        const fingersExtended = [
            isFingerExtended(indexTip, wrist, smoothed[6]),
            isFingerExtended(middleTip, wrist, smoothed[10]),
            isFingerExtended(ringTip, wrist, smoothed[14]),
            isFingerExtended(pinkyTip, wrist, smoothed[18])
        ].filter(Boolean).length;

        // Basic Gesture State
        if (pinchDist < CONFIG.PINCH_THRESHOLD) {
            STATE.gesture = 'PINCH';
            if (STATE.mode === 'IDLE') STATE.mode = 'SELECTING';
        } else if (fingersExtended === 0 && pinchDist > 0.1) {
            if (STATE.fistStartTime === 0) STATE.fistStartTime = Date.now();
            else if (Date.now() - STATE.fistStartTime > 1000) {
                STATE.gesture = 'FIST_HOLD';
                undoLastAction();
                STATE.fistStartTime = 0;
            }
        } else {
            STATE.fistStartTime = 0;
            if (fingersExtended === 4) STATE.gesture = 'OPEN_PALM';
            else STATE.gesture = 'GRAB';
        }

        // TWO HAND LOGIC (Zoom & Extrude)
        if (STATE.hands.length === 2) {
            const h1 = STATE.smoothedLandmarks[0][0]; 
            const h2 = STATE.smoothedLandmarks[1][0]; 
            const dist = Math.hypot(h1.x - h2.x, h1.y - h2.y);
            
            // Check if both are pinching
            const h2Thumb = STATE.smoothedLandmarks[1][4];
            const h2Index = STATE.smoothedLandmarks[1][8];
            const h2Pinch = Math.hypot(h2Thumb.x - h2Index.x, h2Thumb.y - h2Index.y) < CONFIG.PINCH_THRESHOLD;

            if (STATE.gesture === 'PINCH' && h2Pinch) {
                STATE.gesture = 'TWO_HAND_PINCH';
                
                // Vertical Separation -> Extrude
                if (Math.abs(h1.y - h2.y) > 0.2) {
                    STATE.mode = 'EXTRUDING';
                    handleExtrusion(Math.abs(h1.y - h2.y));
                } 
                // Horizontal Spread -> Zoom
                else {
                    STATE.mode = 'ZOOMING';
                    handleZoom(dist);
                }
            }
        }
        
        // ROTATION LOGIC (Single Hand Grab + Wrist Twist)
        if (STATE.gesture === 'GRAB' && STATE.selectedObject) {
            STATE.mode = 'ROTATING';
            STATE.isRotating = true;
            
            // Calculate Wrist Angle relative to vertical
            // Vector from Wrist (0) to Middle Finger MCP (9) or Index MCP (5)
            const vecX = smoothed[5].x - wrist.x;
            const vecY = smoothed[5].y - wrist.y;
            
            // Angle in radians (-PI to PI)
            const currentAngle = Math.atan2(vecY, vecX);
            
            if (STATE.lastWristAngle !== 0) {
                let angleDiff = currentAngle - STATE.lastWristAngle;
                
                // Handle wrap-around (e.g., -3.14 to 3.14)
                if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
                
                // Apply Rotation to Object
                // We rotate around Y axis based on hand roll
                STATE.selectedObject.rotation.y += angleDiff * CONFIG.ROTATION_SENSITIVITY * 10;
            }
            STATE.lastWristAngle = currentAngle;
        } else {
            STATE.isRotating = false;
            STATE.lastWristAngle = 0;
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
    return intersects.length > 0 ? intersects[0].point : null;
}

/**
 * SECTION 6: INTERACTION HANDLERS
 */
function handleInteraction() {
    const primaryHand = STATE.smoothedLandmarks[0];
    if (!primaryHand) return;

    const indexTip = primaryHand[8];
    const worldPoint = getRaycastPoint(indexTip);

    // Crosshair
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

    // Drawing Logic
    if (STATE.gesture === 'PINCH') {
        promptOverlay.innerText = STATE.selectedObject ? "RELEASE TO CONFIRM" : "PINCH TO DRAW";
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
            STATE.mode = STATE.selectedObject ? 'MANIPULATING' : 'IDLE';
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

    let geometry;
    if (width > depth * 1.5) geometry = new THREE.BoxGeometry(width, 0.1, 0.2);
    else if (depth > width * 1.5) geometry = new THREE.BoxGeometry(0.2, 0.1, depth);
    else geometry = new THREE.BoxGeometry(width, 0.1, depth);

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
        // Don't clear selectedObject yet, allow immediate grab
        STATE.mode = 'MANIPULATING';
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
    if (STATE.initialTwoHandDist === 0) {
        STATE.initialTwoHandDist = dist;
        STATE.lastZoomDist = dist;
    }
    
    const delta = dist - STATE.lastZoomDist;
    
    // Zoom In (Spread) vs Zoom Out (Pinch Together)
    if (delta > 0.01) {
        // Zoom In (Increase FOV slightly or move camera closer? Let's move camera closer)
        camera.position.z = THREE.MathUtils.lerp(camera.position.z, camera.position.z - 0.1, 0.1);
    } else if (delta < -0.01) {
        // Zoom Out
        camera.position.z = THREE.MathUtils.lerp(camera.position.z, camera.position.z + 0.1, 0.1);
    }
    
    STATE.lastZoomDist = dist;
}

function undoLastAction() {
    if (STATE.objects.length > 0) {
        const obj = STATE.objects.pop();
        scene.remove(obj);
        obj.geometry.dispose();
        obj.material.dispose();
    }
}

document.getElementById('reset-scene').addEventListener('click', () => {
    STATE.objects.forEach(obj => { scene.remove(obj); obj.geometry.dispose(); obj.material.dispose(); });
    STATE.objects = [];
    STATE.selectedObject = null;
});

document.getElementById('toggle-skeleton').addEventListener('click', (e) => {
    STATE.showSkeleton = !STATE.showSkeleton;
    e.target.innerText = STATE.showSkeleton ? "Hide Skeleton" : "Show Skeleton";
});

/**
 * SECTION 7: RENDER SKELETON
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
    let statusText = STATE.gesture.replace('_', ' ');
    if (STATE.isRotating) statusText = "ROTATING";
    if (STATE.mode === 'ZOOMING') statusText = "ZOOMING";
    
    uiGesture.innerText = statusText;
    uiMode.innerText = `Mode: ${STATE.mode}`;
    
    if (STATE.isRotating) uiGesture.style.color = '#FFFFFF';
    else if (STATE.gesture === 'PINCH') uiGesture.style.color = '#FF9500';
    else if (STATE.gesture === 'GRAB') uiGesture.style.color = '#FF3B30';
    else uiGesture.style.color = '#34C759';

    const confPct = Math.round(confidence * 100);
    uiConf.style.width = `${confPct}%`;
    uiConfText.innerText = `${confPct}%`;
    uiConf.style.background = confPct > 0.7 ? '#34C759' : '#FF9500';
}

/**
 * SECTION 9: ANIMATION LOOP
 */
function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const delta = clock.getDelta();
    fpsCounter.innerText = Math.round(1 / delta);

    if (videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
        if (now - lastVideoTime >= 1000 / 30) {
            lastVideoTime = now;
            if (handLandmarker) {
                const results = handLandmarker.detectForVideo(videoElement, now);
                const confidence = detectGestures(results);
                handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
                results.landmarks.forEach((lm, idx) => {
                    const handedness = results.handednesses[idx]?.categoryName || 'Right';
                    drawHandSkeleton(lm, handedness);
                });
                handleInteraction();
                updateUI(confidence);
            }
        }
    }
    renderer.render(scene, camera);
}

initMediaPipe();
initThreeJS();
