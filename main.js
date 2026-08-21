import * as THREE from 'three';

/**
 * CONFIGURATION
 */
const CONFIG = {
    SMOOTHING_ALPHA: 0.6,       // Higher = smoother but more lag
    PINCH_THRESHOLD_START: 0.04,
    PINCH_THRESHOLD_END: 0.07,
    TRAIL_LENGTH: 15,           // Number of points in motion trail
    COLORS: {
        IDLE: 0x00ff88,         // Green
        PINCH: 0xffaa00,        // Orange
        SHAPE_IDLE: 0x0088ff,   // Blue
        SHAPE_GRABBED: 0xff0088,// Pink
        SHAPE_CONFIRMED: 0x00ffff // Cyan
    }
};

/**
 * STATE MANAGEMENT
 */
const STATE = {
    mode: 'IDLE',           // IDLE, DRAWING, CONFIRMED, EXTRUDING
    gesture: 'NONE',
    pinchDistance: 1.0,
    isPinching: false,
    handCount: 0,
    landmarks: [],
    smoothedLandmarks: [],
    motionTrail: [],        // Array of recent 3D positions for visualization
    startPoint: null,
    currentPoint: null,
    activeShape: null,
    activeShapeType: 'rectangle', // 'rectangle' or 'circle'
    shapeDimensions: { w: 0.1, d: 0.1 },
    extrusionHeight: 0,
    isShapeGrabbed: false   // New state: is user holding the shape?
};

// DOM Elements
const videoElement = document.getElementById('input-video');
const canvasElement = document.getElementById('output-canvas');
const canvasCtx = canvasElement.getContext('2d');
const webglCanvas = document.getElementById('webgl-canvas');
const hudMode = document.getElementById('mode-display');
const hudGesture = document.getElementById('gesture-display');
const hudPinch = document.getElementById('pinch-display');
const loadingScreen = document.getElementById('loading-screen');

// Three.js Globals
let scene, camera, renderer, raycaster, constructionPlane;
let shapeMesh, shapeHelper; // Helper for wireframe during extrusion

/**
 * MATH UTILITIES
 */
const MathUtils = {
    smoothLandmark(current, previous, alpha) {
        if (!previous) return current;
        return {
            x: alpha * current.x + (1 - alpha) * previous.x,
            y: alpha * current.y + (1 - alpha) * previous.y,
            z: alpha * current.z + (1 - alpha) * previous.z
        };
    },

    getDistance(p1, p2) {
        return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2) + Math.pow(p1.z - p2.z, 2));
    },

    lerp(start, end, t) {
        return start * (1 - t) + end * t;
    }
};

/**
 * MEDIAPIPE INITIALIZATION
 */
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

    const cameraUtils = new Camera(videoElement, {
        onFrame: async () => {
            await hands.send({image: videoElement});
        },
        width: 1280,
        height: 720
    });
    
    cameraUtils.start().then(() => {
        loadingScreen.classList.add('hidden');
    }).catch(err => {
        console.error("Camera error:", err);
        alert("Camera access denied.");
    });
}

/**
 * MAIN LOGIC LOOP (Called by MediaPipe)
 */
