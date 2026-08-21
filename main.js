import * as THREE from 'three';

/**
 * CONFIGURATION & CONSTANTS
 * Tuning parameters for gesture recognition and smoothing
 */
const CONFIG = {
    SMOOTHING_ALPHA: 0.5,       // Exponential smoothing factor (0.1 = smooth/slow, 0.9 = jittery/fast)
    PINCH_THRESHOLD_START: 0.05, // Distance to trigger pinch start
    PINCH_THRESHOLD_END: 0.08,   // Distance to trigger pinch end (Hysteresis)
    EXTRUSION_SENSITIVITY: 0.002, // How fast extrusion happens per pixel diff
    ZOOM_SENSITIVITY: 0.001,
    CONSTRUCTION_PLANE_Y: 0,    // Y level of the virtual grid
};

/**
 * STATE MACHINE
 * Tracks the current interaction mode and gesture states
 */
const STATE = {
    mode: 'IDLE',           // IDLE, DRAWING, CONFIRMED, EXTRUDING, INSPECTING
    gesture: 'NONE',        // NONE, PINCH, TWO_HANDS
    pinchDistance: 1.0,
    isPinching: false,
    handCount: 0,
    landmarks: [],          // Current frame landmarks
    smoothedLandmarks: [],  // Smoothed landmarks history
    startPoint: null,       // 3D point where drawing started
    currentPoint: null,     // 3D point where cursor is now
    activeShape: null,      // Reference to current Three.js mesh
    activeShapeType: null,  // 'rectangle' or 'circle'
    extrusionHeight: 0,
    cameraOffset: new THREE.Vector3(0, 5, 8) // Initial camera position
};

// DOM Elements
const videoElement = document.getElementById('input-video');
const canvasElement = document.getElementById('output-canvas');
const canvasCtx = canvasElement.getContext('2d');
const webglCanvas = document.getElementById('webgl-canvas');
const hudMode = document.getElementById('mode-display');
const hudGesture = document.getElementById('gesture-display');
const hudPinch = document.getElementById('pinch-display');
const hudHands = document.getElementById('hands-display');
const loadingScreen = document.getElementById('loading-screen');

// Three.js Globals
let scene, camera, renderer, raycaster, planeMesh;
let constructionPlane; // Invisible plane for raycasting

/**
 * MATH UTILITIES
 * Core geometric calculations for the project
 */
const MathUtils = {
    /**
     * Exponential Moving Average (EMA) for smoothing jittery landmark data
     * Formula: p_new = alpha * p_raw + (1 - alpha) * p_prev
     */
    smoothLandmark(current, previous, alpha) {
        if (!previous) return current;
        return {
            x: alpha * current.x + (1 - alpha) * previous.x,
            y: alpha * current.y + (1 - alpha) * previous.y,
            z: alpha * current.z + (1 - alpha) * previous.z
        };
    },

    /**
     * Calculate Euclidean distance between two 3D points (normalized coordinates)
     */
    getDistance(p1, p2) {
        return Math.sqrt(
            Math.pow(p1.x - p2.x, 2) +
            Math.pow(p1.y - p2.y, 2) +
            Math.pow(p1.z - p2.z, 2)
        );
    },

    /**
     * Ray-Plane Intersection
     * Maps 2D screen coordinate (from webcam) to 3D world coordinate on Y=0 plane
     */
    getIntersectionPoint(raycaster, plane) {
        const intersects = raycaster.intersectObject(plane);
        if (intersects.length > 0) {
            return intersects[0].point;
        }
        return null;
    }
};

/**
 * MEDIAPIPE SETUP
 * Initializes the Hand Landmarker model
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

    // Initialize Camera Utility from CDN global scope
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
            loadingScreen.classList.add('hidden');
        })
        .catch(err => {
            console.error("Camera error:", err);
            alert("Camera access denied or not available.");
        });
}

/**
 * GESTURE RECOGNITION LOGIC
 * Deterministic rule-based analysis of landmarks
 */
