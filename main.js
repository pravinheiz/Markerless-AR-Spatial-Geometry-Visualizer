import * as THREE from 'three';

/**
 * CONFIGURATION CONSTANTS
 * Tuned for stability and responsiveness
 */
const CONFIG = {
    SMOOTHING_ALPHA: 0.3,       // Exponential smoothing factor
    MIN_CONFIDENCE: 0.5,        // Minimum landmark confidence
    PINCH_THRESHOLD: 0.05,      // Distance for pinch detection
    GRAB_THRESHOLD: 0.15,       // Average finger curl for grab
    EXTRUSION_SENSITIVITY: 0.003,
    ZOOM_SENSITIVITY: 0.002,
    COLORS: {
        LEFT_HAND: 0x007AFF,    // Apple Blue
        RIGHT_HAND: 0x34C759,   // Apple Green
        PINCH_ACTIVE: 0xFF9500, // Apple Orange
        GRAB_ACTIVE: 0xFF3B30,  // Apple Red
        OBJECT_SELECTED: 0x00FF88,
        OBJECT_GRABBED: 0xFFFFFF
    }
};

/**
 * GLOBAL STATE MANAGEMENT
 * Tracks application mode, gestures, and object references
 */
const STATE = {
    mode: 'IDLE',           // IDLE, DRAWING, MANIPULATING, EXTRUDING, ZOOMING
    gesture: 'NONE',        // NONE, PINCH, GRAB, OPEN_PALM, FIST, TWO_HAND
    hands: [],              // Current frame hand data
    smoothedLandmarks: [],  // History for smoothing
    objects: [],            // Array of created 3D objects
    selectedObject: null,   // Currently grabbed object
    startPoint: null,       // Start point for drawing/extrusion
    initialTwoHandDist: 0,  // Reference distance for zoom
    fistStartTime: 0,       // Timestamp for fist hold (undo)
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
 * SECTION 1: MEDIAPIPE SETUP & HAND TRACKING
 * Initializes the HandLandmarker from MediaPipe Tasks Vision
 */
let handLandmarker = undefined;
let lastVideoTime = -1;

async function initMediaPipe() {
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

    console.log("MediaPipe Hand Landmarker loaded successfully.");
    loadingScreen.querySelector('h2').innerText = "Camera Required";
    loadingScreen.querySelector('p').innerText = "Click below to start the AR experience.";
    enableBtn.style.display = 'block';
}

enableBtn.addEventListener('click', async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
        });
        videoElement.srcObject = stream;
        videoElement.play();
        
        // Wait for video to be ready
        videoElement.onloadeddata = () => {
            loadingScreen.style.opacity = '0';
            setTimeout(() => loadingScreen.style.display = 'none', 500);
            resizeCanvases();
            animate();
        };
    } catch (err) {
        alert("Camera access denied. Please allow camera permissions to use AR features.");
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
 * SECTION 2: ONE EURO FILTER & SMOOTHING
 * Adaptive smoothing to reduce jitter while maintaining low latency
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
        if (te <= 0) return value; // Prevent division by zero

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

// Initialize filters for each landmark of each hand
const filters = []; 

/**
 * SECTION 3: GESTURE RECOGNITION LOGIC
 * Deterministic rule-based analysis of landmarks
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

    // Process each hand
    STATE.hands.forEach((landmarks, handIndex) => {
        // Apply Filtering
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

        // Calculate Distances
        const thumbTip = smoothed[4];
        const indexTip = smoothed[8];
        const middleTip = smoothed[12];
        const ringTip = smoothed[16];
        const pinkyTip = smoothed[20];
        const wrist = smoothed[0];

        const pinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
        
        // Check Finger Extension (Simple dot product or distance check could be used, here using tip-to-wrist distance)
        const isFingerExtended = (tip, wrist, pip) => {
            const distWristTip = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
            const distWristPip = Math.hypot(pip.x - wrist.x, pip.y - wrist.y);
            return distWristTip > distWristPip * 1.2; // Tip is further than PIP joint
        };

        const fingersExtended = [
            isFingerExtended(indexTip, wrist, smoothed[6]),
            isFingerExtended(middleTip, wrist, smoothed[10]),
            isFingerExtended(ringTip, wrist, smoothed[14]),
            isFingerExtended(pinkyTip, wrist, smoothed[18])
        ].filter(Boolean).length;

        // State Logic
        if (pinchDist < CONFIG.PINCH_THRESHOLD) {
            STATE.gesture = 'PINCH';
            if (STATE.mode === 'IDLE') STATE.mode = 'SELECTING';
        } else if (fingersExtended === 0 && pinchDist > 0.1) {
            // Fist detected
            if (STATE.fistStartTime === 0) STATE.fistStartTime = Date.now();
            else if (Date.now() - STATE.fistStartTime > 1000) {
                STATE.gesture = 'FIST_HOLD';
                undoLastAction();
                STATE.fistStartTime = 0; // Reset after trigger
            }
        } else {
            STATE.fistStartTime = 0;
            if (fingersExtended === 4) STATE.gesture = 'OPEN_PALM';
            else STATE.gesture = 'GRAB'; // Partial curl
        }

        // Two Hand Logic
        if (STATE.hands.length === 2) {
            const h1 = STATE.smoothedLandmarks[0][0]; // Wrist 1
            const h2 = STATE.smoothedLandmarks[1][0]; // Wrist 2
            const dist = Math.hypot(h1.x - h2.x, h1.y - h2.y);
            
            if (STATE.gesture === 'PINCH' && STATE.smoothedLandmarks[1][4] && Math.hypot(STATE.smoothedLandmarks[1][4].x - STATE.smoothedLandmarks[1][8].x, STATE.smoothedLandmarks[1][4].y - STATE.smoothedLandmarks[1][8].y) < CONFIG.PINCH_THRESHOLD) {
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
    });

    return avgConfidence / STATE.hands.length;
}

/**
 * SECTION 4: THREE.JS SCENE INITIALIZATION
 * Sets up the transparent 3D world over the video
 */
function initThreeJS() {
    scene = new THREE.Scene();
    // No background color set, alpha is true in renderer to see video

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 2, 6); // Elevated view
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0); // Transparent clear color
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    scene.add(dirLight);

    const pointLight = new THREE.PointLight(0x00ff88, 0.5);
    pointLight.position.set(0, 5, 0);
    scene.add(pointLight);

    // Construction Plane (Grid)
    const gridHelper = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    gridHelper.position.y = 0.01; // Slightly above 0 to avoid z-fighting
    scene.add(gridHelper);

    // Invisible Raycast Plane
    const planeGeo = new THREE.PlaneGeometry(100, 100);
    const planeMat = new THREE.MeshBasicMaterial({ visible: false });
    constructionPlane = new THREE.Mesh(planeGeo, planeMat);
    constructionPlane.rotation.x = -Math.PI / 2;
    scene.add(constructionPlane);

    raycaster = new THREE.Raycaster();
}

