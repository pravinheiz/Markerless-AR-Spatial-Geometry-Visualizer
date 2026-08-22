import * as THREE from 'three';

/**
 * CONFIGURATION
 */
const CFG = {
    SMOOTHING: 0.4,
    PINCH_DIST: 0.05,
    GRAB_DIST: 0.12, // Avg finger curl threshold
    ROT_SENS: 0.05,
    COLORS: {
        DRAW: 0x00ff88,
        GRAB: 0xffaa00,
        ZOOM: 0x00ccff
    }
};

/**
 * STATE MANAGEMENT
 */
const STATE = {
    mode: 'IDLE', // IDLE, DRAWING, GRABBED, EXTRUDING, ZOOMING
    gesture: 'NONE',
    hands: [],
    landmarks: [], // Smoothed
    objects: [],
    currentLine: null,
    linePoints: [],
    selectedObj: null,
    initTwoHandDist: 0,
    showSkeleton: true
};

// DOM
const video = document.getElementById('webcam-input');
const handCanvas = document.getElementById('hand-canvas');
const handCtx = handCanvas.getContext('2d');
const webglCanvas = document.getElementById('webgl-canvas');
const uiGesture = document.getElementById('gesture-display');
const uiMode = document.getElementById('mode-display');
const uiTrack = document.getElementById('track-bar');
const uiTrackVal = document.getElementById('track-val');
const uiFps = document.getElementById('fps-val');
const crosshair = document.getElementById('crosshair');
const prompt = document.getElementById('prompt');
const loading = document.getElementById('loading');

// Three.js
let scene, camera, renderer, raycaster, plane;
let clock = new THREE.Clock();

/**
 * SECTION 1: MEDIAPIPE INIT (LEGACY API FOR STABILITY)
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

    const cam = new Camera(video, {
        onFrame: async () => await hands.send({image: video}),
        width: 1280,
        height: 720
    });

    cam.start()
        .then(() => {
            loading.style.opacity = 0;
            setTimeout(() => loading.style.display = 'none', 500);
        })
        .catch(err => {
            console.error("Camera Error:", err);
            alert("Camera access failed. Please check permissions.");
        });
}

/**
 * SECTION 2: MATH & FILTERING
 */
const prevLandmarks = [];

function smoothLandmark(current, prev, alpha) {
    if (!prev) return current;
    return {
        x: current.x * alpha + prev.x * (1 - alpha),
        y: current.y * alpha + prev.y * (1 - alpha),
        z: current.z * alpha + prev.z * (1 - alpha)
    };
}

function getDistance(p1, p2) {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2) + Math.pow(p1.z - p2.z, 2));
}

/**
 * SECTION 3: GESTURE RECOGNITION
 */
function onHandsResults(results) {
    // Resize hand canvas
    handCanvas.width = window.innerWidth;
    handCanvas.height = window.innerHeight;
    handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);

    STATE.hands = results.multiHandLandmarks || [];
    STATE.landmarks = [];
    let totalConf = 0;

    if (STATE.hands.length === 0) {
        STATE.gesture = 'NONE';
        if (STATE.mode === 'DRAWING') finalizeDrawing();
        if (STATE.mode === 'GRABBED') STATE.selectedObj = null;
        STATE.mode = 'IDLE';
    }

    STATE.hands.forEach((lmList, idx) => {
        // Smooth
        const smoothed = lmList.map((lm, i) => {
            if (!prevLandmarks[idx]) prevLandmarks[idx] = [];
            prevLandmarks[idx][i] = smoothLandmark(lm, prevLandmarks[idx][i], CFG.SMOOTHING);
            return prevLandmarks[idx][i];
        });
        STATE.landmarks.push(smoothed);
        totalConf += smoothed.reduce((acc, l) => acc + (l.visibility || 1), 0) / 21;

        // Draw Skeleton
        if (STATE.showSkeleton) drawSkeleton(smoothed, idx);

        // Gesture Logic
        const thumb = smoothed[4];
        const index = smoothed[8];
        const middle = smoothed[12];
        const ring = smoothed[16];
        const pinky = smoothed[20];
        const wrist = smoothed[0];

        const pinchDist = getDistance(thumb, index);
        
        // Check Grab (All fingers curled except thumb roughly)
        // Simple heuristic: Distance from tip to wrist is small
        const isGrabbed = 
            getDistance(index, wrist) < 0.3 &&
            getDistance(middle, wrist) < 0.3 &&
            getDistance(ring, wrist) < 0.3 &&
            getDistance(pinky, wrist) < 0.3;

        if (pinchDist < CFG.PINCH_DIST) {
            STATE.gesture = 'PINCH';
            if (STATE.mode === 'IDLE') STATE.mode = 'DRAWING';
        } else if (isGrabbed) {
            STATE.gesture = 'GRAB';
            if (STATE.mode === 'IDLE' || STATE.mode === 'DRAWING') {
                // Try to select nearest object
                selectNearestObject(index);
                if (STATE.selectedObj) STATE.mode = 'GRABBED';
            }
        } else {
            STATE.gesture = 'OPEN';
            if (STATE.mode === 'DRAWING') finalizeDrawing();
            if (STATE.mode === 'GRABBED') STATE.selectedObj = null;
            STATE.mode = 'IDLE';
        }

        // Two Hand Logic
        if (STATE.hands.length === 2) {
            const h1 = STATE.landmarks[0][0];
            const h2 = STATE.landmarks[1][0];
            const dist = getDistance(h1, h2);
            
            if (STATE.gesture === 'PINCH' && STATE.landmarks[1][4]) {
                 const d2 = getDistance(STATE.landmarks[1][4], STATE.landmarks[1][8]);
                 if (d2 < CFG.PINCH_DIST) {
                     STATE.gesture = 'TWO_HAND';
                     // Vertical Diff -> Extrude
                     if (Math.abs(h1.y - h2.y) > 0.2) {
                         STATE.mode = 'EXTRUDING';
                         extrudeObjects(Math.abs(h1.y - h2.y));
                     } 
                     // Horizontal Diff -> Zoom
                     else {
                         STATE.mode = 'ZOOMING';
                         zoomCamera(dist);
                     }
                 }
            }
        }
    });

    updateUI(totalConf / (STATE.hands.length || 1));
}

