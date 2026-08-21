import * as THREE from 'three';

/**
 * CONFIGURATION
 */
const CONFIG = {
    SMOOTHING_ALPHA: 0.65,      // Smoother motion for "floaty" feel
    PINCH_THRESHOLD_START: 0.06,
    PINCH_THRESHOLD_END: 0.09,
    TRAIL_LENGTH: 20,           // Number of particles in trail
    SHAPE_SWITCH_RADIUS: 0.15,  // Radius to detect circular gesture
    FLICK_THRESHOLD: 0.4        // Speed threshold for flick gesture
};

/**
 * STATE MANAGEMENT
 */
const STATE = {
    mode: 'IDLE', // IDLE, DRAWING, CONFIRMED, EXTRUDING
    gesture: 'NONE',
    isPinching: false,
    handCount: 0,
    landmarks: [],
    smoothedLandmarks: [],
    startPoint: null,
    currentPoint: null,
    activeShape: null,
    activeShapeType: 'pyramid', // pyramid, torus, octahedron
    extrusionHeight: 0,
    cameraOffset: new THREE.Vector3(0, 4, 7),
    gesturePath: [], // For detecting circles/flicks
    lastGestureTime: 0
};

// DOM Elements
const videoElement = document.getElementById('input-video');
const canvasElement = document.getElementById('output-canvas');
const canvasCtx = canvasElement.getContext('2d');
const webglCanvas = document.getElementById('webgl-canvas');
const hudMode = document.getElementById('mode-display');
const hudShape = document.getElementById('shape-display');
const hudGesture = document.getElementById('gesture-display');
const loadingScreen = document.getElementById('loading-screen');
const startBtn = document.getElementById('start-camera-btn');

// Three.js Globals
let scene, camera, renderer, raycaster, constructionPlane;
let trailParticles, trailGeometry, trailPositions;
let focusSphere; // The "AVP" focus point

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
    },
    // Detect circular motion approximation
    detectCircle(path) {
        if (path.length < 10) return false;
        // Simple bounding box check for circularity
        const xs = path.map(p => p.x);
        const ys = path.map(p => p.y);
        const width = Math.max(...xs) - Math.min(...xs);
        const height = Math.max(...ys) - Math.min(...ys);
        const aspect = width / height;
        return (aspect > 0.7 && aspect < 1.3) && width > CONFIG.SHAPE_SWITCH_RADIUS;
    },
    // Detect fast flick
    detectFlick(path) {
        if (path.length < 5) return false;
        const start = path[0];
        const end = path[path.length - 1];
        const dist = MathUtils.getDistance(start, end);
        // Assuming ~30fps, if distance covered is large in few frames
        return dist > CONFIG.FLICK_THRESHOLD; 
    }
};

/**
 * INITIALIZATION
 */
function initThreeJS() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050505);
    scene.fog = new THREE.FogExp2(0x050505, 0.035);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.copy(STATE.cameraOffset);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    scene.add(dirLight);

    const pointLight = new THREE.PointLight(0x00ff88, 0.5);
    pointLight.position.set(-5, 5, -5);
    scene.add(pointLight);

    // Grid
    const gridHelper = new THREE.GridHelper(20, 20, 0x333333, 0x111111);
    scene.add(gridHelper);

    // Invisible Raycast Plane
    const planeGeo = new THREE.PlaneGeometry(100, 100);
    const planeMat = new THREE.MeshBasicMaterial({ visible: false });
    constructionPlane = new THREE.Mesh(planeGeo, planeMat);
    constructionPlane.rotation.x = -Math.PI / 2;
    scene.add(constructionPlane);

    raycaster = new THREE.Raycaster();

    // Initialize Trail System
    initTrailSystem();

    // Initialize Focus Sphere (AVP Style)
    const sphereGeo = new THREE.SphereGeometry(0.05, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.8 });
    focusSphere = new THREE.Mesh(sphereGeo, sphereMat);
    focusSphere.visible = false;
    scene.add(focusSphere);

    window.addEventListener('resize', onWindowResize);
}