/**
 * SECTION 5: RAYCASTING & 3D MAPPING
 * Maps 2D screen coordinates (from hand) to 3D world space
 */
function getRaycastPoint(landmark) {
    if (!landmark) return null;

    // Convert MediaPipe coords (0-1, top-left origin) to NDC (-1 to 1, center origin)
    // Note: Video is mirrored via CSS, but coords are standard. We must mirror X manually for logic consistency if needed, 
    // but since CSS mirrors the canvas too, visual alignment is automatic. 
    // However, for Raycasting, we need normalized device coordinates relative to the WebGL canvas.
    
    const ndcX = -(landmark.x * 2 - 1); 
    const ndcY = -(landmark.y * 2 - 1);

    const mouse = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObject(constructionPlane);
    if (intersects.length > 0) {
        return intersects[0].point;
    }
    return null;
}

/**
 * SECTION 6: 3D MANIPULATION & INTERACTION
 */
function handleInteraction() {
    const primaryHand = STATE.smoothedLandmarks[0];
    if (!primaryHand) return;

    const indexTip = primaryHand[8];
    const worldPoint = getRaycastPoint(indexTip);

    // Update Crosshair
    if (worldPoint && STATE.showSkeleton) {
        crosshair.classList.remove('hidden');
        // Project 3D point to 2D screen for crosshair positioning
        const vec = worldPoint.clone();
        vec.project(camera);
        const x = (vec.x * .5 + .5) * window.innerWidth;
        const y = (-(vec.y * .5) + .5) * window.innerHeight;
        crosshair.style.left = `${x}px`;
        crosshair.style.top = `${y}px`;
    } else {
        crosshair.classList.add('hidden');
    }

    // Logic based on Gesture
    if (STATE.gesture === 'PINCH') {
        promptOverlay.classList.remove('hidden');
        
        if (STATE.mode === 'SELECTING' && worldPoint) {
            // Start Drawing or Selecting
            STATE.startPoint = worldPoint;
            STATE.mode = 'DRAWING';
            createShapePreview();
        } else if (STATE.mode === 'DRAWING' && worldPoint) {
            updateShapePreview(worldPoint);
        }
    } else {
        promptOverlay.classList.add('hidden');
        if (STATE.mode === 'DRAWING' && !STATE.gesture.includes('PINCH')) {
            // Release Pinch -> Confirm
            finalizeShape();
            STATE.mode = 'IDLE';
            STATE.startPoint = null;
        }
    }

    // Object Manipulation (Grab)
    if (STATE.gesture === 'GRAB' || STATE.gesture === 'TWO_HAND_PINCH') {
        // Simple proximity selection for demo
        // In a full app, we'd raycast against objects
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

    // Remove old preview mesh, create new shape based on drag
    scene.remove(STATE.selectedObject);

    const width = Math.abs(currentPoint.x - STATE.startPoint.x);
    const depth = Math.abs(currentPoint.z - STATE.startPoint.z);
    const centerX = (STATE.startPoint.x + currentPoint.x) / 2;
    const centerZ = (STATE.startPoint.z + currentPoint.z) / 2;

    // Creative Shape: Dynamic Box based on aspect ratio
    let geometry;
    if (width > depth * 1.5) geometry = new THREE.BoxGeometry(width, 0.1, 0.2); // Plank
    else if (depth > width * 1.5) geometry = new THREE.BoxGeometry(0.2, 0.1, depth); // Beam
    else geometry = new THREE.BoxGeometry(width, 0.1, depth); // Plate

    const material = new THREE.MeshStandardMaterial({ 
        color: CONFIG.COLORS.OBJECT_SELECTED, 
        roughness: 0.4, 
        metalness: 0.1,
        transparent: true, 
        opacity: 0.6 
    });

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
    
    // Scale Y based on separation
    const targetScale = 1 + (separation * 5);
    lastObj.scale.y = THREE.MathUtils.lerp(lastObj.scale.y, targetScale, 0.1);
    lastObj.position.y = lastObj.scale.y / 2; // Keep on floor
    
    // Change material to indicate 3D
    lastObj.material.color.setHex(CONFIG.COLORS.RIGHT_HAND);
    lastObj.material.roughness = 0.2;
}

function handleZoom(dist) {
    if (STATE.initialTwoHandDist === 0) STATE.initialTwoHandDist = dist;
    
    const scale = dist / STATE.initialTwoHandDist;
    const targetFOV = 45 / scale;
    camera.fov = THREE.MathUtils.lerp(camera.fov, targetFOV, 0.05);
    camera.updateProjectionMatrix();
}

function undoLastAction() {
    if (STATE.objects.length > 0) {
        const obj = STATE.objects.pop();
        scene.remove(obj);
        obj.geometry.dispose();
        obj.material.dispose();
        console.log("Undo performed");
    }
}

document.getElementById('reset-scene').addEventListener('click', () => {
    STATE.objects.forEach(obj => {
        scene.remove(obj);
        obj.geometry.dispose();
        obj.material.dispose();
    });
    STATE.objects = [];
    STATE.selectedObject = null;
});

document.getElementById('toggle-skeleton').addEventListener('click', (e) => {
    STATE.showSkeleton = !STATE.showSkeleton;
    e.target.innerText = STATE.showSkeleton ? "Hide Skeleton" : "Show Skeleton";
});

/**
 * SECTION 7: HAND SKELETON RENDERER (2D CANVAS)
 * Draws the "Apple Vision Pro" style skeletal overlay
 */
function drawHandSkeleton(landmarks, handedness) {
    if (!STATE.showSkeleton) return;

    const color = handedness === 'Left' ? CONFIG.COLORS.LEFT_HAND : CONFIG.COLORS.RIGHT_HAND;
    const hexColor = new THREE.Color(color);
    
    handCtx.lineWidth = 2;
    handCtx.lineCap = 'round';
    handCtx.lineJoin = 'round';

    // Draw Bones
    const connections = [
        [0,1], [1,2], [2,3], [3,4], // Thumb
        [0,5], [5,6], [6,7], [7,8], // Index
        [0,9], [9,10], [10,11], [11,12], // Middle
        [0,13], [13,14], [14,15], [15,16], // Ring
        [0,17], [17,18], [18,19], [19,20], // Pinky
        [5,9], [9,13], [13,17] // Palm
    ];

    handCtx.beginPath();
    connections.forEach(([i, j]) => {
        const p1 = landmarks[i];
        const p2 = landmarks[j];
        // Map to screen coords (considering CSS mirror)
        const x1 = p1.x * window.innerWidth;
        const y1 = p1.y * window.innerHeight;
        const x2 = p2.x * window.innerWidth;
        const y2 = p2.y * window.innerHeight;
        
        handCtx.moveTo(x1, y1);
        handCtx.lineTo(x2, y2);
    });
    
    handCtx.strokeStyle = `rgba(${hexColor.r*255}, ${hexColor.g*255}, ${hexColor.b*255}, 0.6)`;
    handCtx.stroke();

    // Draw Joints (Glowing Dots)
    landmarks.forEach((lm, i) => {
        const x = lm.x * window.innerWidth;
        const y = lm.y * window.innerHeight;
        const radius = (i === 4 || i === 8) ? 6 : 4; // Highlight Thumb/Index tips
        
        handCtx.beginPath();
        handCtx.arc(x, y, radius, 0, 2 * Math.PI);
        handCtx.fillStyle = `rgba(${hexColor.r*255}, ${hexColor.g*255}, ${hexColor.b*255}, ${lm.visibility})`;
        handCtx.fill();
        
        // Glow effect
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
    uiGesture.innerText = STATE.gesture.replace('_', ' ');
    uiMode.innerText = `Mode: ${STATE.mode}`;
    
    // Color coding status
    if (STATE.gesture === 'PINCH') uiGesture.style.color = '#FF9500';
    else if (STATE.gesture === 'GRAB') uiGesture.style.color = '#FF3B30';
    else uiGesture.style.color = '#34C759';

    const confPct = Math.round(confidence * 100);
    uiConf.style.width = `${confPct}%`;
    uiConfText.innerText = `${confPct}%`;
    uiConf.style.background = confPct > 0.7 ? '#34C759' : '#FF9500';
}

/**
 * SECTION 9: ANIMATION LOOP
 * Main entry point for rendering and logic
 */
function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const delta = clock.getDelta();
    STATE.fps = Math.round(1 / delta);
    document.getElementById('fps-counter').innerText = STATE.fps;

    if (videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
        if (now - lastVideoTime >= 1000 / 30) { // Limit to 30fps for MP
            lastVideoTime = now;
            
            if (handLandmarker) {
                const results = handLandmarker.detectForVideo(videoElement, now);
                const confidence = detectGestures(results);
                
                // Clear Hand Canvas
                handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
                
                // Draw Skeletons
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

// Bootstrap
initMediaPipe();
initThreeJS();