function drawSkeleton(lm, handIdx) {
    const color = handIdx === 0 ? '#00ff88' : '#00ccff';
    handCtx.strokeStyle = color;
    handCtx.lineWidth = 2;
    handCtx.beginPath();
    
    const connections = [
        [0,1],[1,2],[2,3],[3,4], // Thumb
        [0,5],[5,6],[6,7],[7,8], // Index
        [0,9],[9,10],[10,11],[11,12], // Middle
        [0,13],[13,14],[14,15],[15,16], // Ring
        [0,17],[17,18],[18,19],[19,20], // Pinky
        [5,9],[9,13],[13,17] // Palm
    ];

    connections.forEach(([i, j]) => {
        const p1 = lm[i];
        const p2 = lm[j];
        // Map to screen (CSS mirrors, so we map directly)
        handCtx.moveTo(p1.x * window.innerWidth, p1.y * window.innerHeight);
        handCtx.lineTo(p2.x * window.innerWidth, p2.y * window.innerHeight);
    });
    handCtx.stroke();

    // Draw joints
    lm.forEach((p, i) => {
        handCtx.beginPath();
        handCtx.arc(p.x * window.innerWidth, p.y * window.innerHeight, i===4||i===8 ? 6 : 3, 0, Math.PI*2);
        handCtx.fillStyle = color;
        handCtx.fill();
    });
}

/**
 * SECTION 4: THREE.JS SETUP
 */
function initThree() {
    scene = new THREE.Scene();
    // NO background color set -> Transparent

    camera = new THREE.PerspectiveCamera(45, window.innerWidth/window.innerHeight, 0.1, 100);
    camera.position.set(0, 2, 5);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0); // Crucial for transparency
    renderer.shadowMap.enabled = true;

    // Lights
    const amb = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(amb);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 5);
    dir.castShadow = true;
    scene.add(dir);

    // Grid
    const grid = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    scene.add(grid);

    // Invisible Raycast Plane
    const geo = new THREE.PlaneGeometry(100, 100);
    const mat = new THREE.MeshBasicMaterial({ visible: false });
    plane = new THREE.Mesh(geo, mat);
    plane.rotation.x = -Math.PI / 2;
    scene.add(plane);

    raycaster = new THREE.Raycaster();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

/**
 * SECTION 5: INTERACTION LOGIC
 */
function getRaycastPoint(lm) {
    if (!lm) return null;
    const ndcX = -(lm.x * 2 - 1);
    const ndcY = -(lm.y * 2 - 1);
    const mouse = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(plane);
    return hits.length > 0 ? hits[0].point : null;
}

function selectNearestObject(indexLm) {
    const pt = getRaycastPoint(indexLm);
    if (!pt) return;
    
    // Find closest object within 0.5 units
    let closest = null;
    let minDst = 0.5;
    
    STATE.objects.forEach(obj => {
        const dst = obj.position.distanceTo(pt);
        if (dst < minDst) {
            minDst = dst;
            closest = obj;
        }
    });
    
    STATE.selectedObj = closest;
}

function finalizeDrawing() {
    if (STATE.currentLine) {
        STATE.currentLine.geometry.setDrawRange(0, STATE.linePoints.length);
        STATE.currentLine.userData.isDrawing = false;
        STATE.objects.push(STATE.currentLine);
        STATE.currentLine = null;
        STATE.linePoints = [];
    }
    STATE.mode = 'IDLE';
}

function extrudeObjects(separation) {
    if (!STATE.objects.length) return;
    const last = STATE.objects[STATE.objects.length - 1];
    if (last.type !== 'Line') return; // Only extrude lines for now

    // Convert Line to Tube/Mesh
    if (last.userData.isExtruded) return;
    
    const points = last.geometry.attributes.position.array;
    const curve = new THREE.CatmullRomCurve3(
        points.map((v, i) => new THREE.Vector3(v[i*3], v[i*3+1], v[i*3+2]))
    );
    
    const geo = new THREE.TubeGeometry(curve, 64, 0.05, 8, false);
    const mat = new THREE.MeshStandardMaterial({ color: CFG.COLORS.GRAB, roughness: 0.3 });
    const mesh = new THREE.Mesh(geo, mat);
    
    scene.remove(last);
    last.geometry.dispose();
    
    scene.add(mesh);
    STATE.objects.pop();
    STATE.objects.push(mesh);
    last.userData.isExtruded = true;
}