function initTrailSystem() {
    trailGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(CONFIG.TRAIL_LENGTH * 3);
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    
    const material = new THREE.PointsMaterial({
        color: 0x00ccff,
        size: 0.15,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending
    });

    trailParticles = new THREE.Points(trailGeometry, material);
    scene.add(trailParticles);
    
    // Initialize positions to zero
    for(let i=0; i<CONFIG.TRAIL_LENGTH*3; i++) positions[i] = 0;
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

/**
 * MEDIAPIPE & CAMERA LOGIC
 */
function setupMediaPipe() {
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

    // Manual Camera Loop to avoid CDN utility issues
    async function cameraLoop() {
        if (videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
            await hands.send({image: videoElement});
        }
        requestAnimationFrame(cameraLoop);
    }

    startBtn.addEventListener('click', async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
            });
            videoElement.srcObject = stream;
            videoElement.play();
            
            // Wait for video to load
            videoElement.onloadedmetadata = () => {
                canvasElement.width = videoElement.videoWidth;
                canvasElement.height = videoElement.videoHeight;
                loadingScreen.classList.add('hidden');
                cameraLoop();
            };
        } catch (err) {
            alert("Camera access denied: " + err);
        }
    });
}

/**
 * VISUALIZATION: NEURAL STICK MODEL (AVP Style)
 */
function drawNeuralHand(landmarks, isPinching) {
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    
    if (!landmarks) return;

    const colorBase = isPinching ? '#ff0055' : '#00ff88';
    const lineWidth = isPinching ? 4 : 2;

    // Define connections for "Neural Stick" look (simplified skeleton)
    const connections = [
        [0, 1], [1, 2], [2, 3], [3, 4], // Thumb
        [0, 5], [5, 6], [6, 7], [7, 8], // Index
        [0, 9], [9, 10], [10, 11], [11, 12], // Middle
        [0, 13], [13, 14], [14, 15], [15, 16], // Ring
        [0, 17], [17, 18], [18, 19], [19, 20], // Pinky
        [5, 9], [9, 13], [13, 17] // Palm arches
    ];

    canvasCtx.lineCap = 'round';
    canvasCtx.lineJoin = 'round';

    // Draw Connections
    connections.forEach(([i, j]) => {
        const p1 = landmarks[i];
        const p2 = landmarks[j];
        
        canvasCtx.beginPath();
        canvasCtx.moveTo(p1.x * canvasElement.width, p1.y * canvasElement.height);
        canvasCtx.lineTo(p2.x * canvasElement.width, p2.y * canvasElement.height);
        
        // Gradient stroke
        const gradient = canvasCtx.createLinearGradient(
            p1.x * canvasElement.width, p1.y * canvasElement.height,
            p2.x * canvasElement.width, p2.y * canvasElement.height
        );
        gradient.addColorStop(0, colorBase);
        gradient.addColorStop(1, isPinching ? '#ffaa00' : '#00ccff');
        
        canvasCtx.strokeStyle = gradient;
        canvasCtx.lineWidth = lineWidth;
        canvasCtx.shadowBlur = isPinching ? 15 : 5;
        canvasCtx.shadowColor = colorBase;
        canvasCtx.stroke();
    });

    // Draw Joints as glowing nodes
    landmarks.forEach((p, idx) => {
        if ([4, 8, 12, 16, 20].includes(idx)) { // Only fingertips and thumb tip
            canvasCtx.beginPath();
            canvasCtx.arc(p.x * canvasElement.width, p.y * canvasElement.height, isPinching && idx===8 ? 8 : 4, 0, 2 * Math.PI);
            canvasCtx.fillStyle = '#fff';
            canvasCtx.shadowBlur = 10;
            canvasCtx.shadowColor = '#fff';
            canvasCtx.fill();
        }
    });
}

/**
 * MAIN PROCESSING LOOP
 */
