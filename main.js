import * as THREE from 'three';

/**
 * CONFIGURATION & CONSTANTS
 */
const CONFIG = {
    SMOOTHING_ALPHA: 0.5,
    PINCH_THRESHOLD_START: 0.05,
    PINCH_THRESHOLD_END: 0.08,
    EXTRUSION_SENSITIVITY: 0.002,
    ZOOM_SENSITIVITY: 0.001,
    CONSTRUCTION_PLANE_Y: 0,
    VIDEO_WIDTH: 1280,
    VIDEO_HEIGHT: 720
};

/**
 * STATE MACHINE
 */
const STATE = {
    mode: 'IDLE',
    gesture: 'NONE',
    pinchDistance: 1.0,
    isPinching: false,
    handCount: 0,
    landmarks: [],
    smoothedLandmarks: [],
    startPoint: null,
    currentPoint: null,
    activeShape: null,
    activeShapeType: null,
    extrusionHeight: 0,
    cameraOffset: new THREE.Vector3(0, 5, 8),
    isCameraReady: false
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
const loadingText = document.getElementById('loading-text');
const startCameraBtn = document.getElementById('start-camera-btn');

// Three.js Globals
let scene, camera, renderer, raycaster, constructionPlane;
let hands; // MediaPipe Hands instance

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
    getIntersectionPoint(raycaster, plane) {
        const intersects = raycaster.intersectObject(plane);
        return intersects.length > 0 ? intersects[0].point : null;
    }
};

/**
 * MEDIAPIPE INITIALIZATION
 */
function initMediaPipe() {
    loadingText.textContent = "Initializing Hand Tracking Model...";
    
    hands = new Hands({locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }});

    hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.7
    });

    hands.onResults(onHandsResults);
    
    loadingText.textContent = "Model Loaded. Waiting for Camera...";
    startCameraBtn.style.display = 'block';
}

/**
 * CAMERA INITIALIZATION (Manual Implementation)
 * Fixes the stuck loop by using native getUserMedia
 */
async function startCamera() {
    startCameraBtn.disabled = true;
    startCameraBtn.textContent = "Requesting Access...";
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: CONFIG.VIDEO_WIDTH },
                height: { ideal: CONFIG.VIDEO_HEIGHT },
                facingMode: 'user'
            }
        });

        videoElement.srcObject = stream;
        
        // Wait for video to be ready
        await new Promise((resolve) => {
            videoElement.onloadedmetadata = () => {
                videoElement.play();
                resolve();
            };
        });

        STATE.isCameraReady = true;
        loadingScreen.classList.add('hidden');
        
        // Start the processing loop
        requestAnimationFrame(processVideoFrame);

    } catch (err) {
        console.error("Camera Error:", err);
        loadingText.textContent = "Camera Access Denied or Error.";
        startCameraBtn.style.display = 'none';
        alert("Please allow camera access to use this application.");
    }
}

/**
 * MANUAL PROCESSING LOOP
 * Draws video to canvas and sends to MediaPipe
 */
async function processVideoFrame() {
    if (!STATE.isCameraReady || videoElement.readyState !== 4) {
        requestAnimationFrame(processVideoFrame);
        return;
    }

    // Update canvas size if video size changed
    if (canvasElement.width !== videoElement.videoWidth || canvasElement.height !== videoElement.videoHeight) {
        canvasElement.width = videoElement.videoWidth;
        canvasElement.height = videoElement.videoHeight;
    }

    // Send current video frame to MediaPipe
    await hands.send({image: videoElement});

    requestAnimationFrame(processVideoFrame);
}

/**
 * GESTURE RECOGNITION
 */