function onHandsResults(results) {
    // Clear canvas for new frame
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    
    // Resize canvas to match video resolution
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;

    STATE.handCount = results.multiHandLandmarks.length;
    STATE.landmarks = results.multiHandLandmarks;

    let detectedGesture = 'NONE';
    let pinchDist = 1.0;

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        // Process First Hand (Primary Controller)
        const landmarks = results.multiHandLandmarks[0];
        
        // Draw landmarks
        drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {color: '#00FF00', lineWidth: 2});
        drawLandmarks(canvasCtx, landmarks, {color: '#FF0000', lineWidth: 1, radius: 3});

        // Get Tip Coordinates (Index: 8, Thumb: 4)
        const indexTip = landmarks[8];
        const thumbTip = landmarks[4];

        // Apply Smoothing
        if (!STATE.smoothedLandmarks[0]) STATE.smoothedLandmarks[0] = [];
        STATE.smoothedLandmarks[0][8] = MathUtils.smoothLandmark(indexTip, STATE.smoothedLandmarks[0][8], CONFIG.SMOOTHING_ALPHA);
        STATE.smoothedLandmarks[0][4] = MathUtils.smoothLandmark(thumbTip, STATE.smoothedLandmarks[0][4], CONFIG.SMOOTHING_ALPHA);

        const sIndex = STATE.smoothedLandmarks[0][8];
        const sThumb = STATE.smoothedLandmarks[0][4];

        // Calculate Pinch Distance
        pinchDist = MathUtils.getDistance(sIndex, sThumb);
        STATE.pinchDistance = pinchDist;

        // Hysteresis Logic for Pinch State
        if (pinchDist < CONFIG.PINCH_THRESHOLD_START) {
            STATE.isPinching = true;
            detectedGesture = 'PINCH';
        } else if (pinchDist > CONFIG.PINCH_THRESHOLD_END) {
            STATE.isPinching = false;
        }

        // Two Hand Logic (Extrusion/Zoom)
        if (results.multiHandLandmarks.length === 2) {
            detectedGesture = 'TWO_HANDS';
            
            const l1 = results.multiHandLandmarks[0][8]; // Left hand index
            const l2 = results.multiHandLandmarks[1][8]; // Right hand index
            
            // Vertical separation for Extrusion
            const verticalDiff = Math.abs(l1.y - l2.y);
            
            // Horizontal separation for Zoom
            const horizontalDiff = Math.abs(l1.x - l2.x);

            if (verticalDiff > 0.2) {
                handleExtrusion(verticalDiff);
            } else if (horizontalDiff > 0.15) {
                handleZoom(horizontalDiff);
            }
        }
    } else {
        STATE.isPinching = false;
        STATE.smoothedLandmarks = [];
    }

    STATE.gesture = detectedGesture;
    updateHUD();
    processInteractionLogic();
    
    canvasCtx.restore();
}

/**
 * INTERACTION STATE MACHINE
 * Manages transitions between Drawing, Extruding, and Inspecting
 */
function processInteractionLogic() {
    if (!STATE.activeShape && STATE.isPinching && STATE.gesture === 'PINCH' && STATE.handCount === 1) {
        // START DRAWING
        STATE.mode = 'DRAWING';
        const point = getRaycastPoint(STATE.smoothedLandmarks[0][8]);
        if (point) {
            STATE.startPoint = point;
            STATE.currentPoint = point;
            createShapePreview();
        }
    } 
    else if (STATE.mode === 'DRAWING' && STATE.isPinching && STATE.gesture === 'PINCH') {
        // CONTINUE DRAWING (Drag)
        const point = getRaycastPoint(STATE.smoothedLandmarks[0][8]);
        if (point) {
            STATE.currentPoint = point;
            updateShapePreview();
        }
    } 
    else if (STATE.mode === 'DRAWING' && !STATE.isPinching) {
        // CONFIRM SHAPE (Release)
        STATE.mode = 'CONFIRMED';
        finalizeShape();
    }
    else if (STATE.mode === 'CONFIRMED' && STATE.gesture === 'TWO_HANDS') {
        STATE.mode = 'EXTRUDING';
    }
    else if (STATE.mode === 'EXTRUDING' && STATE.gesture !== 'TWO_HANDS') {
        STATE.mode = 'CONFIRMED'; // Stop extruding but keep shape
    }
    else if (!STATE.isPinching && STATE.handCount === 0) {
        // Idle orbit could go here, but we keep camera static unless gesturing
        STATE.mode = 'IDLE';
    }
}

/**
 * RAYCASTING HELPER
 * Converts normalized landmark (x,y) to 3D World Point on Y=0 plane
 */
function getRaycastPoint(landmark) {
    if (!landmark) return null;

    // Convert MediaPipe coords (0-1, origin top-left) to NDC (-1 to 1, origin center)
    // Note: Video is mirrored visually, but coords are standard. We flip X for consistency.
    const ndcX = -(landmark.x * 2 - 1); 
    const ndcY = -(landmark.y * 2 - 1);

    const mouse = new THREE.Vector2(ndcX, ndcY);
    
    raycaster.setFromCamera(mouse, camera);
    return MathUtils.getIntersectionPoint(raycaster, constructionPlane);
}

/**
 * SHAPE GENERATION (Procedural Geometry)
 */
function createShapePreview() {
    // Default to rectangle for now, can be toggled later
    STATE.activeShapeType = 'rectangle';
    
    const geometry = new THREE.PlaneGeometry(0.1, 0.1);
    const material = new THREE.MeshBasicMaterial({ 
        color: 0x00ff88, 
        side: THREE.DoubleSide, 
        transparent: true, 
        opacity: 0.5,
        depthWrite: false
    });
    
    STATE.activeShape = new THREE.Mesh(geometry, material);
    scene.add(STATE.activeShape);
}