function onHandsResults(results) {
    STATE.handCount = results.multiHandLandmarks.length;
    STATE.landmarks = results.multiHandLandmarks;

    let detectedGesture = 'NONE';
    let pinchDist = 1.0;

    if (results.multiHandLandmarks.length > 0) {
        const lm = results.multiHandLandmarks[0];
        
        // Smooth Landmarks
        if (!STATE.smoothedLandmarks[0]) STATE.smoothedLandmarks[0] = [];
        for (let i = 0; i < 21; i++) {
            STATE.smoothedLandmarks[0][i] = MathUtils.smoothLandmark(
                lm[i], 
                STATE.smoothedLandmarks[0][i], 
                CONFIG.SMOOTHING_ALPHA
            );
        }
        const sLm = STATE.smoothedLandmarks[0];

        // Pinch Detection
        const dist = MathUtils.getDistance(sLm[8], sLm[4]);
        STATE.pinchDistance = dist;
        
        if (dist < CONFIG.PINCH_THRESHOLD_START) STATE.isPinching = true;
        else if (dist > CONFIG.PINCH_THRESHOLD_END) STATE.isPinching = false;

        if (STATE.isPinching) detectedGesture = 'PINCH';

        // Gesture Path Tracking (for Circle/Flick detection)
        if (STATE.isPinching) {
            STATE.gesturePath.push({x: sLm[8].x, y: sLm[8].y, time: Date.now()});
            if (STATE.gesturePath.length > 30) STATE.gesturePath.shift();
            
            // Check for Shape Switching Gestures
            const now = Date.now();
            if (now - STATE.lastGestureTime > 1000) { // Cooldown
                if (MathUtils.detectCircle(STATE.gesturePath)) {
                    switchShape('torus');
                    STATE.lastGestureTime = now;
                    STATE.gesturePath = [];
                } else if (MathUtils.detectFlick(STATE.gesturePath)) {
                    switchShape('octahedron');
                    STATE.lastGestureTime = now;
                    STATE.gesturePath = [];
                }
            }
        } else {
            STATE.gesturePath = [];
        }

        // Two Hand Logic
        if (results.multiHandLandmarks.length === 2) {
            detectedGesture = 'TWO_HANDS';
            const l1 = results.multiHandLandmarks[0][8];
            const l2 = results.multiHandLandmarks[1][8];
            
            if (Math.abs(l1.y - l2.y) > 0.2) handleExtrusion(Math.abs(l1.y - l2.y));
            else if (Math.abs(l1.x - l2.x) > 0.15) handleZoom(Math.abs(l1.x - l2.x));
        }

        // Update 3D Focus Sphere Position
        const rayPoint = getRaycastPoint(sLm[8]);
        if (rayPoint) {
            focusSphere.position.copy(rayPoint);
            focusSphere.visible = STATE.isPinching;
            focusScaleAnimation();
            
            // Update Trail
            updateTrail(rayPoint);
        }

        // Draw AVP Style Hand on Canvas
        drawNeuralHand(sLm, STATE.isPinching);
    } else {
        STATE.isPinching = false;
        STATE.smoothedLandmarks = [];
        focusSphere.visible = false;
    }

    STATE.gesture = detectedGesture;
    updateHUD();
    processInteractionLogic();
}

/**
 * INTERACTION LOGIC
 */