function onHandsResults(results) {
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    STATE.handCount = results.multiHandLandmarks.length;
    STATE.landmarks = results.multiHandLandmarks;

    let detectedGesture = 'NONE';
    let pinchDist = 1.0;

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        const landmarks = results.multiHandLandmarks[0];
        
        // Draw Hand Skeleton
        drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {color: '#00FF00', lineWidth: 2});
        drawLandmarks(canvasCtx, landmarks, {color: '#FF0000', lineWidth: 1, radius: 3});

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

        // Hysteresis
        if (pinchDist < CONFIG.PINCH_THRESHOLD_START) {
            STATE.isPinching = true;
            detectedGesture = 'PINCH';
        } else if (pinchDist > CONFIG.PINCH_THRESHOLD_END) {
            STATE.isPinching = false;
        }

        // Two Hand Logic
        if (results.multiHandLandmarks.length === 2) {
            detectedGesture = 'TWO_HANDS';
            const l1 = results.multiHandLandmarks[0][8];
            const l2 = results.multiHandLandmarks[1][8];
            
            const verticalDiff = Math.abs(l1.y - l2.y);
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
 * INTERACTION LOGIC
 */
function processInteractionLogic() {
    if (!STATE.activeShape && STATE.isPinching && STATE.gesture === 'PINCH' && STATE.handCount === 1) {
        STATE.mode = 'DRAWING';
        const point = getRaycastPoint(STATE.smoothedLandmarks[0][8]);
        if (point) {
            STATE.startPoint = point;
            STATE.currentPoint = point;
            createShapePreview();
        }
    } 
    else if (STATE.mode === 'DRAWING' && STATE.isPinching && STATE.gesture === 'PINCH') {
        const point = getRaycastPoint(STATE.smoothedLandmarks[0][8]);
        if (point) {
            STATE.currentPoint = point;
            updateShapePreview();
        }
    } 
    else if (STATE.mode === 'DRAWING' && !STATE.isPinching) {
        STATE.mode = 'CONFIRMED';
        finalizeShape();
    }
    else if (STATE.mode === 'CONFIRMED' && STATE.gesture === 'TWO_HANDS') {
        STATE.mode = 'EXTRUDING';
    }
    else if (STATE.mode === 'EXTRUDING' && STATE.gesture !== 'TWO_HANDS') {
        STATE.mode = 'CONFIRMED';
    }
    else if (!STATE.isPinching && STATE.handCount === 0) {
        STATE.mode = 'IDLE';
    }
}

function getRaycastPoint(landmark) {
    if (!landmark) return null;
    const ndcX = -(landmark.x * 2 - 1); 
    const ndcY = -(landmark.y * 2 - 1);
    const mouse = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(mouse, camera);
    return MathUtils.getIntersectionPoint(raycaster, constructionPlane);
}

/**
 * SHAPE GENERATION
 */
function createShapePreview() {
    STATE.activeShapeType = 'rectangle';
    const geometry = new THREE.PlaneGeometry(0.1, 0.1);
    const material = new THREE.MeshBasicMaterial({ 
        color: 0x00ff88, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false 
    });
    STATE.activeShape = new THREE.Mesh(geometry, material);
    scene.add(STATE.activeShape);
}

function updateShapePreview() {
    if (!STATE.activeShape || !STATE.startPoint || !STATE.currentPoint) return;

    const width = Math.abs(STATE.currentPoint.x - STATE.startPoint.x);
    const depth = Math.abs(STATE.currentPoint.z - STATE.startPoint.z);
    const centerX = (STATE.startPoint.x + STATE.currentPoint.x) / 2;
    const centerZ = (STATE.startPoint.z + STATE.currentPoint.z) / 2;

    if (STATE.activeShapeType === 'rectangle') {
        STATE.activeShape.scale.set(width, 1, depth);
        STATE.activeShape.position.set(centerX, CONFIG.CONSTRUCTION_PLANE_Y, centerZ);
    }
}

function finalizeShape() {
    if(STATE.activeShape) {
        STATE.activeShape.material.opacity = 0.8;
        STATE.activeShape.material.color.setHex(0x0088ff);
    }
}

function handleExtrusion(separation) {
    if (!STATE.activeShape) return;
    STATE.mode = 'EXTRUDING';
    const targetHeight = separation * 5;
    STATE.extrusionHeight += (targetHeight - STATE.extrusionHeight) * 0.1;

    if (STATE.activeShapeType === 'rectangle') {
        convertToCuboid(STATE.extrusionHeight);
    }
}

function convertToCuboid(height) {
    const width = STATE.activeShape.scale.x;
    const depth = STATE.activeShape.scale.z;
    const pos = STATE.activeShape.position.clone();

    scene.remove(STATE.activeShape);
    STATE.activeShape.geometry.dispose();

    const geometry = new THREE.BoxGeometry(width, height, depth);
    const material = new THREE.MeshStandardMaterial({ color: 0x0088ff, roughness: 0.3, metalness: 0.1, transparent: true, opacity: 0.9 });
    
    STATE.activeShape = new THREE.Mesh(geometry, material);
    STATE.activeShape.position.set(pos.x, height / 2, pos.z);
    scene.add(STATE.activeShape);
}

function handleZoom(separation) {
    const baseZ = 8;
    const targetZ = baseZ - (separation * 10);
    camera.position.z += (targetZ - camera.position.z) * 0.1;
}

/**
 * THREE.JS SETUP
 */
function initThreeJS() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);
    scene.fog = new THREE.Fog(0x1a1a1a, 10, 20);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.copy(STATE.cameraOffset);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    scene.add(dirLight);

    const gridHelper = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    scene.add(gridHelper);

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

function updateHUD() {
    hudMode.textContent = STATE.mode;
    hudGesture.textContent = STATE.gesture;
    hudPinch.textContent = STATE.pinchDistance.toFixed(3);
    hudHands.textContent = STATE.handCount;
    if (STATE.mode === 'DRAWING') hudMode.style.color = '#ffff00';
    else if (STATE.mode === 'EXTRUDING') hudMode.style.color = '#ff00ff';
    else hudMode.style.color = '#00ff88';
}

function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}

// Bootstrap
initThreeJS();
initMediaPipe();
animate();

// Bind Button
startCameraBtn.addEventListener('click', startCamera);