function onHandsResults(results) {
    // Setup Canvas
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;

    STATE.handCount = results.multiHandLandmarks.length;
    STATE.landmarks = results.multiHandLandmarks;
    
    let detectedGesture = 'NONE';
    let pinchDist = 1.0;
    let primaryHandIndex = -1;

    // Reset grab state unless proven otherwise
    STATE.isShapeGrabbed = false; 

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        // Process Primary Hand (First detected)
        const landmarks = results.multiHandLandmarks[0];
        primaryHandIndex = 0;
        
        // Draw Skeleton
        drawHandSkeleton(canvasCtx, landmarks, CONFIG.COLORS.IDLE);

        // Get Tips (Index: 8, Thumb: 4)
        const indexTip = landmarks[8];
        const thumbTip = landmarks[4];

        // Smoothing
        if (!STATE.smoothedLandmarks[0]) STATE.smoothedLandmarks[0] = [];
        STATE.smoothedLandmarks[0][8] = MathUtils.smoothLandmark(indexTip, STATE.smoothedLandmarks[0][8], CONFIG.SMOOTHING_ALPHA);
        STATE.smoothedLandmarks[0][4] = MathUtils.smoothLandmark(thumbTip, STATE.smoothedLandmarks[0][4], CONFIG.SMOOTHING_ALPHA);

        const sIndex = STATE.smoothedLandmarks[0][8];
        const sThumb = STATE.smoothedLandmarks[0][4];

        pinchDist = MathUtils.getDistance(sIndex, sThumb);
        STATE.pinchDistance = pinchDist;

        // Hysteresis Logic
        if (pinchDist < CONFIG.PINCH_THRESHOLD_START) {
            STATE.isPinching = true;
            detectedGesture = 'PINCH';
            // Change visual color to indicate grab
            drawHandSkeleton(canvasCtx, landmarks, CONFIG.COLORS.PINCH);
            drawPinchIndicator(canvasCtx, sIndex);
        } else if (pinchDist > CONFIG.PINCH_THRESHOLD_END) {
            STATE.isPinching = false;
        }

        // Motion Trail Logic (Only track index finger tip)
        const worldPoint = getRaycastPoint(sIndex);
        if (worldPoint) {
            STATE.motionTrail.push(worldPoint.clone());
            if (STATE.motionTrail.length > CONFIG.TRAIL_LENGTH) {
                STATE.motionTrail.shift();
            }
            drawMotionTrail(canvasCtx, STATE.motionTrail);
        }

        // Two Hand Logic
        if (results.multiHandLandmarks.length === 2) {
            detectedGesture = 'TWO_HANDS';
            const l1 = results.multiHandLandmarks[0][8];
            const l2 = results.multiHandLandmarks[1][8];
            const verticalDiff = Math.abs(l1.y - l2.y);
            const horizontalDiff = Math.abs(l1.x - l2.x);

            if (verticalDiff > 0.15) handleExtrusion(verticalDiff);
            else if (horizontalDiff > 0.15) handleZoom(horizontalDiff);
        }
    } else {
        STATE.isPinching = false;
        STATE.smoothedLandmarks = [];
        STATE.motionTrail = [];
    }

    STATE.gesture = detectedGesture;
    updateHUD();
    processInteractionLogic();
    
    canvasCtx.restore();
}

/**
 * INTERACTION STATE MACHINE
 */
function processInteractionLogic() {
    const point = STATE.motionTrail.length > 0 ? STATE.motionTrail[STATE.motionTrail.length - 1] : null;

    // 1. Start Drawing / Grabbing
    if (STATE.isPinching && STATE.gesture === 'PINCH') {
        if (!STATE.activeShape) {
            // No shape exists -> Start Drawing
            STATE.mode = 'DRAWING';
            STATE.startPoint = point;
            STATE.shapeDimensions = { w: 0.1, d: 0.1 };
            createShape();
        } else if (STATE.mode === 'CONFIRMED') {
            // Shape exists & Pinch -> Check if we are "holding" it (simplified: always allow move/resize if pinching near)
            // For this demo, Pinch while confirmed allows Resizing/Moving
            STATE.mode = 'TRANSFORMING';
            STATE.isShapeGrabbed = true;
            updateShapeVisuals(true); // Glow effect
        }
    } 
    // 2. Active Transformation (Dragging)
    else if (STATE.mode === 'DRAWING' || STATE.mode === 'TRANSFORMING') {
        if (point) {
            if (STATE.mode === 'DRAWING') {
                // Calculate dimensions based on start and current point
                const dx = Math.abs(point.x - STATE.startPoint.x);
                const dz = Math.abs(point.z - STATE.startPoint.z);
                STATE.shapeDimensions.w = Math.max(0.1, dx);
                STATE.shapeDimensions.d = Math.max(0.1, dz);
                updateShapeGeometry();
            } else if (STATE.mode === 'TRANSFORMING') {
                // Simple logic: Dragging resizes the shape relative to start point
                // In a full app, you'd distinguish between Move and Scale
                const dx = Math.abs(point.x - STATE.startPoint.x);
                const dz = Math.abs(point.z - STATE.startPoint.z);
                STATE.shapeDimensions.w = Math.max(0.1, dx);
                STATE.shapeDimensions.d = Math.max(0.1, dz);
                updateShapeGeometry();
            }
        }
    }
    // 3. Release Pinch
    else if (!STATE.isPinching && (STATE.mode === 'DRAWING' || STATE.mode === 'TRANSFORMING')) {
        STATE.mode = 'CONFIRMED';
        STATE.isShapeGrabbed = false;
        updateShapeVisuals(false);
        STATE.startPoint = null; // Reset start point for next interaction
    }
}