function processInteractionLogic() {
    if (STATE.isPinching && STATE.gesture === 'PINCH' && !STATE.activeShape) {
        STATE.mode = 'DRAWING';
        STATE.startPoint = getRaycastPoint(STATE.smoothedLandmarks[0][8]);
        STATE.currentPoint = STATE.startPoint;
        createShapePreview();
    } 
    else if (STATE.mode === 'DRAWING' && STATE.isPinching) {
        STATE.currentPoint = getRaycastPoint(STATE.smoothedLandmarks[0][8]);
        updateShapePreview();
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
}

function switchShape(type) {
    STATE.activeShapeType = type;
    hudShape.textContent = type.toUpperCase();
    hudShape.style.color = '#ff0055';
    setTimeout(() => hudShape.style.color = '#fff', 500);
    
    // Visual feedback effect
    if (STATE.activeShape) {
        scene.remove(STATE.activeShape);
        STATE.activeShape = null;
        STATE.mode = 'IDLE';
    }
}

function getRaycastPoint(landmark) {
    if (!landmark) return null;
    const ndcX = -(landmark.x * 2 - 1);
    const ndcY = -(landmark.y * 2 - 1);
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    return MathUtils.getIntersectionPoint(raycaster, constructionPlane);
}

function updateTrail(point) {
    const positions = trailParticles.geometry.attributes.position.array;
    // Shift array
    for (let i = (CONFIG.TRAIL_LENGTH - 1) * 3; i > 0; i--) {
        positions[i] = positions[i-1];
    }
    positions[0] = point.x;
    positions[1] = point.y;
    positions[2] = point.z;
    trailParticles.geometry.attributes.position.needsUpdate = true;
}

function focusScaleAnimation() {
    const scale = 1 + Math.sin(Date.now() * 0.01) * 0.2;
    focusSphere.scale.set(scale, scale, scale);
}

/**
 * SHAPE CREATION (CREATIVE MODE)
 */
function createShapePreview() {
    let geometry;
    const material = new THREE.MeshStandardMaterial({ 
        color: 0x00ff88, 
        emissive: 0x004422,
        side: THREE.DoubleSide, 
        transparent: true, 
        opacity: 0.6,
        wireframe: true
    });

    if (STATE.activeShapeType === 'pyramid') {
        geometry = new THREE.ConeGeometry(0.1, 0.2, 4);
    } else if (STATE.activeShapeType === 'torus') {
        geometry = new THREE.TorusGeometry(0.1, 0.03, 8, 16);
    } else if (STATE.activeShapeType === 'octahedron') {
        geometry = new THREE.OctahedronGeometry(0.1);
    }

    STATE.activeShape = new THREE.Mesh(geometry, material);
    STATE.activeShape.castShadow = true;
    scene.add(STATE.activeShape);
}

function updateShapePreview() {
    if (!STATE.activeShape || !STATE.startPoint || !STATE.currentPoint) return;

    const dx = STATE.currentPoint.x - STATE.startPoint.x;
    const dz = STATE.currentPoint.z - STATE.startPoint.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    const angle = Math.atan2(dz, dx);

    const centerX = (STATE.startPoint.x + STATE.currentPoint.x) / 2;
    const centerZ = (STATE.startPoint.z + STATE.currentPoint.z) / 2;

    STATE.activeShape.position.set(centerX, 0, centerZ);
    
    if (STATE.activeShapeType === 'pyramid' || STATE.activeShapeType === 'octahedron') {
        // Scale based on distance
        const scale = Math.max(0.1, dist);
        STATE.activeShape.scale.set(scale, scale, scale);
        STATE.activeShape.rotation.y = -angle;
    } else if (STATE.activeShapeType === 'torus') {
        const radius = dist / 2;
        STATE.activeShape.scale.set(radius/0.1, radius/0.1, radius/0.1);
    }
}

function finalizeShape() {
    STATE.activeShape.material.wireframe = false;
    STATE.activeShape.material.opacity = 0.9;
    STATE.activeShape.material.emissive.setHex(0x000000);
    
    // Add a point light to the shape
    const light = new THREE.PointLight(0x00ff88, 1, 3);
    light.position.set(0, 0.5, 0);
    STATE.activeShape.add(light);
}

function handleExtrusion(separation) {
    if (!STATE.activeShape || STATE.mode !== 'EXTRUDING' && STATE.mode !== 'CONFIRMED') return;
    STATE.mode = 'EXTRUDING';

    const targetHeight = separation * 6;
    STATE.extrusionHeight += (targetHeight - STATE.extrusionHeight) * 0.1;

    // Replace geometry with extruded version
    const pos = STATE.activeShape.position.clone();
    const scale = STATE.activeShape.scale.clone();
    const rot = STATE.activeShape.rotation.clone();
    const color = STATE.activeShape.material.color.clone();

    scene.remove(STATE.activeShape);
    STATE.activeShape.geometry.dispose();

    let newGeo;
    if (STATE.activeShapeType === 'pyramid') {
        newGeo = new THREE.ConeGeometry(scale.x * 0.1, STATE.extrusionHeight, 4);
    } else if (STATE.activeShapeType === 'torus') {
        // Extrude torus into a thick tube ring
        newGeo = new THREE.TorusGeometry(scale.x * 0.1, STATE.extrusionHeight/4, 8, 16);
    } else if (STATE.activeShapeType === 'octahedron') {
        newGeo = new THREE.OctahedronGeometry(scale.x * 0.1 * (1 + STATE.extrusionHeight));
    }

    const newMat = new THREE.MeshPhysicalMaterial({
        color: color,
        metalness: 0.6,
        roughness: 0.2,
        transmission: 0.5, // Glass-like
        thickness: 1.0
    });

    STATE.activeShape = new THREE.Mesh(newGeo, newMat);
    STATE.activeShape.position.set(pos.x, STATE.extrusionHeight/2, pos.z);
    STATE.activeShape.rotation.copy(rot);
    STATE.activeShape.castShadow = true;
    scene.add(STATE.activeShape);
}

function handleZoom(separation) {
    const baseZ = 7;
    const targetZ = baseZ - (separation * 15);
    camera.position.z += (targetZ - camera.position.z) * 0.05;
}

function updateHUD() {
    hudMode.textContent = STATE.mode;
    hudGesture.textContent = STATE.gesture;
    hudMode.style.color = STATE.mode === 'DRAWING' ? '#ffff00' : (STATE.mode === 'EXTRUDING' ? '#ff00ff' : '#00ff88');
}

function animate() {
    requestAnimationFrame(animate);
    
    // Rotate confirmed shapes slowly
    if (STATE.activeShape && STATE.mode === 'CONFIRMED') {
        STATE.activeShape.rotation.y += 0.005;
        STATE.activeShape.rotation.x += 0.002;
    }

    renderer.render(scene, camera);
}

// Bootstrap
initThreeJS();
setupMediaPipe();
animate();