function zoomCamera(dist) {
    if (STATE.initTwoHandDist === 0) STATE.initTwoHandDist = dist;
    const ratio = dist / STATE.initTwoHandDist;
    const targetFOV = 45 / ratio;
    camera.fov += (targetFOV - camera.fov) * 0.1;
    camera.updateProjectionMatrix();
}

/**
 * SECTION 6: ANIMATION LOOP
 */
function animate() {
    requestAnimationFrame(animate);
    
    const delta = clock.getDelta();
    uiFps.innerText = Math.round(1/delta);

    // Handle Grab Rotation & Movement
    if (STATE.mode === 'GRABBED' && STATE.selectedObj && STATE.landmarks[0]) {
        const lm = STATE.landmarks[0];
        const index = lm[8];
        const wrist = lm[0];
        const middle = lm[12];
        
        // 1. Move Object to Hand Position
        const pos = getRaycastPoint(index);
        if (pos) {
            // Lift object slightly based on Z depth of hand or fixed offset
            STATE.selectedObj.position.lerp(new THREE.Vector3(pos.x, pos.y + 0.5, pos.z), 0.2);
        }

        // 2. Rotate Object based on Wrist Angle
        // Calculate vector from Wrist to Middle Finger
        const wristVec = new THREE.Vector3(wrist.x, wrist.y, wrist.z);
        const midVec = new THREE.Vector3(middle.x, middle.y, middle.z);
        const direction = midVec.sub(wristVec);
        
        // Map 2D screen direction to 3D rotation
        // Tilt Wrist Up/Down -> Rotate X
        // Tilt Wrist Left/Right -> Rotate Y
        
        const angleX = direction.y * 5; // Sensitivity
        const angleY = -direction.x * 5;
        
        STATE.selectedObj.rotation.x += angleX * CFG.ROT_SENS;
        STATE.selectedObj.rotation.y += angleY * CFG.ROT_SENS;
        
        // Visual Feedback
        STATE.selectedObj.material.emissive.setHex(0x333333);
    } else {
        if (STATE.selectedObj) STATE.selectedObj.material.emissive.setHex(0x000000);
    }

    // Handle Drawing
    if (STATE.mode === 'DRAWING' && STATE.landmarks[0]) {
        prompt.classList.remove('hidden');
        const pt = getRaycastPoint(STATE.landmarks[0][8]);
        
        if (pt) {
            crosshair.style.display = 'block';
            // Project 3D to 2D for crosshair
            const vec = pt.clone();
            vec.project(camera);
            crosshair.style.left = (vec.x * .5 + .5) * window.innerWidth + 'px';
            crosshair.style.top = (-(vec.y * .5) + .5) * window.innerHeight + 'px';

            if (!STATE.currentLine) {
                // Start new line
                STATE.linePoints = [pt.x, pt.y, pt.z];
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.Float32BufferAttribute(STATE.linePoints, 3));
                const mat = new THREE.LineBasicMaterial({ color: CFG.COLORS.DRAW, linewidth: 2 });
                STATE.currentLine = new THREE.Line(geo, mat);
                STATE.currentLine.userData.isDrawing = true;
                scene.add(STATE.currentLine);
            } else {
                // Add point
                STATE.linePoints.push(pt.x, pt.y, pt.z);
                STATE.currentLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(STATE.linePoints, 3));
                STATE.currentLine.geometry.setDrawRange(0, STATE.linePoints.length / 3);
            }
        }
    } else {
        prompt.classList.add('hidden');
        crosshair.style.display = 'none';
    }

    renderer.render(scene, camera);
}

function updateUI(conf) {
    uiGesture.innerText = STATE.gesture;
    uiMode.innerText = `Mode: ${STATE.mode}`;
    
    if (STATE.gesture === 'PINCH') uiGesture.style.color = '#ffaa00';
    else if (STATE.gesture === 'GRAB') uiGesture.style.color = '#ff3333';
    else uiGesture.style.color = '#00ff88';

    const pct = Math.min(100, Math.round(conf * 100));
    uiTrack.style.width = `${pct}%`;
    uiTrackVal.innerText = `${pct}%`;
}

document.getElementById('btn-reset').onclick = () => {
    STATE.objects.forEach(o => { scene.remove(o); o.geometry.dispose(); });
    STATE.objects = [];
    STATE.selectedObj = null;
};

document.getElementById('btn-skeleton').onclick = (e) => {
    STATE.showSkeleton = !STATE.showSkeleton;
    e.target.innerText = STATE.showSkeleton ? "Hide Skeleton" : "Show Skeleton";
};

// Start
initThree();
initMediaPipe();
animate();