/**
 * SHAPE GENERATION & UPDATES
 */
function createShape() {
    if (shapeMesh) scene.remove(shapeMesh);
    if (shapeHelper) scene.remove(shapeHelper);

    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshStandardMaterial({ 
        color: CONFIG.COLORS.SHAPE_GRABBED, 
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.6,
        emissive: CONFIG.COLORS.SHAPE_GRABBED,
        emissiveIntensity: 0.5
    });
    
    shapeMesh = new THREE.Mesh(geometry, material);
    shapeMesh.rotation.x = -Math.PI / 2;
    scene.add(shapeMesh);
    
    updateShapeGeometry();
}

function updateShapeGeometry() {
    if (!shapeMesh) return;

    // Update Scale
    shapeMesh.scale.set(STATE.shapeDimensions.w, 1, STATE.shapeDimensions.d);
    
    // Position: Center of the rectangle defined by startPoint and currentPoint
    // Since we don't store currentPoint explicitly in state anymore, we infer from trail or just keep it simple
    // For simplicity in this version: Shape grows from a fixed origin or last known point
    // Better approach: Use the midpoint of the drag
    if (STATE.motionTrail.length > 0) {
        const current = STATE.motionTrail[STATE.motionTrail.length - 1];
        const start = STATE.startPoint || current;
        
        const centerX = (start.x + current.x) / 2;
        const centerZ = (start.z + current.z) / 2;
        
        shapeMesh.position.set(centerX, 0.01, centerZ);
    }
}

function updateShapeVisuals(isGrabbed) {
    if (!shapeMesh) return;
    
    if (isGrabbed) {
        shapeMesh.material.color.setHex(CONFIG.COLORS.SHAPE_GRABBED);
        shapeMesh.material.emissive.setHex(CONFIG.COLORS.SHAPE_GRABBED);
        shapeMesh.material.emissiveIntensity = 0.8;
        shapeMesh.material.opacity = 0.8;
    } else {
        shapeMesh.material.color.setHex(CONFIG.COLORS.SHAPE_CONFIRMED);
        shapeMesh.material.emissive.setHex(0x000000);
        shapeMesh.material.emissiveIntensity = 0;
        shapeMesh.material.opacity = 0.9;
    }
}

function handleExtrusion(separation) {
    if (!shapeMesh || STATE.mode !== 'CONFIRMED' && STATE.mode !== 'EXTRUDING') return;
    
    STATE.mode = 'EXTRUDING';
    const targetHeight = separation * 4;
    STATE.extrusionHeight = MathUtils.lerp(STATE.extrusionHeight, targetHeight, 0.2);

    // Remove old mesh
    scene.remove(shapeMesh);
    shapeMesh.geometry.dispose();

    // Create 3D Geometry
    let newGeo;
    if (STATE.activeShapeType === 'rectangle') {
        newGeo = new THREE.BoxGeometry(STATE.shapeDimensions.w, STATE.extrusionHeight, STATE.shapeDimensions.d);
    } else {
        const radius = Math.max(STATE.shapeDimensions.w, STATE.shapeDimensions.d) / 2;
        newGeo = new THREE.CylinderGeometry(radius, radius, STATE.extrusionHeight, 32);
    }

    const mat = new THREE.MeshStandardMaterial({ 
        color: CONFIG.COLORS.SHAPE_CONFIRMED,
        roughness: 0.2,
        metalness: 0.1,
        transparent: true,
        opacity: 0.9
    });

    shapeMesh = new THREE.Mesh(newGeo, mat);
    shapeMesh.position.y = STATE.extrusionHeight / 2;
    
    // Keep X/Z position
    if (STATE.motionTrail.length > 0) {
         // Re-calculate center roughly or store it better in a real app
         // Here we just keep the last known position logic simplified
         shapeMesh.position.x = shapeMesh.position.x || 0;
         shapeMesh.position.z = shapeMesh.position.z || 0;
    }
    
    scene.add(shapeMesh);
}