function updateShapePreview() {
    if (!STATE.activeShape || !STATE.startPoint || !STATE.currentPoint) return;

    const width = Math.abs(STATE.currentPoint.x - STATE.startPoint.x);
    const depth = Math.abs(STATE.currentPoint.z - STATE.startPoint.z);
    
    // Center calculation
    const centerX = (STATE.startPoint.x + STATE.currentPoint.x) / 2;
    const centerZ = (STATE.startPoint.z + STATE.currentPoint.z) / 2;

    if (STATE.activeShapeType === 'rectangle') {
        // Update Plane Geometry dynamically
        // Note: Creating new geometry every frame is heavy, but acceptable for this demo.
        // Optimization: Use scale instead.
        STATE.activeShape.scale.set(width, 1, depth);
        STATE.activeShape.position.set(centerX, CONFIG.CONSTRUCTION_PLANE_Y, centerZ);
    } else if (STATE.activeShapeType === 'circle') {
        const radius = Math.max(width, depth) / 2;
        STATE.activeShape.scale.set(radius*2, 1, radius*2); // Approximate circle with scaled plane
        STATE.activeShape.position.set(centerX, CONFIG.CONSTRUCTION_PLANE_Y, centerZ);
    }
}

function finalizeShape() {
    // Convert preview to a more permanent representation if needed
    // For now, the preview mesh becomes the confirmed shape
    STATE.activeShape.material.opacity = 0.8;
    STATE.activeShape.material.color.setHex(0x0088ff);
}

function handleExtrusion(separation) {
    if (!STATE.activeShape || STATE.mode !== 'EXTRUDING' && STATE.mode !== 'CONFIRMED') return;
    
    STATE.mode = 'EXTRUDING';

    // Map separation distance to height
    const targetHeight = separation * 5; // Scale factor
    
    // Smoothly interpolate current height to target
    STATE.extrusionHeight += (targetHeight - STATE.extrusionHeight) * 0.1;

    if (STATE.activeShapeType === 'rectangle') {
        convertToCuboid(STATE.extrusionHeight);
    } else if (STATE.activeShapeType === 'circle') {
        convertToCylinder(STATE.extrusionHeight);
    }
}

function convertToCuboid(height) {
    const width = STATE.activeShape.scale.x;
    const depth = STATE.activeShape.scale.z;
    const pos = STATE.activeShape.position.clone();

    scene.remove(STATE.activeShape);
    STATE.activeShape.geometry.dispose();

    const geometry = new THREE.BoxGeometry(width, height, depth);
    const material = new THREE.MeshStandardMaterial({ 
        color: 0x0088ff, 
        roughness: 0.3, 
        metalness: 0.1,
        transparent: true,
        opacity: 0.9
    });
    
    STATE.activeShape = new THREE.Mesh(geometry, material);
    STATE.activeShape.position.set(pos.x, height / 2, pos.z); // Lift up so it sits on plane
    scene.add(STATE.activeShape);
}

function convertToCylinder(height) {
    // Get approximate radius from scale
    const radius = STATE.activeShape.scale.x / 2;
    const pos = STATE.activeShape.position.clone();

    scene.remove(STATE.activeShape);
    STATE.activeShape.geometry.dispose();

    const geometry = new THREE.CylinderGeometry(radius, radius, height, 32);
    const material = new THREE.MeshStandardMaterial({ 
        color: 0xff0088, 
        roughness: 0.3, 
        metalness: 0.1,
        transparent: true,
        opacity: 0.9
    });
    
    STATE.activeShape = new THREE.Mesh(geometry, material);
    STATE.activeShape.position.set(pos.x, height / 2, pos.z);
    scene.add(STATE.activeShape);
}

function handleZoom(separation) {
    // Simple camera FOV or Position zoom
    const baseZ = 8;
    const targetZ = baseZ - (separation * 10);
    camera.position.z += (targetZ - camera.position.z) * 0.1;
}

/**
 * THREE.JS INITIALIZATION
 */
function initThreeJS() {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);
    scene.fog = new THREE.Fog(0x1a1a1a, 10, 20);

    // Camera
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.copy(STATE.cameraOffset);
    camera.lookAt(0, 0, 0);

    // Renderer
    renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // Construction Plane (Visual Grid)
    const gridHelper = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    scene.add(gridHelper);

    // Invisible Raycast Plane (Math surface at y=0)
    const planeGeo = new THREE.PlaneGeometry(100, 100);
    const planeMat = new THREE.MeshBasicMaterial({ visible: false });
    constructionPlane = new THREE.Mesh(planeGeo, planeMat);
    constructionPlane.rotation.x = -Math.PI / 2;
    scene.add(constructionPlane);

    // Raycaster
    raycaster = new THREE.Raycaster();

    // Resize Handler
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

/**
 * UI UPDATES
 */
function updateHUD() {
    hudMode.textContent = STATE.mode;
    hudGesture.textContent = STATE.gesture;
    hudPinch.textContent = STATE.pinchDistance.toFixed(3);
    hudHands.textContent = STATE.handCount;

    // Color coding modes
    if (STATE.mode === 'DRAWING') hudMode.style.color = '#ffff00';
    else if (STATE.mode === 'EXTRUDING') hudMode.style.color = '#ff00ff';
    else hudMode.style.color = '#00ff88';
}

/**
 * MAIN LOOP
 */
function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}

// Bootstrap
initThreeJS();
initMediaPipe();
animate();