function handleZoom(separation) {
    const baseZ = 8;
    const targetZ = baseZ - (separation * 12);
    camera.position.z += (targetZ - camera.position.z) * 0.1;
}

/**
 * VISUALIZATION HELPERS (Canvas 2D)
 */
function drawHandSkeleton(ctx, landmarks, color) {
    drawConnectors(ctx, landmarks, HAND_CONNECTIONS, {color: color, lineWidth: 3});
    drawLandmarks(ctx, landmarks, {color: '#ffffff', lineWidth: 1, radius: 4});
}

function drawPinchIndicator(ctx, landmark) {
    const x = landmark.x * ctx.canvas.width;
    const y = landmark.y * ctx.canvas.height;
    
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, 2 * Math.PI);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
}

function drawMotionTrail(ctx, trail) {
    if (trail.length < 2) return;
    
    ctx.beginPath();
    for (let i = 0; i < trail.length - 1; i++) {
        const p1 = trail[i];
        const p2 = trail[i+1];
        
        // Project 3D world point back to 2D canvas coords roughly
        // Note: This is an approximation. Perfect projection requires full camera matrix match.
        // Since our Three.js camera and Video are aligned visually, we can approximate:
        // But actually, we should just draw the trail on the WebGL canvas or map carefully.
        // For simplicity in this single-file demo, we will skip drawing the 3D trail on 2D canvas 
        // to avoid coordinate mismatch confusion, OR we just draw the raw landmark trail.
        
        // Let's draw the raw landmark trail from smoothedLandmarks instead for perfect 2D overlay
    }
}
// Override trail drawing to use 2D landmarks for perfect sync
function drawMotionTrail(ctx, trail3D) {
    // Instead, let's use the smoothedLandmarks history for the 2D trail
    if (!STATE.smoothedLandmarks[0] || !STATE.smoothedLandmarks[0][8]) return;
    
    // We'll maintain a separate 2D trail array in a real app, 
    // but here we just highlight the current fingertip heavily
    const lm = STATE.smoothedLandmarks[0][8];
    const x = lm.x * ctx.canvas.width;
    const y = lm.y * ctx.canvas.height;
    
    // Glow
    const gradient = ctx.createRadialGradient(x, y, 2, x, y, 20);
    gradient.addColorStop(0, 'rgba(255, 170, 0, 0.8)');
    gradient.addColorStop(1, 'rgba(255, 170, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x - 20, y - 20, 40, 40);
}

/**
 * THREE.JS SETUP
 */
function initThreeJS() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);
    scene.fog = new THREE.Fog(0x111111, 10, 25);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 4, 8);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    scene.add(dirLight);
    
    // Point light for dramatic effect on shapes
    const pointLight = new THREE.PointLight(CONFIG.COLORS.PRIMARY, 1, 10);
    pointLight.position.set(0, 5, 0);
    scene.add(pointLight);

    // Grid
    const gridHelper = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    scene.add(gridHelper);

    // Invisible Raycast Plane
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

function getRaycastPoint(landmark) {
    if (!landmark) return null;
    const ndcX = -(landmark.x * 2 - 1);
    const ndcY = -(landmark.y * 2 - 1);
    const mouse = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(constructionPlane);
    return intersects.length > 0 ? intersects[0].point : null;
}

function updateHUD() {
    hudMode.textContent = STATE.mode;
    hudGesture.textContent = STATE.gesture;
    hudPinch.textContent = STATE.pinchDistance.toFixed(3);
    
    if (STATE.isShapeGrabbed) {
        hudMode.style.color = CONFIG.COLORS.SHAPE_GRABBED;
        hudMode.textContent += " (GRABBED)";
    } else {
        hudMode.style.color = CONFIG.COLORS.IDLE;
    }
}

function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}

// Start
initThreeJS();
initMediaPipe();
animate();
