// SphereTris - main.js

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

console.log("SphereTris starting...");

// --- Core Three.js Setup ---

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 5;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(5, 10, 7.5);
scene.add(directionalLight);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.screenSpacePanning = false;
controls.minDistance = 3;
controls.maxDistance = 10;

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// --- Tile Configuration ---

const tileColors = [
    0x00bcd4, 0xff5722, 0x4caf50, 0xffeb3b, 0x9c27b0, 0xf44336, 0x2196f3
];
let colorIndex = 0;

function getNextColor() {
    const color = tileColors[colorIndex];
    colorIndex = (colorIndex + 1) % tileColors.length;
    return color;
}

// --- Tile Geometries ---
// Define radii
const hexRadius = 1.417;
const pentRadius = 1.25; // Adjusted from 1.28 for better fit

const extrudeSettings = { steps: 1, depth: 0.12, bevelEnabled: false };
const tileDepth = extrudeSettings.depth;

// Hexagon
const hexShape = new THREE.Shape();
hexShape.moveTo(hexRadius * Math.cos(0), hexRadius * Math.sin(0));
for (let i = 1; i <= 6; i++) {
    hexShape.lineTo(hexRadius * Math.cos(i * 2 * Math.PI / 6), hexRadius * Math.sin(i * 2 * Math.PI / 6));
}
const hexGeometry = new THREE.ExtrudeGeometry(hexShape, extrudeSettings);
hexGeometry.center();

// Pentagon - create with no rotation
const pentShape = new THREE.Shape();
// Create pentagon starting at angle 0 (no rotation)
pentShape.moveTo(pentRadius * Math.cos(0), pentRadius * Math.sin(0));
for (let i = 1; i <= 5; i++) {
    pentShape.lineTo(
        pentRadius * Math.cos(i * 2 * Math.PI / 5), 
        pentRadius * Math.sin(i * 2 * Math.PI / 5)
    );
}
const pentGeometry = new THREE.ExtrudeGeometry(pentShape, extrudeSettings);
pentGeometry.center();

// Store geometries for random selection
const tileGeometries = [hexGeometry, pentGeometry];

// --- Game State ---

let activeTiles = [];
let currentFallingTile = null;
let ghostTile = null; // Ghost tile to show landing position
const fallSpeed = 0.005;
const spawnHeight = 7.0;
const keyState = {};
let score = 0;
let level = 1;
let isGameOver = false; // Added for game over state

const GAME_OVER_LAYER_THRESHOLD = 4.2;
const GAME_OVER_WORLD_Y_THRESHOLD = 2.5; // World Y position indicating top-out on the outermost layer

// Track which face each tile is placed on
const occupiedFaces = new Map(); // Maps face index -> tile

// Track tiles by their layers
const layerTiles = new Map(); // Maps layer number -> array of tiles

// --- Game State for Next Piece ---
let nextTileGeometry = null;
let nextTileColor = null;

// --- Debug Controls ---
// Press 'p' to switch to pentagon, 'h' to switch to hexagon
let manualTileSelection = null;

// --- Model Loading ---

let soccerBallMesh = null; // Reference to the base mesh for collision check

const loader = new GLTFLoader();
let soccerBall;

loader.load(
    'assets/soccer_ball.glb',
    function (gltf) { // Success
        soccerBall = gltf.scene;
        soccerBall.traverse((child) => {
            if (child.isMesh) {
                console.log("Soccer ball mesh found:", child.name);
                if (!soccerBallMesh) soccerBallMesh = child; // Store the first mesh found
            }
        });
        scene.add(soccerBall);
        console.log('Model loaded successfully');

        window.addEventListener('keydown', (event) => { 
            keyState[event.code] = true; 
            // Debug: Force specific tile shapes with keyboard
            if (event.key === 'p') manualTileSelection = pentGeometry;
            if (event.key === 'h') manualTileSelection = hexGeometry;
            
            // Hard drop with spacebar
            if (event.code === 'Space' && currentFallingTile) {
                hardDrop();
                // Prevent space from scrolling the page
                event.preventDefault();
            }
        });
        window.addEventListener('keyup', (event) => { keyState[event.code] = false; });
        // window.addEventListener('click', onMouseClick);

        // Create score display
        createScoreDisplay();
        createPiecePreviewDisplay(); 
        createLayerCountDisplay(); // <-- ADDED CALL HERE
        
        // Initialize the first "next" piece before the game starts
        nextTileGeometry = manualTileSelection || tileGeometries[Math.floor(Math.random() * tileGeometries.length)];
        nextTileColor = getNextColor();
        updatePiecePreviewUI(); // Update UI to show the first "next" piece

        spawnNewTile(); // Start the game
    },
    (xhr) => console.log((xhr.loaded / xhr.total * 100) + '% loaded'), // Progress
    (error) => console.error('An error happened loading the model:', error) // Error
);

// --- Input Handling ---

function onMouseClick(event) { // Not used for spawning currently
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = - (event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    if (!soccerBall) return;
    const intersects = raycaster.intersectObject(soccerBall, true);
    if (intersects.length > 0) {
        const intersect = intersects[0];
        if (intersect.faceIndex !== undefined) {
            console.log(`Clicked face: ${intersect.faceIndex} at ${intersect.point.toArray().map(p => p.toFixed(2)).join(', ')}`);
        }
    }
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Game Logic ---

// Function to spawn a new falling tile with axis helpers
function spawnNewTile() {
    if (isGameOver) {
        console.log("Game Over - Cannot spawn new tile.");
        // Clear current/next piece UI if game is over
        const currentShapeGraphic = document.getElementById('current-shape-graphic');
        const nextShapeGraphic = document.getElementById('next-shape-graphic');
        if (currentShapeGraphic) currentShapeGraphic.style.backgroundColor = 'transparent';
        if (nextShapeGraphic) nextShapeGraphic.style.backgroundColor = 'transparent';
        updatePiecePreviewUI(); // To clear them visually based on null currentFallingTile etc.
        return;
    }
    console.log("SPAWNING NEW TILE");
    
    if (currentFallingTile) {
        // Remove previous helpers if any exist before removing tile
        const oldTileHelpers = currentFallingTile.children.filter(child => child.type === 'ArrowHelper');
        oldTileHelpers.forEach(helper => currentFallingTile.remove(helper));
        scene.remove(currentFallingTile);
    }
    
    // Remove ghost tile if it exists
    if (ghostTile) {
        if (ghostTile.parent) {
            ghostTile.parent.remove(ghostTile);
        }
        ghostTile = null;
    }
    
    // Determine geometry and color for the new falling tile
    // The "current" falling tile uses what was previously "next"
    const currentGeometry = nextTileGeometry;
    const currentColorHex = nextTileColor;

    // Generate the *new* "next" piece
    // Allow manualTileSelection to override the randomly generated next piece if a key was pressed
    if (manualTileSelection) {
        nextTileGeometry = manualTileSelection;
        // If manual selection is active, reset it after use so the next piece is random unless pressed again
        // However, for the preview, we want to show what *will* be next if no key is pressed.
        // So, we will generate a random one for the preview, and if a key is pressed *during* this spawn,
        // it will affect the *next* spawn cycle correctly.
        // The current tile will use manualTileSelection if it was set *before* this spawnNewTile call.
    } else {
        nextTileGeometry = tileGeometries[Math.floor(Math.random() * tileGeometries.length)];
    }
    nextTileColor = getNextColor();
    // manualTileSelection is reset by keyup event or used once here if it was set

    currentFallingTile = new THREE.Mesh(currentGeometry, new THREE.MeshStandardMaterial({ color: currentColorHex }));
    currentFallingTile.position.set(0, spawnHeight, 0);
    
    // Calculate direction from spawn position to center (0,0,0)
    const directionToCenter = new THREE.Vector3(0, 0, 0).sub(new THREE.Vector3(0, spawnHeight, 0)).normalize();
    
    // Create a quaternion to rotate the tile to face downward toward the center
    // We want the tile's Z+ axis to point along the direction to center
    const downVector = new THREE.Vector3(0, 0, 1); // Tile's "down" is along +Z
    const rotationQuaternion = new THREE.Quaternion().setFromUnitVectors(downVector, directionToCenter);
    
    // Apply the rotation
    currentFallingTile.quaternion.copy(rotationQuaternion);

    // --- DEBUG: Add Axes Helpers to Falling Tile ---
    const arrowLength = 0.6;
    const headLength = 0.1;
    const headWidth = 0.07;
    // Red = X+, Green = Y+, Blue = Z+
    const arrowX = new THREE.ArrowHelper(new THREE.Vector3(1,0,0), new THREE.Vector3(0,0,0), arrowLength, 0xff0000, headLength, headWidth);
    const arrowY = new THREE.ArrowHelper(new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,0), arrowLength, 0x00ff00, headLength, headWidth);
    const arrowZ = new THREE.ArrowHelper(new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,0), arrowLength, 0x0000ff, headLength, headWidth);
    currentFallingTile.add(arrowX);
    currentFallingTile.add(arrowY);
    currentFallingTile.add(arrowZ);
    // --- END DEBUG ---

    scene.add(currentFallingTile);
    console.log("New tile spawned at", currentFallingTile.position);

    // Update the piece preview UI
    updatePiecePreviewUI();
}

// Main Animation Loop
function animate() {
    requestAnimationFrame(animate);

    if (isGameOver) {
        // Allow camera controls but skip game logic
        controls.update();
        renderer.render(scene, camera);
        return;
    }

    // --- Falling Tile Logic ---
    if (currentFallingTile) {
        const baseFallSpeed = 0.005; // Initial fall speed
        const incrementPerLevel = 0.001; // How much speed increases per level
        const dynamicFallSpeed = baseFallSpeed + (level - 1) * incrementPerLevel;

        const direction = new THREE.Vector3(0, 0, 0).sub(currentFallingTile.position).normalize();
        currentFallingTile.position.add(direction.multiplyScalar(dynamicFallSpeed));

        // Reset approach color if needed
        if (currentFallingTile.material._originalColor !== undefined &&
            currentFallingTile.material.color.getHex() !== currentFallingTile.material._originalColor) {
            currentFallingTile.material.color.setHex(currentFallingTile.material._originalColor);
        }

        // Create a fresh ghost tile every frame for consistent visibility
        // First remove previous ghost if it exists
        if (ghostTile) {
            if (ghostTile.parent) {
                ghostTile.parent.remove(ghostTile);
            }
            ghostTile = null;
        }
        
        // Create new ghost tile with improved appearance
        createSimpleGhostTile();

        if (soccerBall) {
            const collisionRaycaster = new THREE.Raycaster(currentFallingTile.position, direction);
            // Configure raycaster to only detect objects on layer 0 (ignoring ghost tiles)
            collisionRaycaster.layers.set(0);
            
            const intersects = collisionRaycaster.intersectObject(soccerBall, true)
                .filter(hit => !hit.object.userData || !hit.object.userData.isGhost); // Extra filter to ensure no ghosts

            if (intersects.length > 0) {
                const intersect = intersects[0];
                const distanceToSurface = intersect.distance;
                const approachThreshold = tileDepth / 2 + 0.2;
                const collisionThreshold = tileDepth / 2 + 0.01;

                // Approach Indication
                if (distanceToSurface <= approachThreshold && distanceToSurface > collisionThreshold) {
                    if (currentFallingTile.material._originalColor === undefined) {
                        currentFallingTile.material._originalColor = currentFallingTile.material.color.getHex();
                    }
                    currentFallingTile.material.color.set(0xffff00);
                }

                // Collision Check
                if (distanceToSurface <= collisionThreshold) {
                    console.log(`Collision detected! Target: ${intersect.object.name || 'Base Sphere'}`);
                    processTileLanding(intersect);
                }
            }
        }
    }

    // --- Handle Keyboard Rotation for Soccer Ball ---
    if (soccerBall) {
        const rotationSpeed = 0.02;
        const cameraRight = new THREE.Vector3();
        camera.getWorldDirection(cameraRight).cross(camera.up).normalize();
        const horizontalAxis = new THREE.Vector3(0, 1, 0);
        const rotationQuaternion = new THREE.Quaternion();
        let needsUpdate = false;

        if (keyState['ArrowLeft']) { rotationQuaternion.setFromAxisAngle(horizontalAxis, -rotationSpeed); soccerBall.quaternion.premultiply(rotationQuaternion); needsUpdate = true; }
        if (keyState['ArrowRight']) { rotationQuaternion.setFromAxisAngle(horizontalAxis, rotationSpeed); soccerBall.quaternion.premultiply(rotationQuaternion); needsUpdate = true; }
        if (keyState['ArrowUp']) { rotationQuaternion.setFromAxisAngle(cameraRight, -rotationSpeed); soccerBall.quaternion.premultiply(rotationQuaternion); needsUpdate = true; }
        if (keyState['ArrowDown']) { rotationQuaternion.setFromAxisAngle(cameraRight, rotationSpeed); soccerBall.quaternion.premultiply(rotationQuaternion); needsUpdate = true; }

        if (needsUpdate) soccerBall.updateMatrixWorld(true);
    }

    // --- Rendering ---
    controls.update();
    renderer.render(scene, camera);
}

// Simple function to create a basic ghost tile
function createSimpleGhostTile() {
    if (!currentFallingTile || !soccerBall) return;
    
    const raycaster = new THREE.Raycaster();
    const tilePos = new THREE.Vector3();
    currentFallingTile.getWorldPosition(tilePos);
    const direction = new THREE.Vector3(0, 0, 0).sub(tilePos).normalize();
    
    // Set up the raycaster to ignore the ghost tile itself
    raycaster.set(tilePos, direction);
    // We'll use layer 0 for detection but make sure ghost is visible
    raycaster.layers.set(0);
    
    // Cast ray and get intersections, explicitly filtering out ghost tiles
    const intersects = raycaster.intersectObject(soccerBall, true)
        .filter(hit => !hit.object.userData || !hit.object.userData.isGhost);
    
    if (intersects.length > 0) {
        // First remove previous ghost if it exists
        if (ghostTile) {
            if (ghostTile.parent) {
                ghostTile.parent.remove(ghostTile);
            }
            ghostTile = null;
        }
        
        // Create a better ghost tile with Tetris-like appearance
        ghostTile = new THREE.Mesh(
            currentFallingTile.geometry.clone(),
            new THREE.MeshBasicMaterial({
                color: 0xffffff,     // White base color
                transparent: true,
                opacity: 0.4,         // More visible
                wireframe: false,     // Solid fill
                depthTest: true,      // Use depth test to lay properly on surface
                side: THREE.DoubleSide // Render both sides
            })
        );
        
        // Add wireframe on top for better visibility
        const edgesGeometry = new THREE.EdgesGeometry(ghostTile.geometry);
        const edgesMaterial = new THREE.LineBasicMaterial({ 
            color: 0xff00ff,         // Magenta outline
            linewidth: 3,            // Thicker lines
            transparent: true,
            opacity: 0.9             // Very visible outline
        });
        const wireframe = new THREE.LineSegments(edgesGeometry, edgesMaterial);
        ghostTile.add(wireframe);
        
        const intersect = intersects[0];
        const hitObject = intersect.object;
        let landedWorldPosition = new THREE.Vector3();
        let landedWorldQuaternion = new THREE.Quaternion();

        // CASE 1: Hit the base soccer ball mesh
        if (hitObject === soccerBallMesh) {
            const geometry = hitObject.geometry;
            const index = geometry.index;
            const position = geometry.attributes.position;
            const faceIndex = intersect.faceIndex;

            // Calculate Surface Normal (World Space) - Use geometric normal
            const faceNormal = new THREE.Vector3();
            let a, b, c; // vertex indices
            if (index) { a = index.getX(faceIndex * 3); b = index.getX(faceIndex * 3 + 1); c = index.getX(faceIndex * 3 + 2); }
            else { a = faceIndex * 3; b = faceIndex * 3 + 1; c = faceIndex * 3 + 2; } 
            const vA = new THREE.Vector3().fromBufferAttribute(position, a); 
            const vB = new THREE.Vector3().fromBufferAttribute(position, b); 
            const vC = new THREE.Vector3().fromBufferAttribute(position, c); 
            faceNormal.crossVectors(vB.clone().sub(vA), vC.clone().sub(vA));
            faceNormal.normalize(); 
            const worldNormal = faceNormal.clone().transformDirection(hitObject.matrixWorld).normalize();

            // Calculate faceVertexSet for shape detection
            const faceVertexSet = new Set();
            let a_idx = a, b_idx = b, c_idx = c;
            faceVertexSet.add(a_idx); faceVertexSet.add(b_idx); faceVertexSet.add(c_idx);
            if (index) { 
                const posA = new THREE.Vector3().fromBufferAttribute(position, a_idx);
                const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(faceNormal, posA);
                const tolerance = 0.01;
                for (let i = 0; i < index.count / 3; i++) {
                    if (i === faceIndex) continue;
                    const ta = index.getX(i * 3), tb = index.getX(i * 3 + 1), tc = index.getX(i * 3 + 2);
                    const vTa = new THREE.Vector3().fromBufferAttribute(position, ta);
                    if (Math.abs(plane.distanceToPoint(vTa)) < tolerance &&
                        (faceVertexSet.has(ta) || faceVertexSet.has(tb) || faceVertexSet.has(tc)) ) 
                    {
                        faceVertexSet.add(ta); faceVertexSet.add(tb); faceVertexSet.add(tc);
                    }
                }
            } 
            
            // Determine shape and calculate center
            const faceIsPentagon = (faceVertexSet.size === 5);
            const faceIsHexagon = (faceVertexSet.size === 6);

            // Calculate face center
            const faceCenterLocal = new THREE.Vector3(); 
            let vertexCount = 0;
            faceVertexSet.forEach(vIdx => { 
                faceCenterLocal.add(new THREE.Vector3().fromBufferAttribute(position, vIdx));
                vertexCount++; 
            }); 
            
            if (vertexCount > 0) {
                faceCenterLocal.multiplyScalar(1/vertexCount);
            } else { 
                faceCenterLocal.add(vA).add(vB).add(vC).multiplyScalar(1/3); 
            }
            const worldFaceCenter = faceCenterLocal.clone().applyMatrix4(hitObject.matrixWorld);
            
            // Determine tile shape
            const tileIsPentagon = (currentFallingTile.geometry === pentGeometry);
            const tileIsHexagon = (currentFallingTile.geometry === hexGeometry);

            // If shapes don't match, don't show ghost
            if ((faceIsPentagon && tileIsHexagon) || (faceIsHexagon && tileIsPentagon)) {
                // Don't create a ghost for shape mismatch
                if (ghostTile && ghostTile.parent) {
                    ghostTile.parent.remove(ghostTile);
                }
                ghostTile = null;
                return;
            }

            // Position calculation
            const offsetDistance = tileDepth / 2 + 0.005; 
            landedWorldPosition = worldFaceCenter.clone().add(worldNormal.clone().multiplyScalar(offsetDistance));
            
            // Basic orientation alignment
            const tileDownVector = new THREE.Vector3(0, 0, 1); 
            landedWorldQuaternion.setFromUnitVectors(tileDownVector, worldNormal); 

            // Secondary alignment (sides) if shapes match
            if ((faceIsPentagon && tileIsPentagon) || (faceIsHexagon && tileIsHexagon)) {
                const tileRefLocal = new THREE.Vector3(1, 0, 0);
                const faceRefLocal = vA.clone().sub(faceCenterLocal);
                
                const tileRefWorld = tileRefLocal.clone().applyQuaternion(landedWorldQuaternion);
                const faceRefWorld = faceRefLocal.clone().transformDirection(hitObject.matrixWorld);
                const planeNormal = worldNormal;
                const tileRefProjected = tileRefWorld.clone().projectOnPlane(planeNormal).normalize();
                const faceRefProjected = faceRefWorld.clone().projectOnPlane(planeNormal).normalize();
                
                if (tileRefProjected.lengthSq() > 0.001 && faceRefProjected.lengthSq() > 0.001) {
                    let angle = tileRefProjected.angleTo(faceRefProjected);
                    const crossProduct = new THREE.Vector3().crossVectors(tileRefProjected, faceRefProjected);
                    if (crossProduct.dot(planeNormal) < 0) { angle = -angle; }
                    
                    const sideAlignmentQuaternion = new THREE.Quaternion().setFromAxisAngle(planeNormal, angle);
                    landedWorldQuaternion.premultiply(sideAlignmentQuaternion);
                }
            }
        } 
        // CASE 2: Hit a previously landed tile
        else if (!hitObject.userData.isGhost) { // Make sure we're not hitting another ghost
            const hitTile = hitObject;
            
            // Get hit tile's world transform
            const hitTileWorldPos = new THREE.Vector3();
            const hitTileWorldQuat = new THREE.Quaternion();
            hitTile.getWorldPosition(hitTileWorldPos);
            hitTile.getWorldQuaternion(hitTileWorldQuat);

            // Check if shapes match for stacking
            const tileIsPentagon = (currentFallingTile.geometry === pentGeometry);
            const tileIsHexagon = (currentFallingTile.geometry === hexGeometry);
            const landedOnPentagon = (hitTile.geometry === pentGeometry);
            const landedOnHexagon = (hitTile.geometry === hexGeometry);
            
            // If shapes don't match, don't show ghost
            if ((landedOnPentagon && tileIsHexagon) || (landedOnHexagon && tileIsPentagon)) {
                if (ghostTile && ghostTile.parent) {
                    ghostTile.parent.remove(ghostTile);
                }
                ghostTile = null;
                return;
            }

            // Determine the "up" direction of the hit tile in world space
            const tileLocalUp = new THREE.Vector3(0, 0, 1); 
            const hitTileWorldUp = tileLocalUp.clone().applyQuaternion(hitTileWorldQuat).normalize();
           
            // Calculate position (stacking)
            landedWorldPosition = hitTileWorldPos.clone().add(hitTileWorldUp.multiplyScalar(tileDepth));

            // Set orientation to match tile below
            landedWorldQuaternion.copy(hitTileWorldQuat);
        }
        else {
            // For any other object, use simple normal alignment (fallback)
            const hitPoint = intersect.point.clone();
            const normal = intersect.face.normal.clone().transformDirection(soccerBall.matrixWorld);
            
            // Add a small offset along normal
            hitPoint.add(normal.multiplyScalar(0.01));
            landedWorldPosition = hitPoint;
            
            // Set orientation based on normal
            const tileDownVector = new THREE.Vector3(0, 0, 1);
            landedWorldQuaternion.setFromUnitVectors(tileDownVector, normal);
        }

        // NaN Check
        if (isNaN(landedWorldPosition.x) || isNaN(landedWorldPosition.y) || isNaN(landedWorldPosition.z) || 
            isNaN(landedWorldQuaternion.x) || isNaN(landedWorldQuaternion.y) || isNaN(landedWorldQuaternion.z) || isNaN(landedWorldQuaternion.w)) {
            // Don't place ghost with invalid coordinates
            if (ghostTile && ghostTile.parent) {
                ghostTile.parent.remove(ghostTile);
            }
            ghostTile = null;
            return;
        }

        // Position ghost tile in soccer ball's local space
        soccerBall.updateMatrixWorld(true);
        const landedLocalPosition = soccerBall.worldToLocal(landedWorldPosition.clone());
        ghostTile.position.copy(landedLocalPosition);

        // Set ghost rotation from world quaternion
        const parentWorldQuaternionInv = new THREE.Quaternion();
        soccerBall.getWorldQuaternion(parentWorldQuaternionInv).invert();
        ghostTile.quaternion.copy(parentWorldQuaternionInv).multiply(landedWorldQuaternion);
        
        // Add to scene as a child of soccerBall to follow its movements
        soccerBall.add(ghostTile);
        
        // === IMPORTANT: Make ghost non-interactive but VISIBLE ===
        // Tag it as a ghost for filtering in gameplay logic
        ghostTile.userData.isGhost = true;
        
        // Set the render order to ensure it appears on top of existing tiles
        ghostTile.renderOrder = 1000;
        
        // Keep the ghost on the default layer 0 but ensure it doesn't interact with gameplay
        // This is the key change - we DON'T set layers.set(1) anymore to keep it visible
        
        // Make all child objects also properly tagged
        ghostTile.traverse(child => {
            child.userData.isGhost = true;
            child.renderOrder = 1000;
        });
        
        // Log that we've created a ghost
        console.log("Created Tetris-style ghost tile");
    }
}

// --- Start ---
console.log("Three.js setup complete. Starting animation loop...");
animate();

// --- Add game logic functions ---

// --- Revise the layer detection and clearing logic ---
// Identify which face belongs to which layer on the soccer ball
function identifyLayers() {
    // Initialize layers map - we'll group faces by their spherical coordinates
    const layers = {};
    
    // Make sure the soccer ball's world matrix is up to date
    soccerBall.updateMatrixWorld(true);
    
    if (!soccerBallMesh || !soccerBallMesh.geometry) {
        console.error("Soccer ball mesh or geometry is not available");
        return layers;
    }
    
    const geometry = soccerBallMesh.geometry;
    const position = geometry.attributes.position;
    
    // Soccer ball has 5 main horizontal layers when viewed properly
    // Use distance from central axis instead of just y-coordinate
    
    // Get the center of the soccer ball in world space
    const ballCenter = new THREE.Vector3(0, 0, 0).applyMatrix4(soccerBall.matrixWorld);
    // Get the up vector of the soccer ball in world space
    const ballUp = new THREE.Vector3(0, 1, 0).transformDirection(soccerBall.matrixWorld).normalize();
    
    if (geometry.index) {
        // For each face, calculate its center
        const faceData = [];
        
        for (let i = 0; i < geometry.index.count / 3; i++) {
            const a = geometry.index.getX(i * 3);
            const b = geometry.index.getX(i * 3 + 1);
            const c = geometry.index.getX(i * 3 + 2);
            
            const vA = new THREE.Vector3().fromBufferAttribute(position, a);
            const vB = new THREE.Vector3().fromBufferAttribute(position, b);
            const vC = new THREE.Vector3().fromBufferAttribute(position, c);
            
            // Calculate face center
            const faceCenter = new THREE.Vector3()
                .add(vA)
                .add(vB)
                .add(vC)
                .multiplyScalar(1/3);
            
            // Transform to world coordinates
            const worldFaceCenter = faceCenter.clone().applyMatrix4(soccerBallMesh.matrixWorld);
            
            // Calculate vector from ball center to face center
            const centerToFace = worldFaceCenter.clone().sub(ballCenter);
            
            // Project this vector onto the ball's up axis to get position along axis
            const heightAlongAxis = centerToFace.dot(ballUp);
            
            // Use the distance from the central axis for layer grouping
            // (Distance from the ray passing through the center along the up vector)
            const projectedOnUp = ballUp.clone().multiplyScalar(heightAlongAxis);
            const perpendicular = centerToFace.clone().sub(projectedOnUp);
            const distanceFromAxis = perpendicular.length();
            
            // Store face info
            faceData.push({
                index: i,
                axisHeight: heightAlongAxis,
                distanceFromAxis: distanceFromAxis
            });
        }
        
        // Group faces into layers - use primarily axisHeight but with a large tolerance
        // We want approximately 5-6 main layers on the soccer ball
        const heightTolerance = 0.5; // Larger tolerance to group faces into main layers
        
        faceData.forEach(face => {
            const height = Math.round(face.axisHeight / heightTolerance) * heightTolerance;
            const layerKey = height.toFixed(1); // Use one decimal precision for keys
            
            if (!layers[layerKey]) {
                layers[layerKey] = [];
            }
            layers[layerKey].push(face.index);
        });
        
        // Debug info about layers
        console.log(`Found ${Object.keys(layers).length} distinct layers`);
        for (const [key, faces] of Object.entries(layers)) {
            console.log(`Layer ${key}: ${faces.length} faces`);
        }
    }
    
    return layers;
}

// Check for completed layers after a new tile lands
function checkForCompletedLayers() {
    if (activeTiles.length < 5) return; // Need enough tiles to potentially form a layer
    
    // Debug - log the current occupied faces and layers
    console.log(`Currently occupied faces: ${occupiedFaces.size}`);
    console.log(`Current layers: ${Array.from(layerTiles.keys()).join(', ')}`);
    
    // Sort layers from bottom to top (larger distance is lower/outer layer)
    // For soccer ball, LARGER numbers = further from center = OUTER layers
    const sortedLayers = Array.from(layerTiles.keys())
        .map(layer => parseFloat(layer))
        .sort((a, b) => b - a); // Sort larger to smaller (outer to inner)
    
    console.log(`Sorted layers for checking: ${sortedLayers.join(', ')}`);
    
    // Check each layer for completion
    let layersCleared = 0;
    let layersToClear = [];
    
    // First identify all layers that need to be cleared
    for (const layerNumber of sortedLayers) {
        // Get the layer using either number or string key
        const layerKey = layerTiles.has(layerNumber) ? layerNumber : 
                        (layerTiles.has(layerNumber.toString()) ? layerNumber.toString() : null);
                        
        if (!layerKey) {
            console.warn(`Layer ${layerNumber} not found in layerTiles map!`);
            continue;
        }
        
        const tilesInLayer = layerTiles.get(layerKey);
        console.log(`Layer ${layerNumber}: ${tilesInLayer.length} tiles`);
        
        // A complete layer has more than 31 tiles (32 is optimal)
        if (tilesInLayer.length > 31) {
            console.log(`Complete layer ${layerNumber} found with ${tilesInLayer.length} tiles!`);
            layersToClear.push(layerNumber);
            
            // Add score based on layer size
            const layerScore = tilesInLayer.length * 25; 
            score += layerScore;
            console.log(`Layer ${layerNumber} with ${tilesInLayer.length} tiles will be cleared! Score: +${layerScore}`);
            
            // Increment cleared layers counter
            layersCleared++;
        }
    }
    
    // Then clear them one by one from bottom to top (important for proper falling behavior)
    if (layersToClear.length > 0) {
        // Give bonus for clearing multiple layers at once
        if (layersToClear.length > 1) {
            const multiLayerBonus = layersToClear.length * 100;
            score += multiLayerBonus;
            console.log(`Multi-layer bonus: +${multiLayerBonus} points for clearing ${layersToClear.length} layers!`);
        }
        
        // Important: Sort layersToClear from outer to inner (larger to smaller)
        // This ensures we clear from the outside in, which works better for the soccer ball
        layersToClear.sort((a, b) => parseFloat(b) - parseFloat(a)); // Sort from larger to smaller
        
        console.log(`Clearing layers in order: ${layersToClear.join(', ')}`);
        
        // Process layers sequentially to avoid race conditions
        let processNextLayer = function(index) {
            if (index >= layersToClear.length) {
                // All layers have been cleared, update score display
                updateScoreDisplay();
                return;
            }
            
            const layerNumber = layersToClear[index];
            clearLayer(layerNumber)
                .then(() => {
                    // After layer is cleared, make tiles fall
                    makeTilesFall(layerNumber);
                    
                    // Process next layer with a slight delay to allow for animations
                    setTimeout(() => {
                        processNextLayer(index + 1);
                    }, 300); // Increased delay for better visual effect
                });
        };
        
        // Start processing layers
        processNextLayer(0);
        
        // Update level based on score
        level = Math.floor(score / 1000) + 1;
    }

    // After processing all layers and clearing where necessary
    if (layersCleared > 0) {
        console.log(`${layersCleared} layer(s) cleared. Updating score and potentially making tiles fall.`);
        updateScoreDisplay();
        // makeTilesFall will call ensureSequentialLayers, which updates the display.
    } else {
        // If no layers were cleared, but tiles might have been added/moved or state changed.
        updateLayerCountDisplay(); // <-- ADDED CALL HERE
    }
}

// Function to clear a specific layer with improved synchronization
function clearLayer(layerNumber) {
    const layerKey = layerTiles.has(layerNumber) ? layerNumber : 
                    (layerTiles.has(layerNumber.toString()) ? layerNumber.toString() : null);
                    
    if (!layerKey) {
        console.log(`Layer ${layerNumber} not found for clearing`);
        return Promise.resolve();
    }
    
    const tilesToClear = layerTiles.get(layerKey);
    console.log(`Clearing layer ${layerNumber} with ${tilesToClear.length} tiles`);
    
    // Make a copy of the tiles array to avoid modification issues during clearing
    const tilesToClearCopy = [...tilesToClear];
    
    // Clear the tiles
    return clearTiles(tilesToClearCopy).then(() => {
        // Remove tiles from occupiedFaces map
        for (const tile of tilesToClearCopy) {
            if (tile.userData.faceIndex !== undefined) {
                occupiedFaces.delete(tile.userData.faceIndex);
            }
            
            // Remove from activeTiles
            const index = activeTiles.indexOf(tile);
            if (index > -1) {
                activeTiles.splice(index, 1);
            }
        }
        
        // Remove this layer from tracking
        layerTiles.delete(layerKey);
        
        console.log(`Layer ${layerNumber} successfully cleared`);
        // updateLayerCountDisplay(); // <-- REMOVED THIS CALL
    });
}

// Function to make tiles in higher layers fall down - REFACTORED for direct stacking
function makeTilesFall(clearedLayerNumber) {
    const clearedLayerValue = parseFloat(clearedLayerNumber);
    console.log(`Refactored makeTilesFall for clearedLayer: ${clearedLayerValue}`);

    soccerBall.updateMatrixWorld(true); // Ensure soccerBall matrix is up-to-date

    // 1. Atomically extract tiles from layers that need to fall and remove those layers from layerTiles.
    // This map will store originalLayerFloat -> array of tile objects.
    const layersToProcessAboveCleared = new Map(); 

    const currentLayerKeysSnapshot = Array.from(layerTiles.keys()); // Iterate over a snapshot of keys
    for (const layerKey of currentLayerKeysSnapshot) {
        // Ensure key is float for comparison, though ensureSequentialLayers should maintain this
        const layerValFloat = parseFloat(layerKey); 

        if (layerValFloat > clearedLayerValue) { // Only process layers above the cleared one
            const tilesInThisLayer = layerTiles.get(layerKey); // Get the live array from the map

            if (tilesInThisLayer && tilesInThisLayer.length > 0) {
                // Store a copy of the tiles for processing
                layersToProcessAboveCleared.set(layerValFloat, [...tilesInThisLayer]); 
                // Immediately remove the layer from the global map now that we've captured its tiles
                layerTiles.delete(layerKey); 
                console.log(`makeTilesFall: Captured ${tilesInThisLayer.length} tiles from layer ${layerKey} for processing; layer removed from layerTiles.`);
            } else if (tilesInThisLayer && tilesInThisLayer.length === 0) {
                // If the layer exists but is empty, and it's above the cleared layer, remove it.
                layerTiles.delete(layerKey);
                console.log(`makeTilesFall: Removed empty layer ${layerKey} from layerTiles (was above cleared).`);
            }
        }
    }
    
    if (layersToProcessAboveCleared.size === 0) {
        console.log("No outer layers to move inward.");
        ensureSequentialLayers(); // Ensure sequence consistency even if no tiles moved
        return;
    }

    // 2. Remove these extracted tiles from global tracking (activeTiles, occupiedFaces).
    // They are already removed from layerTiles. They will be re-added as they "land".
    layersToProcessAboveCleared.forEach((tilesToClean, originalLayerFloat) => {
        console.log(`makeTilesFall: Preparing ${tilesToClean.length} tiles from original layer ${originalLayerFloat} (already removed from layerTiles).`);
        for (const tile of tilesToClean) {
            const activeIndex = activeTiles.indexOf(tile);
            if (activeIndex > -1) activeTiles.splice(activeIndex, 1);

            if (tile.userData.faceIndex !== undefined) {
                if (occupiedFaces.get(tile.userData.faceIndex) === tile) {
                    occupiedFaces.delete(tile.userData.faceIndex);
                }
            }
        }
    });

    // 3. Define the expected sequence of layer radii/numbers.
    const expectedLayers = [3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.0, 4.1, 4.2];

    const clearedLayerIndexInExpected = expectedLayers.indexOf(clearedLayerValue);
    if (clearedLayerIndexInExpected === -1) {
        console.warn(`Cleared layer ${clearedLayerValue} not in expectedLayers. Aborting makeTilesFall. Orphaned tiles will be removed.`);
        // Remove all tiles that were collected in layersToProcessAboveCleared from the scene
        layersToProcessAboveCleared.forEach((tilesToOrphan, key) => {
            for (const tile of tilesToOrphan) {
                if (tile.parent) tile.parent.remove(tile);
                console.log(`makeTilesFall: Removed orphaned tile (clearedLayer not in expected) from scene.`);
            }
        });
        ensureSequentialLayers();
        return;
    }

    // 4. Process layers sequentially from innermost to outermost that needs to fall
    //    (sortedOriginalLayersToProcess now uses keys from layersToProcessAboveCleared)
    const sortedOriginalLayersToProcess = Array.from(layersToProcessAboveCleared.keys()).sort((a, b) => a - b);

    for (let i = 0; i < sortedOriginalLayersToProcess.length; i++) {
        const originalSourceLayerFloat = sortedOriginalLayersToProcess[i];
        const targetLayerFloat = expectedLayers[clearedLayerIndexInExpected + i];

        if (targetLayerFloat === undefined) {
            console.warn(`Ran out of target layers in expectedLayers for original source ${originalSourceLayerFloat}. Remaining tiles will be removed from scene.`);
            // Remove tiles from this originalSourceLayerFloat and any subsequent ones from the scene
            for (let k = i; k < sortedOriginalLayersToProcess.length; k++) {
                const unprocessedLayerKey = sortedOriginalLayersToProcess[k];
                const tilesToOrphan = layersToProcessAboveCleared.get(unprocessedLayerKey);
                if (tilesToOrphan) {
                    for (const tile of tilesToOrphan) {
                        if (tile.parent) tile.parent.remove(tile);
                        console.log(`makeTilesFall: Removed orphaned tile (no targetLayer) from layer ${unprocessedLayerKey} from scene.`);
                    }
                }
            }
            break; // Stop processing further layers
        }

        console.log(`Processing tiles from original ${originalSourceLayerFloat} to target layer ${targetLayerFloat}`);
        const tilesToMoveThisPass = layersToProcessAboveCleared.get(originalSourceLayerFloat);

        if (!tilesToMoveThisPass || tilesToMoveThisPass.length === 0) continue;

        // Ensure target layer entry exists in layerTiles (use float as key)
        if (!layerTiles.has(targetLayerFloat)) {
            layerTiles.set(targetLayerFloat, []);
        }

        for (const tile of tilesToMoveThisPass) {
            tile.updateMatrixWorld(true); // Ensure tile's own matrix is current
            const tileCurrentWorldPos = new THREE.Vector3();
            tile.getWorldPosition(tileCurrentWorldPos);

            const sphereCenterWorld = new THREE.Vector3().setFromMatrixPosition(soccerBall.matrixWorld);
            const directionToCenter = sphereCenterWorld.clone().sub(tileCurrentWorldPos).normalize();
            const fallRaycaster = new THREE.Raycaster(tileCurrentWorldPos, directionToCenter);

            const raycastTargets = [soccerBallMesh];
            layerTiles.forEach((tilesInLayerList, layerKey) => {
                if (parseFloat(layerKey) < targetLayerFloat) { // Consider tiles already settled in layers *below* the current target
                    raycastTargets.push(...tilesInLayerList);
                }
            });
            const finalRaycastTargets = raycastTargets.filter(obj => obj !== tile); 

            const intersects = fallRaycaster.intersectObjects(finalRaycastTargets, false);

            let landedWorldPosition = new THREE.Vector3();
            let landedWorldQuaternion = new THREE.Quaternion();
            let newFaceIndexOfTile = tile.userData.faceIndex; 

            if (intersects.length > 0) {
                const intersect = intersects[0];
                const hitObject = intersect.object;

                if (hitObject === soccerBallMesh) {
                    console.log(`Tile (orig ${originalSourceLayerFloat}) landing on soccerBallMesh face ${intersect.faceIndex}`);
                    newFaceIndexOfTile = intersect.faceIndex;

                    // --- Start: Ported and adapted logic from processTileLanding for sphere face interaction ---
                    const geometry = hitObject.geometry;
                    const index = geometry.index;
                    const positionAttribute = geometry.attributes.position;
                    const faceIdx = intersect.faceIndex;

                    const geometricFaceNormalLocal = new THREE.Vector3();
                    let vA_idx, vB_idx, vC_idx;
                    if (index) { 
                        vA_idx = index.getX(faceIdx * 3); 
                        vB_idx = index.getX(faceIdx * 3 + 1); 
                        vC_idx = index.getX(faceIdx * 3 + 2); 
                    } else { 
                        vA_idx = faceIdx * 3; 
                        vB_idx = faceIdx * 3 + 1; 
                        vC_idx = faceIdx * 3 + 2; 
                    }
                    const vA_vec = new THREE.Vector3().fromBufferAttribute(positionAttribute, vA_idx);
                    const vB_vec = new THREE.Vector3().fromBufferAttribute(positionAttribute, vB_idx);
                    const vC_vec = new THREE.Vector3().fromBufferAttribute(positionAttribute, vC_idx);
                    geometricFaceNormalLocal.crossVectors(vB_vec.clone().sub(vA_vec), vC_vec.clone().sub(vA_vec)).normalize();
                    const worldGeometricNormal = geometricFaceNormalLocal.clone().transformDirection(hitObject.matrixWorld).normalize();

                    const faceVertexSet = new Set();
                    faceVertexSet.add(vA_idx); faceVertexSet.add(vB_idx); faceVertexSet.add(vC_idx);
                    if (index) {
                        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(geometricFaceNormalLocal, vA_vec);
                        const tolerance = 0.01; 
                        for (let k = 0; k < index.count / 3; k++) {
                            if (k === faceIdx) continue;
                            const ta = index.getX(k * 3), tb = index.getX(k * 3 + 1), tc = index.getX(k * 3 + 2);
                            const vTa = new THREE.Vector3().fromBufferAttribute(positionAttribute, ta);
                            if (Math.abs(plane.distanceToPoint(vTa)) < tolerance &&
                                (faceVertexSet.has(ta) || faceVertexSet.has(tb) || faceVertexSet.has(tc))) {
                                faceVertexSet.add(ta); faceVertexSet.add(tb); faceVertexSet.add(tc);
                            }
                        }
                    }
                    
                    const faceIsPentagon = (faceVertexSet.size === 5);
                    const faceIsHexagon = (faceVertexSet.size === 6);

                    const faceCenterLocal = new THREE.Vector3();
                    let vertexCount = 0;
                    faceVertexSet.forEach(vIdx => {
                        faceCenterLocal.add(new THREE.Vector3().fromBufferAttribute(positionAttribute, vIdx));
                        vertexCount++;
                    });
                    if (vertexCount > 0) faceCenterLocal.multiplyScalar(1 / vertexCount);
                    else faceCenterLocal.add(vA_vec).add(vB_vec).add(vC_vec).multiplyScalar(1/3); 

                    const worldFaceCenter = faceCenterLocal.clone().applyMatrix4(hitObject.matrixWorld);
                    
                    const tileIsPentagon = (tile.geometry === pentGeometry);
                    const tileIsHexagon = (tile.geometry === hexGeometry);

                    if ((faceIsPentagon && tileIsHexagon) || (faceIsHexagon && tileIsPentagon)) {
                         console.log(`makeTilesFall: Shape mismatch! Tile (${tileIsPentagon ? 'P' : 'H'}) on Face (${faceIsPentagon ? 'P' : 'H'}). Skipping side alignment.`);
                        const offsetDistance = tileDepth / 2 + 0.005;
                        landedWorldPosition.copy(worldFaceCenter).add(worldGeometricNormal.clone().multiplyScalar(offsetDistance));
                        const tileDownVector = new THREE.Vector3(0, 0, 1);
                        landedWorldQuaternion.setFromUnitVectors(tileDownVector, worldGeometricNormal);
                    } else {
                        const offsetDistance = tileDepth / 2 + 0.005;
                        landedWorldPosition.copy(worldFaceCenter).add(worldGeometricNormal.clone().multiplyScalar(offsetDistance));
                        
                        const tileDownVector = new THREE.Vector3(0, 0, 1);
                        landedWorldQuaternion.setFromUnitVectors(tileDownVector, worldGeometricNormal);

                        if ((faceIsPentagon && tileIsPentagon) || (faceIsHexagon && tileIsHexagon)) {
                            const tileRefLocal = new THREE.Vector3(1, 0, 0); 
                            const faceRefLocal = vA_vec.clone().sub(faceCenterLocal); 
                            
                            const tileRefWorld = tileRefLocal.clone().applyQuaternion(landedWorldQuaternion);
                            const faceRefWorld = faceRefLocal.clone().transformDirection(hitObject.matrixWorld); 

                            const planeNormalForAlignment = worldGeometricNormal; 
                            const tileRefProjected = tileRefWorld.clone().projectOnPlane(planeNormalForAlignment).normalize();
                            const faceRefProjected = faceRefWorld.clone().projectOnPlane(planeNormalForAlignment).normalize();

                            if (tileRefProjected.lengthSq() > 0.001 && faceRefProjected.lengthSq() > 0.001) {
                                let angle = tileRefProjected.angleTo(faceRefProjected);
                                const crossProduct = new THREE.Vector3().crossVectors(tileRefProjected, faceRefProjected);
                                if (crossProduct.dot(planeNormalForAlignment) < 0) { angle = -angle; }
                                
                                const sideAlignmentQuaternion = new THREE.Quaternion().setFromAxisAngle(planeNormalForAlignment, angle);
                                landedWorldQuaternion.premultiply(sideAlignmentQuaternion);
                                console.log(`makeTilesFall: Performed side alignment (Shape match: ${faceIsPentagon ? 'Pent' : 'Hex'})`);
                            } else {
                                console.warn("makeTilesFall: Could not project reference vectors for side alignment on sphere face.");
                            }
                        }
                    }
                    // --- End: Ported and adapted logic ---

                } else { // Landed on another tile
                    console.log(`Tile (orig ${originalSourceLayerFloat}) stacking on another tile (layer ${hitObject.userData.layerNumber})`);
                    const hitTileWorldPos = new THREE.Vector3();
                    const hitTileWorldQuat = new THREE.Quaternion();
                    hitObject.getWorldPosition(hitTileWorldPos);
                    hitObject.getWorldQuaternion(hitTileWorldQuat);
                    const tileLocalUp = new THREE.Vector3(0, 0, 1); 
                    const hitTileWorldUp = tileLocalUp.clone().applyQuaternion(hitTileWorldQuat).normalize();
                    landedWorldPosition.copy(hitTileWorldPos).add(hitTileWorldUp.multiplyScalar(tileDepth));
                    landedWorldQuaternion.copy(hitTileWorldQuat);
                    newFaceIndexOfTile = hitObject.userData.faceIndex; 
                }
            } else {
                console.warn(`Tile (orig ${originalSourceLayerFloat}) found NO landing spot! Placing radially at target layer ${targetLayerFloat}.`);
                const dirFromCenterToOldPos = tileCurrentWorldPos.clone().sub(sphereCenterWorld).normalize();
                landedWorldPosition.copy(sphereCenterWorld).add(dirFromCenterToOldPos.multiplyScalar(targetLayerFloat));
                const tileDownVector = new THREE.Vector3(0, 0, 1);
                const approxWorldNormal = dirFromCenterToOldPos.clone().negate(); 
                landedWorldQuaternion.setFromUnitVectors(tileDownVector, approxWorldNormal);
                newFaceIndexOfTile = undefined; 
            }

            // NaN Check
            if (isNaN(landedWorldPosition.x) || isNaN(landedWorldPosition.y) || isNaN(landedWorldPosition.z) ||
                isNaN(landedWorldQuaternion.x) || isNaN(landedWorldQuaternion.y) || isNaN(landedWorldQuaternion.z) || isNaN(landedWorldQuaternion.w) ) {
                console.error(`NaN detected for tile from original ${originalSourceLayerFloat}. Removing tile from scene.`);
                if (tile.parent) {
                    tile.parent.remove(tile); // Remove from scene graph
                }
                continue; // Skip this tile's final placement and adding to game logic
            }

            // Apply Transform to soccerBall's local space
            const landedLocalPosition = soccerBall.worldToLocal(landedWorldPosition.clone());
            tile.position.copy(landedLocalPosition);
            const parentWorldQuaternionInv = new THREE.Quaternion().copy(soccerBall.quaternion).invert(); 
            tile.quaternion.copy(parentWorldQuaternionInv).multiply(landedWorldQuaternion);

            // Update Tile Metadata
            tile.userData.layerNumber = targetLayerFloat;
            if (newFaceIndexOfTile !== undefined) {
                tile.userData.faceIndex = newFaceIndexOfTile;
                occupiedFaces.set(newFaceIndexOfTile, tile);
            } else {
                delete tile.userData.faceIndex;
            }

            layerTiles.get(targetLayerFloat).push(tile); // Add to the live layerTiles map
            activeTiles.push(tile); // Add back to activeTiles
            console.log(`Moved tile (orig ${originalSourceLayerFloat}) to new layer ${targetLayerFloat} at loc (${landedLocalPosition.x.toFixed(2)},${landedLocalPosition.y.toFixed(2)},${landedLocalPosition.z.toFixed(2)})`);
        }
    }
    
    // Clean up any empty layers that might have been created in layerTiles if no tiles landed in them
    // (ensureSequentialLayers will also handle adding missing expected layers)
    const finalLayerKeys = Array.from(layerTiles.keys());
    for (const key of finalLayerKeys) {
        const tilesInLayer = layerTiles.get(key);
        if (tilesInLayer && tilesInLayer.length === 0) {
            // Let ensureSequentialLayers handle whether to keep it or not based on expected sequence.
            // For now, just log. ensureSequentialLayers will add it back if it's an expected empty layer.
            // layerTiles.delete(key); // This might be too aggressive if ensureSequentialLayers expects to find it
            console.log(`makeTilesFall: Layer ${key} is empty after processing.`);
        }
    }
    
    soccerBall.updateMatrixWorld(true);
    console.log(`makeTilesFall complete. Final active layers: ${Array.from(layerTiles.keys()).map(k => parseFloat(k).toFixed(1)).sort((a,b)=>a-b).join(', ')}`);
    ensureSequentialLayers(); // Good to call this to re-verify and clean up layer map keys
    updateLayerCountDisplay(); // <-- Add this call for good measure
}

// Function to clear tiles with improved synchronization
function clearTiles(tilesToClear) {
    console.log(`Clearing ${tilesToClear.length} tiles`);
    
    // Create a promise that resolves when all tiles are cleared
    return new Promise((resolve) => {
        let tilesRemaining = tilesToClear.length;
        
        // If no tiles to clear, resolve immediately
        if (tilesRemaining === 0) {
            resolve();
            return;
        }
        
        // Animate the clearing with a fade-out and shrink effect
        tilesToClear.forEach(tile => {
            // Add a flash effect before fading
            const originalColor = tile.material.color.clone();
            tile.material.color.set(0xffff00); // Flash yellow
            
            // Make tile transparent
            tile.material.transparent = true;
            
            // Start with a brief delay to show the flash
            setTimeout(() => {
                // Create a fade-out animation
                const fadeOut = {value: 1.0};
                const originalScale = tile.scale.clone();
                
                const fadeAnimation = setInterval(() => {
                    fadeOut.value -= 0.08; // Slightly faster fade
                    
                    if (fadeOut.value <= 0) {
                        clearInterval(fadeAnimation);
                        
                        // Remove tile from scene
                        if (tile.parent) {
                            tile.parent.remove(tile);
                        }
                        
                        // Decrement counter and check if all tiles are cleared
                        tilesRemaining--;
                        if (tilesRemaining === 0) {
                            resolve(); // All tiles cleared, resolve the promise
                        }
                    } else {
                        // Fade the color and scale down
                        tile.material.color.setRGB(
                            originalColor.r, 
                            originalColor.g, 
                            originalColor.b
                        ).multiplyScalar(fadeOut.value);
                        
                        tile.material.opacity = fadeOut.value;
                        
                        // Also shrink the tile as it fades
                        tile.scale.copy(originalScale).multiplyScalar(0.5 + fadeOut.value * 0.5);
                    }
                }, 15); // Speed up animation slightly
            }, 100); // Brief delay for flash effect
        });
    });
}

// Add a simple score display to the screen
function createScoreDisplay() {
    const scoreElement = document.createElement('div');
    scoreElement.id = 'score-display';
    scoreElement.style.position = 'absolute';
    scoreElement.style.top = '20px';
    scoreElement.style.left = '20px';
    scoreElement.style.color = 'white';
    scoreElement.style.fontFamily = 'Arial, sans-serif';
    scoreElement.style.fontSize = '24px';
    scoreElement.style.textShadow = '2px 2px 4px rgba(0, 0, 0, 0.5)';
    document.body.appendChild(scoreElement);
    
    updateScoreDisplay();
}

// Update the score display
function updateScoreDisplay() {
    const scoreElement = document.getElementById('score-display');
    if (scoreElement) { // Check if element exists before updating
        scoreElement.innerHTML = `Score: ${score}<br>Level: ${level}`;
    }
}

// --- Completely revised hardDrop function ---
function hardDrop() {
    if (!currentFallingTile || !soccerBall) return;
    
    // Get the current position of the falling tile
    const tilePos = new THREE.Vector3();
    currentFallingTile.getWorldPosition(tilePos);
    
    // Direction from tile to sphere center (0,0,0)
    const direction = new THREE.Vector3(0, 0, 0).sub(tilePos).normalize();
    
    // Create a raycaster to find the landing position
    const collisionRaycaster = new THREE.Raycaster(tilePos, direction);
    // Configure raycaster to only detect objects on layer 0 (ignoring ghost tiles)
    collisionRaycaster.layers.set(0);
    
    soccerBall.updateMatrixWorld(true); // Ensure matrix is up to date
    
    // Get intersections with the soccer ball, filtering out any ghost tiles
    const intersects = collisionRaycaster.intersectObject(soccerBall, true)
        .filter(hit => !hit.object.userData || !hit.object.userData.isGhost); // Extra filter to ensure no ghosts
    
    if (intersects.length > 0) {
        // Process the same landing code that would happen in a normal collision
        const intersect = intersects[0];
        console.log(`Hard drop collision! Target: ${intersect.object.name || 'Base Sphere'}`);
        
        // Remove ghost tile
        if (ghostTile) {
            if (ghostTile.parent) {
                ghostTile.parent.remove(ghostTile);
            }
            ghostTile = null;
        }
        
        // Call our existing landing logic directly
        processTileLanding(intersect);
    }
}

// --- Extract the landing logic into a separate function ---
function processTileLanding(intersect) {
    // Remove ghost tile if it exists
    if (ghostTile) {
        if (ghostTile.parent) {
            ghostTile.parent.remove(ghostTile);
        }
        ghostTile = null;
    }
    
    // Skip if the intersected object is a ghost
    if (intersect.object.userData && intersect.object.userData.isGhost) {
        console.log("Ignoring collision with ghost tile");
        return;
    }
    
    // --- Land Tile Logic --- 
    const hitObject = intersect.object;
    let landedWorldPosition = new THREE.Vector3();
    let landedWorldQuaternion = new THREE.Quaternion();

    // CASE 1: Hit the base soccer ball mesh
    if (hitObject === soccerBallMesh) {
        console.log("Landed on base sphere face.");
        const geometry = hitObject.geometry;
        const index = geometry.index;
        const position = geometry.attributes.position;
        const faceIndex = intersect.faceIndex;

        // 1a. Calculate Surface Normal (World Space) - Use geometric normal
        const faceNormal = new THREE.Vector3();
        let a, b, c; // vertex indices
        if (index) { a = index.getX(faceIndex * 3); b = index.getX(faceIndex * 3 + 1); c = index.getX(faceIndex * 3 + 2); }
        else { a = faceIndex * 3; b = faceIndex * 3 + 1; c = faceIndex * 3 + 2; } 
        const vA = new THREE.Vector3().fromBufferAttribute(position, a); 
        const vB = new THREE.Vector3().fromBufferAttribute(position, b); 
        const vC = new THREE.Vector3().fromBufferAttribute(position, c); 
        faceNormal.crossVectors(vB.clone().sub(vA), vC.clone().sub(vA));
        faceNormal.normalize(); 
        const worldNormal = faceNormal.clone().transformDirection(hitObject.matrixWorld).normalize();

        // --- Calculate faceVertexSet FIRST --- 
        const faceVertexSet = new Set();
        let a_idx = a, b_idx = b, c_idx = c;
        faceVertexSet.add(a_idx); faceVertexSet.add(b_idx); faceVertexSet.add(c_idx);
        if (index) { 
            const posA = new THREE.Vector3().fromBufferAttribute(position, a_idx);
            const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(faceNormal, posA);
            const tolerance = 0.01;
            for (let i = 0; i < index.count / 3; i++) {
                if (i === faceIndex) continue;
                const ta = index.getX(i * 3), tb = index.getX(i * 3 + 1), tc = index.getX(i * 3 + 2);
                const vTa = new THREE.Vector3().fromBufferAttribute(position, ta);
                const vTb = new THREE.Vector3().fromBufferAttribute(position, tb);
                const vTc = new THREE.Vector3().fromBufferAttribute(position, tc);
                if (Math.abs(plane.distanceToPoint(vTa)) < tolerance &&
                    (faceVertexSet.has(ta) || faceVertexSet.has(tb) || faceVertexSet.has(tc)) ) 
                {
                    faceVertexSet.add(ta); faceVertexSet.add(tb); faceVertexSet.add(tc);
                }
            }
        } 
        // --- End faceVertexSet calculation ---
        
        // --- Now determine shape and calculate center --- 
        const faceIsPentagon = (faceVertexSet.size === 5);
        const faceIsHexagon = (faceVertexSet.size === 6);

        // Use simple center calculation that works for both shapes
        const faceCenterLocal = new THREE.Vector3(); 
        let vertexCount = 0;
        faceVertexSet.forEach(vIdx => { 
            faceCenterLocal.add(new THREE.Vector3().fromBufferAttribute(position, vIdx));
            vertexCount++; 
        }); 
        
        if (vertexCount > 0) {
            faceCenterLocal.multiplyScalar(1/vertexCount);
        } else { 
            faceCenterLocal.add(vA).add(vB).add(vC).multiplyScalar(1/3); 
        }
        const worldFaceCenter = faceCenterLocal.clone().applyMatrix4(hitObject.matrixWorld);
        console.log(`Using calculated center. Face is ${faceIsPentagon ? 'Pentagon' : (faceIsHexagon ? 'Hexagon' : 'Other')}`);
                                    
        // Determine tile shape
        const tileIsPentagon = (currentFallingTile.geometry === pentGeometry);
        const tileIsHexagon = (currentFallingTile.geometry === hexGeometry);

        // If the shapes don't match (hex on pent or pent on hex), penalize and prevent stacking
        if ((faceIsPentagon && tileIsHexagon) || (faceIsHexagon && tileIsPentagon)) {
            console.log(`Shape mismatch! ${tileIsPentagon ? 'Pentagon' : 'Hexagon'} cannot be placed on ${faceIsPentagon ? 'pentagon' : 'hexagon'} face`);
            
            // Apply a score penalty
            const penalty = 15;
            score = Math.max(0, score - penalty); // Ensure score doesn't go below 0
            console.log(`Penalty applied: -${penalty} points`);
            
            // Create a warning effect - flash the tile red
            const originalColor = currentFallingTile.material.color.clone();
            currentFallingTile.material.color.set(0xff0000); // Bright red
            
            // Animate the tile fading away
            const fadeOut = {value: 1.0};
            const fadeAnimation = setInterval(() => {
                fadeOut.value -= 0.05;
                if (fadeOut.value <= 0) {
                    clearInterval(fadeAnimation);
                    
                    // Remove the tile
                    scene.remove(currentFallingTile);
                    currentFallingTile = null;
                    
                    // Update score display
                    updateScoreDisplay();
                    
                    // Spawn a new tile
                    console.log("Shape mismatch! Spawning new tile...");
                    spawnNewTile();
                } else {
                    // Fade out the tile
                    currentFallingTile.material.opacity = fadeOut.value;
                    currentFallingTile.material.transparent = true;
                }
            }, 30);
            
            // Exit the landing function early - don't process normal landing
            return;
        }

        // If shapes match or we're landing on another tile, continue with normal landing logic
        const offsetDistance = tileDepth / 2 + 0.005; 
        landedWorldPosition = worldFaceCenter.clone().add(worldNormal.clone().multiplyScalar(offsetDistance));
        
        // --- Align Orientation ---
        const tileDownVector = new THREE.Vector3(0, 0, 1); 
        landedWorldQuaternion.setFromUnitVectors(tileDownVector, worldNormal); 

        // --- Secondary Alignment (Sides - If Shape Matches) ---
        // Perform side alignment if shapes match (Pent <-> Pent or Hex <-> Hex)
        if ( (faceIsPentagon && tileIsPentagon) || (faceIsHexagon && tileIsHexagon) ) {
            // Use the faceCenterLocal calculated above
            const tileRefLocal = new THREE.Vector3(1, 0, 0);
            const faceRefLocal = vA.clone().sub(faceCenterLocal);
            
            const tileRefWorld = tileRefLocal.clone().applyQuaternion(landedWorldQuaternion);
            const faceRefWorld = faceRefLocal.clone().transformDirection(hitObject.matrixWorld);
            const planeNormal = worldNormal;
            const tileRefProjected = tileRefWorld.clone().projectOnPlane(planeNormal).normalize();
            const faceRefProjected = faceRefWorld.clone().projectOnPlane(planeNormal).normalize();
            if (tileRefProjected.lengthSq() > 0.001 && faceRefProjected.lengthSq() > 0.001) {
                let angle = tileRefProjected.angleTo(faceRefProjected);
                const crossProduct = new THREE.Vector3().crossVectors(tileRefProjected, faceRefProjected);
                if (crossProduct.dot(planeNormal) < 0) { angle = -angle; }
                
                const sideAlignmentQuaternion = new THREE.Quaternion().setFromAxisAngle(planeNormal, angle);
                landedWorldQuaternion.premultiply(sideAlignmentQuaternion);
                console.log(`Performed side alignment (Shape match: ${faceIsPentagon ? 'Pent' : 'Hex'})`);
            } else {
                console.warn("Could not project reference vectors for side alignment.");
            }
        } else {
            console.log(`Skipped side alignment (Face=${faceIsPentagon ? 'Pent' : (faceIsHexagon ? 'Hex' : 'Other')}, Tile=${tileIsPentagon ? 'Pent' : (tileIsHexagon ? 'Hex' : 'Other')})`);
        }
    } 
    // CASE 2: Hit a previously landed tile
    else {
        console.log("Landed on existing tile.");
        const hitTile = hitObject; // It must be a tile mesh
        
        // Get hit tile's world transform
        const hitTileWorldPos = new THREE.Vector3();
        const hitTileWorldQuat = new THREE.Quaternion();
        hitTile.getWorldPosition(hitTileWorldPos);
        hitTile.getWorldQuaternion(hitTileWorldQuat);

        // Check if the tile shapes match for stacking
        const tileIsPentagon = (currentFallingTile.geometry === pentGeometry);
        const tileIsHexagon = (currentFallingTile.geometry === hexGeometry);
        
        // Determine shape of the tile being landed on
        const landedOnPentagon = (hitTile.geometry === pentGeometry);
        const landedOnHexagon = (hitTile.geometry === hexGeometry);
        
        // If the shapes don't match, penalize and prevent stacking
        if ((landedOnPentagon && tileIsHexagon) || (landedOnHexagon && tileIsPentagon)) {
            console.log(`Shape mismatch in stack! ${tileIsPentagon ? 'Pentagon' : 'Hexagon'} cannot be placed on ${landedOnPentagon ? 'pentagon' : 'hexagon'} tile`);
            
            // Apply a score penalty
            const penalty = 15;
            score = Math.max(0, score - penalty); // Ensure score doesn't go below 0
            console.log(`Penalty applied: -${penalty} points`);
            
            // Create a warning effect - flash the tile red
            const originalColor = currentFallingTile.material.color.clone();
            currentFallingTile.material.color.set(0xff0000); // Bright red
            
            // Animate the tile fading away
            const fadeOut = {value: 1.0};
            const fadeAnimation = setInterval(() => {
                fadeOut.value -= 0.05;
                if (fadeOut.value <= 0) {
                    clearInterval(fadeAnimation);
                    
                    // Remove the tile
                    scene.remove(currentFallingTile);
                    currentFallingTile = null;
                    
                    // Update score display
                    updateScoreDisplay();
                    
                    // Spawn a new tile
                    console.log("Stack shape mismatch! Spawning new tile...");
                    spawnNewTile();
                } else {
                    // Fade out the tile
                    currentFallingTile.material.opacity = fadeOut.value;
                    currentFallingTile.material.transparent = true;
                }
            }, 30);
            
            // Exit the landing function early - don't process normal landing
            return;
        }

        // Determine the "up" direction of the hit tile in world space
        // Assuming tile's local Z+ axis points away from the surface it rests on
        const tileLocalUp = new THREE.Vector3(0, 0, 1); 
        const hitTileWorldUp = tileLocalUp.clone().applyQuaternion(hitTileWorldQuat).normalize();
       
        // 2b. Calculate Landed Position (Stacking - Centered)
        // Offset from the center of the tile below along its up direction
        landedWorldPosition = hitTileWorldPos.clone().add(hitTileWorldUp.multiplyScalar(tileDepth));

        // 2c. Set Landed Quaternion (Match orientation of tile below)
        landedWorldQuaternion.copy(hitTileWorldQuat);
    }

    // NaN Check (Applies to both cases)
    if (isNaN(landedWorldPosition.x) || isNaN(landedWorldPosition.y) || isNaN(landedWorldPosition.z) || 
        isNaN(landedWorldQuaternion.x) || isNaN(landedWorldQuaternion.y) || isNaN(landedWorldQuaternion.z) || isNaN(landedWorldQuaternion.w) ) {
        console.error("NaN detected in landed transform! Skipping landing.");
        // Potentially reset or just don't spawn the tile
        scene.remove(currentFallingTile);
        currentFallingTile = null;
        spawnNewTile(); // Spawn a new one maybe?
        return; // Exit collision logic for this frame
    }
    
    // --- Create and Place Landed Tile (Common Logic) --- 
    // 4. Create Landed Tile Instance
    if (currentFallingTile.material._originalColor !== undefined) {
        currentFallingTile.material.color.setHex(currentFallingTile.material._originalColor);
        delete currentFallingTile.material._originalColor;
    }
    const landedTile = currentFallingTile.clone();
    const landedTileHelpers = landedTile.children.filter(child => child.type === 'ArrowHelper');
    landedTileHelpers.forEach(helper => landedTile.remove(helper));
    if (landedTile.material._originalColor !== undefined) {
        delete landedTile.material._originalColor;
    }

    // 5. Position Tile in Soccer Ball's Local Space
    soccerBall.updateMatrixWorld(true); // Ensure parent matrix is current
    const landedLocalPosition = soccerBall.worldToLocal(landedWorldPosition.clone());
    landedTile.position.copy(landedLocalPosition);

    // 6. Set Tile Rotation from World Quaternion
    // We calculated the desired world rotation (landedWorldQuaternion).
    // To set it correctly when the tile is parented to soccerBall, we need
    // to calculate the equivalent local rotation relative to the parent.
    const parentWorldQuaternionInv = new THREE.Quaternion();
    soccerBall.getWorldQuaternion(parentWorldQuaternionInv).invert();
    landedTile.quaternion.copy(parentWorldQuaternionInv).multiply(landedWorldQuaternion);
   
    // 7. Add to Scene Graph & Cleanup
    soccerBall.add(landedTile);
    activeTiles.push(landedTile);
    
    // Store face -> tile mapping
    if (intersect.faceIndex !== undefined) {
        occupiedFaces.set(intersect.faceIndex, landedTile);
        // Store the face index on the tile for easier reference
        landedTile.userData.faceIndex = intersect.faceIndex;
    }

    scene.remove(currentFallingTile); // Remove original from main scene
    currentFallingTile = null;

    // Assign layer information to the tile based on distance from center
    soccerBall.updateMatrixWorld(true);
    const tileWorldPos = new THREE.Vector3();
    landedTile.getWorldPosition(tileWorldPos);
    const sphereCenter = new THREE.Vector3(0, 0, 0).applyMatrix4(soccerBall.matrixWorld);

    // Calculate distance from center
    const distanceFromCenter = tileWorldPos.distanceTo(sphereCenter);
    
    // Determine which exact layer value this tile should be assigned to
    // Define expected layer values - ONLY these values should be used
    const exactLayerValues = [3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.0, 4.1, 4.2];
    
    // Check if we need to ensure sequential layer values - for example, 
    // if 3.3 and 3.5 exist but 3.4 doesn't, we should use 3.4
    const existingLayers = Array.from(layerTiles.keys())
        .map(layer => parseFloat(layer))
        .sort((a, b) => a - b); // Sort from innermost to outermost
    
    let layerNumber;
    
    // First, find the closest exact layer value based on distance
    let closestExactLayer = exactLayerValues[0];
    let minDifference = Math.abs(distanceFromCenter - exactLayerValues[0]);
    for (let i = 1; i < exactLayerValues.length; i++) {
        const diff = Math.abs(distanceFromCenter - exactLayerValues[i]);
        if (diff < minDifference) {
            minDifference = diff;
            closestExactLayer = exactLayerValues[i];
        }
    }

    // Determine layerNumber: prioritize filling a 'sandwiched' missing exact layer if suitable,
    // otherwise use the closest exact layer. This also handles the case of the very first tile.
    let identifiedMissingExactLayer = null;
    // Check for a sandwiched missing layer only if there are enough layers to form a sandwich.
    if (existingLayers.length >= 2 && exactLayerValues.length >=3) {
        for (let k = 1; k < exactLayerValues.length - 1; k++) { // Iterate through 'internal' exact layers
            const prevExact = exactLayerValues[k-1];
            const currentExact = exactLayerValues[k]; // This is the potential missing layer
            const nextExact = exactLayerValues[k+1];

            if (existingLayers.includes(prevExact) &&
                !existingLayers.includes(currentExact) && // currentExact is missing
                existingLayers.includes(nextExact)) {
                
                // Found a sandwiched missing layer: currentExact.
                // Check if the tile is close enough to this missing layer.
                if (Math.abs(distanceFromCenter - currentExact) < 0.5) { // Using 0.5 threshold from original logic
                    identifiedMissingExactLayer = currentExact;
                    break; // Use the first suitable missing layer found
                }
            }
        }
    }

    if (identifiedMissingExactLayer !== null) {
        layerNumber = identifiedMissingExactLayer;
        console.log(`Filling missing exact layer ${layerNumber} due to proximity and sequence gap.`);
    } else {
        // If no suitable missing layer to fill, or not enough existing/exact layers for the sandwich check,
        // default to the closest exact layer. This also handles the case of the very first tile.
        layerNumber = closestExactLayer;
        if (existingLayers.length === 0) {
            console.log(`First tile - assigning to closest exact layer ${layerNumber} (distance: ${distanceFromCenter.toFixed(2)})`);
        } else {
            console.log(`Using closest exact layer ${layerNumber} (distance: ${distanceFromCenter.toFixed(2)}), no suitable gap found/filled.`);
        }
    }

    // Store layer information in the tile's userData
    landedTile.userData.layerNumber = layerNumber;

    // Add tile to the layer tracking
    if (!layerTiles.has(layerNumber)) {
        layerTiles.set(layerNumber, []);
    }
    layerTiles.get(layerNumber).push(landedTile);
    console.log(`Tile added to layer ${layerNumber}. Layer now has ${layerTiles.get(layerNumber).length} tiles.`);
    
    // Check for Game Over condition
    if (!isGameOver && landedTile.userData.layerNumber >= GAME_OVER_LAYER_THRESHOLD) {
        const landedTileWorldPosCheck = new THREE.Vector3();
        landedTile.getWorldPosition(landedTileWorldPosCheck);
        if (landedTileWorldPosCheck.y >= GAME_OVER_WORLD_Y_THRESHOLD) {
            triggerGameOver();
        }
    }
    
    // IMPORTANT: Check for completed layers immediately BEFORE spawning a new tile
    // Use a small timeout to ensure the layer state is properly updated first
    setTimeout(() => {
        if (isGameOver) { // Check if game ended while waiting for timeout
             // Ensure UI for current/next piece is cleared if game over happened during timeout
            const currentShapeGraphic = document.getElementById('current-shape-graphic');
            const nextShapeGraphic = document.getElementById('next-shape-graphic');
            if (currentShapeGraphic) currentShapeGraphic.style.backgroundColor = 'transparent';
            if (nextShapeGraphic) nextShapeGraphic.style.backgroundColor = 'transparent';
            if(currentFallingTile === null) updatePiecePreviewUI(); // Refresh if falling tile was nulled by gameover
            return;
        }

        const tilesInCurrentLayer = layerTiles.get(layerNumber);
        if (tilesInCurrentLayer && tilesInCurrentLayer.length > 31) {
            console.log(`Layer ${layerNumber} immediately reached completion with ${tilesInCurrentLayer.length} tiles!`);
        }
        checkForCompletedLayers();
        
        updateScoreDisplay();
        updateLayerCountDisplay(); // <-- ADDED CALL HERE
        
        console.log("Spawning next tile...");
        spawnNewTile();
    }, 10);

    // Helper function to ensure sequential layer values are maintained
    ensureSequentialLayers();
}

// Helper function to ensure sequential layer values are maintained
function ensureSequentialLayers() {
    // Define the expected sequence of layer values
    const expectedLayers = [3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.0, 4.1, 4.2];
    
    // Standardize layerTiles to use float keys and remove empty/string-key duplicates
    const newLayerTiles = new Map();
    const allKeys = Array.from(layerTiles.keys());
    const seenFloatKeys = new Set();

    for (const key of allKeys) {
        const floatKey = parseFloat(key);
        if (isNaN(floatKey)) {
            console.warn(`ensureSequentialLayers: Found NaN key: ${key}, removing.`);
            layerTiles.delete(key); // remove problematic key
            continue;
        }

        const tiles = layerTiles.get(key);
        if (tiles && tiles.length > 0) {
            if (!newLayerTiles.has(floatKey)) {
                newLayerTiles.set(floatKey, []);
            }
            // Merge tiles if floatKey was already processed from a string version
            // This also handles consolidating string and float versions of the same key.
            const existingTilesForFloat = newLayerTiles.get(floatKey);
            for (const tile of tiles) {
                if (!existingTilesForFloat.includes(tile)) {
                    existingTilesForFloat.push(tile);
                }
            }
        } 
    }
    // Replace old layerTiles with the standardized one
    layerTiles.clear();
    newLayerTiles.forEach((tiles, key) => layerTiles.set(key, tiles));
    
    // Get the current layers (now guaranteed to be float keys if not empty)
    const currentLayers = Array.from(layerTiles.keys()).sort((a, b) => a - b); // Sort from inner to outer
    
    if (currentLayers.length <= 1) {
        console.log('ensureSequentialLayers: 0 or 1 layer, no sequence to fix.');
        return; 
    }
    
    console.log(`ensureSequentialLayers: Checking sequence: ${currentLayers.join(', ')}`);
    
    let missingLayers = [];
    const minLayerPresent = currentLayers[0];
    const maxLayerPresent = currentLayers[currentLayers.length - 1];

    // Find the range in expectedLayers that covers our min/max present layers
    let startIndex = expectedLayers.indexOf(minLayerPresent);
    if (startIndex === -1) startIndex = 0; // If min not in expected, start check from lowest expected
    
    let endIndex = expectedLayers.indexOf(maxLayerPresent);
    if (endIndex === -1) endIndex = expectedLayers.length -1; // If max not in expected, check up to highest expected

    for (let i = startIndex; i <= endIndex; i++) {
        const expectedLayer = expectedLayers[i];
        if (expectedLayer < minLayerPresent) continue; // Don't add expected layers below our actual minimum
        if (expectedLayer > maxLayerPresent && !currentLayers.includes(expectedLayer)) continue; // Don't add expected far beyond our max unless it's missing *within* our range
        
        if (!layerTiles.has(expectedLayer)) { // Check using float key
             // Only add as missing if it's between min and max present layers, or if it's an edge creating a gap
             if (expectedLayer > minLayerPresent && expectedLayer < maxLayerPresent) {
                missingLayers.push(expectedLayer);
             } else if (expectedLayer === minLayerPresent && !layerTiles.has(expectedLayer)) {
                 // This case should not happen if currentLayers is derived from layerTiles.keys()
             } else if (expectedLayer === maxLayerPresent && !layerTiles.has(expectedLayer)) {
                 // ditto
             }
        }
    }
    
    if (missingLayers.length > 0) {
        console.log(`ensureSequentialLayers: Found missing layers in sequence: ${missingLayers.join(', ')}`);
        for (const missingLayer of missingLayers) {
            if (!layerTiles.has(missingLayer)) { // Double check before adding
                console.log(`ensureSequentialLayers: Adding empty layer ${missingLayer} to maintain sequence`);
                layerTiles.set(missingLayer, []);
            }
        }
    } else {
        console.log('ensureSequentialLayers: Layer sequence appears complete within its range or no gaps found.');
    }

    // Renumbering logic was removed as part of previous requests. 
    // If tiles end up on non-expected layers due to bugs, this function won't fix their numbers,
    // only ensures empty placeholders for sequence.
    console.log("ensureSequentialLayers completed. Final layer keys:", Array.from(layerTiles.keys()).map(k => parseFloat(k).toFixed(1)).sort((a,b)=>a-b).join(', '));
    updateLayerCountDisplay(); // Update display after any modifications
}

// --- Ghost Tile Function ---
function updateGhostTile() {
    if (!currentFallingTile || !soccerBall) return;
    
    // Remove previous ghost if it exists
    if (ghostTile) {
        if (ghostTile.parent) {
            ghostTile.parent.remove(ghostTile);
        }
        ghostTile = null;
    }
    
    // Get the current position of the falling tile
    const tilePos = new THREE.Vector3();
    currentFallingTile.getWorldPosition(tilePos);
    
    // Direction from tile to sphere center
    const direction = new THREE.Vector3(0, 0, 0).sub(tilePos).normalize();
    
    // Create a raycaster to find the landing position
    const collisionRaycaster = new THREE.Raycaster(tilePos, direction);
    soccerBall.updateMatrixWorld(true); // Ensure matrix is up to date
    
    // Important: Only include objects that should actually be part of gameplay
    // We need to ignore existing ghost tiles in raycasting
    const raycastTargets = [soccerBall];
    
    // Get intersections with soccer ball and placed tiles, but NOT with ghost tiles
    const intersects = collisionRaycaster.intersectObject(soccerBall, true)
        .filter(hit => !hit.object.userData.isGhost); // Extra filter to ensure no ghosts
    
    if (intersects.length > 0) {
        const intersect = intersects[0];
        const hitObject = intersect.object;
        
        // Skip if the hit object is itself a ghost tile (should never happen now)
        if (hitObject === ghostTile) return;
        
        // Don't create ghost if we're going to hit wrong shape
        const tileIsPentagon = (currentFallingTile.geometry === pentGeometry);
        const tileIsHexagon = (currentFallingTile.geometry === hexGeometry);
        
        if (hitObject === soccerBallMesh) {
            // Check if landing on face with incompatible shape
            const geometry = hitObject.geometry;
            const index = geometry.index;
            const position = geometry.attributes.position;
            const faceIndex = intersect.faceIndex;
            
            // Calculate face vertex set (copied from processTileLanding)
            const faceNormal = new THREE.Vector3();
            let a, b, c; // vertex indices
            if (index) { a = index.getX(faceIndex * 3); b = index.getX(faceIndex * 3 + 1); c = index.getX(faceIndex * 3 + 2); }
            else { a = faceIndex * 3; b = faceIndex * 3 + 1; c = faceIndex * 3 + 2; } 
            const vA = new THREE.Vector3().fromBufferAttribute(position, a); 
            const vB = new THREE.Vector3().fromBufferAttribute(position, b); 
            const vC = new THREE.Vector3().fromBufferAttribute(position, c); 
            faceNormal.crossVectors(vB.clone().sub(vA), vC.clone().sub(vA));
            faceNormal.normalize();
            
            const faceVertexSet = new Set();
            let a_idx = a, b_idx = b, c_idx = c;
            faceVertexSet.add(a_idx); faceVertexSet.add(b_idx); faceVertexSet.add(c_idx);
            
            if (index) { 
                const posA = new THREE.Vector3().fromBufferAttribute(position, a_idx);
                const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(faceNormal, posA);
                const tolerance = 0.01;
                for (let i = 0; i < index.count / 3; i++) {
                    if (i === faceIndex) continue;
                    const ta = index.getX(i * 3), tb = index.getX(i * 3 + 1), tc = index.getX(i * 3 + 2);
                    const vTa = new THREE.Vector3().fromBufferAttribute(position, ta);
                    if (Math.abs(plane.distanceToPoint(vTa)) < tolerance &&
                        (faceVertexSet.has(ta) || faceVertexSet.has(tb) || faceVertexSet.has(tc)) ) 
                    {
                        faceVertexSet.add(ta); faceVertexSet.add(tb); faceVertexSet.add(tc);
                    }
                }
            }
            
            const faceIsPentagon = (faceVertexSet.size === 5);
            const faceIsHexagon = (faceVertexSet.size === 6);
            
            // If shapes don't match, don't show ghost
            if ((faceIsPentagon && tileIsHexagon) || (faceIsHexagon && tileIsPentagon)) {
                return;
            }
        } else {
            // Check if stacking on a tile with incompatible shape
            const landedOnPentagon = (hitObject.geometry === pentGeometry);
            const landedOnHexagon = (hitObject.geometry === hexGeometry);
            
            if ((landedOnPentagon && tileIsHexagon) || (landedOnHexagon && tileIsPentagon)) {
                return;
            }
        }
        
        // Create a new ghost based on the current falling tile
        ghostTile = currentFallingTile.clone();
        
        // Remove any helpers from the ghost
        const ghostHelpers = ghostTile.children.filter(child => child.type === 'ArrowHelper');
        ghostHelpers.forEach(helper => ghostTile.remove(helper));
        
        // Make ghost HIGHLY visible with a BRIGHT neon color
        ghostTile.material = new THREE.MeshStandardMaterial({
            color: 0xff00ff,     // Bright magenta
            emissive: 0xff00ff,  // Self-illuminating with same color
            emissiveIntensity: 0.8,
            transparent: true,
            opacity: 0.8,        // More opaque for better visibility
            depthWrite: false,   // Prevent z-fighting
            wireframe: false
        });
        
        // == Add edge highlighting for better visibility ==
        const edgesGeometry = new THREE.EdgesGeometry(ghostTile.geometry);
        const edgesMaterial = new THREE.LineBasicMaterial({ 
            color: 0xffffff,  // White edges
            linewidth: 2
        });
        const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
        ghostTile.add(edges);
        
        // === CRITICAL: Ensure the ghost doesn't affect game ===
        // Add a special flag to identify this as a ghost
        ghostTile.userData.isGhost = true;
        
        // Make sure the ghost is never used in collision detection
        // By setting these flags, raycaster and collision detection will ignore this mesh
        ghostTile.layers.set(1); // Put on layer 1 (default is 0)
        ghostTile.visible = true;
        ghostTile.matrixAutoUpdate = true;
        
        // --- USING EXACT SAME LANDING LOGIC AS processTileLanding ---
        let landedWorldPosition = new THREE.Vector3();
        let landedWorldQuaternion = new THREE.Quaternion();

        // CASE 1: Hit the base soccer ball mesh
        if (hitObject === soccerBallMesh) {
            const geometry = hitObject.geometry;
            const index = geometry.index;
            const position = geometry.attributes.position;
            const faceIndex = intersect.faceIndex;

            // 1a. Calculate Surface Normal (World Space) - Use geometric normal
            const faceNormal = new THREE.Vector3();
            let a, b, c; // vertex indices
            if (index) { a = index.getX(faceIndex * 3); b = index.getX(faceIndex * 3 + 1); c = index.getX(faceIndex * 3 + 2); }
            else { a = faceIndex * 3; b = faceIndex * 3 + 1; c = faceIndex * 3 + 2; } 
            const vA = new THREE.Vector3().fromBufferAttribute(position, a); 
            const vB = new THREE.Vector3().fromBufferAttribute(position, b); 
            const vC = new THREE.Vector3().fromBufferAttribute(position, c); 
            faceNormal.crossVectors(vB.clone().sub(vA), vC.clone().sub(vA));
            faceNormal.normalize(); 
            const worldNormal = faceNormal.clone().transformDirection(hitObject.matrixWorld).normalize();

            // --- Calculate faceVertexSet FIRST --- 
            const faceVertexSet = new Set();
            let a_idx = a, b_idx = b, c_idx = c;
            faceVertexSet.add(a_idx); faceVertexSet.add(b_idx); faceVertexSet.add(c_idx);
            if (index) { 
                const posA = new THREE.Vector3().fromBufferAttribute(position, a_idx);
                const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(faceNormal, posA);
                const tolerance = 0.01;
                for (let i = 0; i < index.count / 3; i++) {
                    if (i === faceIndex) continue;
                    const ta = index.getX(i * 3), tb = index.getX(i * 3 + 1), tc = index.getX(i * 3 + 2);
                    const vTa = new THREE.Vector3().fromBufferAttribute(position, ta);
                    if (Math.abs(plane.distanceToPoint(vTa)) < tolerance &&
                        (faceVertexSet.has(ta) || faceVertexSet.has(tb) || faceVertexSet.has(tc)) ) 
                    {
                        faceVertexSet.add(ta); faceVertexSet.add(tb); faceVertexSet.add(tc);
                    }
                }
            } 
            
            // --- Now determine shape and calculate center --- 
            const faceIsPentagon = (faceVertexSet.size === 5);
            const faceIsHexagon = (faceVertexSet.size === 6);

            // Use simple center calculation that works for both shapes
            const faceCenterLocal = new THREE.Vector3(); 
            let vertexCount = 0;
            faceVertexSet.forEach(vIdx => { 
                faceCenterLocal.add(new THREE.Vector3().fromBufferAttribute(position, vIdx));
                vertexCount++; 
            }); 
            
            if (vertexCount > 0) {
                faceCenterLocal.multiplyScalar(1/vertexCount);
            } else { 
                faceCenterLocal.add(vA).add(vB).add(vC).multiplyScalar(1/3); 
            }
            const worldFaceCenter = faceCenterLocal.clone().applyMatrix4(hitObject.matrixWorld);
            
            // If shapes match, continue with normal landing logic
            const offsetDistance = tileDepth / 2 + 0.005; 
            landedWorldPosition = worldFaceCenter.clone().add(worldNormal.clone().multiplyScalar(offsetDistance));
            
            // --- Align Orientation ---
            const tileDownVector = new THREE.Vector3(0, 0, 1); 
            landedWorldQuaternion.setFromUnitVectors(tileDownVector, worldNormal); 

            // --- Secondary Alignment (Sides - If Shape Matches) ---
            // Perform side alignment if shapes match (Pent <-> Pent or Hex <-> Hex)
            if ((faceIsPentagon && tileIsPentagon) || (faceIsHexagon && tileIsHexagon)) {
                // Use the faceCenterLocal calculated above
                const tileRefLocal = new THREE.Vector3(1, 0, 0);
                const faceRefLocal = vA.clone().sub(faceCenterLocal);
                
                const tileRefWorld = tileRefLocal.clone().applyQuaternion(landedWorldQuaternion);
                const faceRefWorld = faceRefLocal.clone().transformDirection(hitObject.matrixWorld);
                const planeNormal = worldNormal;
                const tileRefProjected = tileRefWorld.clone().projectOnPlane(planeNormal).normalize();
                const faceRefProjected = faceRefWorld.clone().projectOnPlane(planeNormal).normalize();
                if (tileRefProjected.lengthSq() > 0.001 && faceRefProjected.lengthSq() > 0.001) {
                    let angle = tileRefProjected.angleTo(faceRefProjected);
                    const crossProduct = new THREE.Vector3().crossVectors(tileRefProjected, faceRefProjected);
                    if (crossProduct.dot(planeNormal) < 0) { angle = -angle; }
                    
                    const sideAlignmentQuaternion = new THREE.Quaternion().setFromAxisAngle(planeNormal, angle);
                    landedWorldQuaternion.premultiply(sideAlignmentQuaternion);
                }
            }
        } 
        // CASE 2: Hit a previously landed tile
        else {
            const hitTile = hitObject; // It must be a tile mesh
            
            // Get hit tile's world transform
            const hitTileWorldPos = new THREE.Vector3();
            const hitTileWorldQuat = new THREE.Quaternion();
            hitTile.getWorldPosition(hitTileWorldPos);
            hitTile.getWorldQuaternion(hitTileWorldQuat);

            // Determine the "up" direction of the hit tile in world space
            const tileLocalUp = new THREE.Vector3(0, 0, 1); 
            const hitTileWorldUp = tileLocalUp.clone().applyQuaternion(hitTileWorldQuat).normalize();
           
            // 2b. Calculate Landed Position (Stacking - Centered)
            landedWorldPosition = hitTileWorldPos.clone().add(hitTileWorldUp.multiplyScalar(tileDepth));

            // 2c. Set Landed Quaternion (Match orientation of tile below)
            landedWorldQuaternion.copy(hitTileWorldQuat);
        }

        // NaN Check (Applies to both cases)
        if (isNaN(landedWorldPosition.x) || isNaN(landedWorldPosition.y) || isNaN(landedWorldPosition.z) || 
            isNaN(landedWorldQuaternion.x) || isNaN(landedWorldQuaternion.y) || isNaN(landedWorldQuaternion.z) || isNaN(landedWorldQuaternion.w)) {
            return; // Don't show ghost with invalid coordinates
        }

        // Position ghost tile in soccer ball's local space
        soccerBall.updateMatrixWorld(true);
        const landedLocalPosition = soccerBall.worldToLocal(landedWorldPosition.clone());
        ghostTile.position.copy(landedLocalPosition);

        // Set ghost tile rotation
        const parentWorldQuaternionInv = new THREE.Quaternion();
        soccerBall.getWorldQuaternion(parentWorldQuaternionInv).invert();
        ghostTile.quaternion.copy(parentWorldQuaternionInv).multiply(landedWorldQuaternion);
        
        // Add ghost to the soccer ball rather than the scene to ensure it moves with the ball
        soccerBall.add(ghostTile);
        
        // Add a very small offset to avoid z-fighting and ensure it's drawn on top
        ghostTile.renderOrder = 10;
        
        // Log to console that we're showing a ghost
        console.log("Ghost tile created and showing at", landedLocalPosition);
    }
}

// --- Ghost Tile Debug Function ---
function debugGhostTile() {
    console.log("=== GHOST TILE DEBUG ===");
    
    // Check if ghost tile exists
    console.log("Ghost tile exists:", ghostTile !== null);
    
    if (ghostTile) {
        console.log("Ghost parent:", ghostTile.parent ? ghostTile.parent.type : "none");
        console.log("Ghost visible:", ghostTile.visible);
        console.log("Ghost position:", ghostTile.position);
        console.log("Ghost color:", ghostTile.material.color.getHexString());
        console.log("Ghost opacity:", ghostTile.material.opacity);
        console.log("Ghost on layer:", ghostTile.layers.mask);
        console.log("Ghost has edges:", ghostTile.children.length > 0);
    }
    
    // Check if we're showing falling tile
    console.log("Current falling tile exists:", currentFallingTile !== null);
    
    if (currentFallingTile) {
        console.log("Falling tile position:", currentFallingTile.position);
    }
    
    // Check raycasting
    if (currentFallingTile && soccerBall) {
        const tilePos = new THREE.Vector3();
        currentFallingTile.getWorldPosition(tilePos);
        const direction = new THREE.Vector3(0, 0, 0).sub(tilePos).normalize();
        
        console.log("Tile position for raycasting:", tilePos);
        console.log("Raycast direction:", direction);
        
        const raycaster = new THREE.Raycaster(tilePos, direction);
        const hits = raycaster.intersectObject(soccerBall, true);
        
        console.log("Raw raycast hits:", hits.length);
        if (hits.length > 0) {
            console.log("First hit object:", hits[0].object.type);
            console.log("Hit distance:", hits[0].distance);
            console.log("Hit point:", hits[0].point);
        }
    }
    
    console.log("=== END DEBUG ===");
    
    // Force update ghost tile
    if (currentFallingTile) {
        // Remove any existing ghost
        if (ghostTile && ghostTile.parent) {
            ghostTile.parent.remove(ghostTile);
            ghostTile = null;
        }
        
        // Create a bright visible test ghost at the current falling tile position
        ghostTile = new THREE.Mesh(
            currentFallingTile.geometry.clone(),
            new THREE.MeshBasicMaterial({ 
                color: 0xff0000, 
                wireframe: true, 
                transparent: true, 
                opacity: 0.9 
            })
        );
        
        // Position slightly offset from the current falling tile
        currentFallingTile.getWorldPosition(new THREE.Vector3());
        ghostTile.position.copy(currentFallingTile.position).add(new THREE.Vector3(0, -0.5, 0));
        ghostTile.quaternion.copy(currentFallingTile.quaternion);
        
        // Add to scene directly for maximum visibility
        scene.add(ghostTile);
        
        console.log("TEST GHOST CREATED");
    }
    
    return "Debug complete - check console";
}

// --- UI for Current and Next Piece ---
function createPiecePreviewDisplay() {
    const previewContainer = document.createElement('div');
    previewContainer.id = 'piece-preview-container';
    previewContainer.style.position = 'absolute';
    previewContainer.style.top = '100px'; // Below score
    previewContainer.style.left = '20px';
    previewContainer.style.fontFamily = 'Arial, sans-serif';
    previewContainer.style.fontSize = '18px';
    previewContainer.style.color = 'white';
    previewContainer.style.textShadow = '1px 1px 2px rgba(0, 0, 0, 0.5)';

    const currentPieceDiv = document.createElement('div');
    currentPieceDiv.id = 'current-piece-preview';
    currentPieceDiv.style.marginBottom = '10px';
    currentPieceDiv.style.display = 'flex'; // Align items inline
    currentPieceDiv.style.alignItems = 'center';
    currentPieceDiv.innerHTML = 'Current: ';

    const currentShapeGraphic = document.createElement('div');
    currentShapeGraphic.id = 'current-shape-graphic';
    currentShapeGraphic.style.width = '22px'; // Base width
    currentShapeGraphic.style.height = '20px'; // Base height
    currentShapeGraphic.style.border = '1px solid white';
    currentShapeGraphic.style.marginLeft = '8px';
    currentShapeGraphic.style.display = 'inline-block';
    currentPieceDiv.appendChild(currentShapeGraphic);

    const nextPieceDiv = document.createElement('div');
    nextPieceDiv.id = 'next-piece-preview';
    nextPieceDiv.style.display = 'flex'; // Align items inline
    nextPieceDiv.style.alignItems = 'center';
    nextPieceDiv.innerHTML = 'Next: ';

    const nextShapeGraphic = document.createElement('div');
    nextShapeGraphic.id = 'next-shape-graphic';
    nextShapeGraphic.style.width = '22px'; // Base width
    nextShapeGraphic.style.height = '20px'; // Base height
    nextShapeGraphic.style.border = '1px solid white';
    nextShapeGraphic.style.marginLeft = '8px';
    nextShapeGraphic.style.display = 'inline-block';
    nextPieceDiv.appendChild(nextShapeGraphic);

    previewContainer.appendChild(currentPieceDiv);
    previewContainer.appendChild(nextPieceDiv);
    document.body.appendChild(previewContainer);
}

function updatePiecePreviewUI() {
    const currentShapeGraphic = document.getElementById('current-shape-graphic');
    const nextShapeGraphic = document.getElementById('next-shape-graphic');

    if (!currentShapeGraphic || !nextShapeGraphic) {
        console.warn("Piece preview graphic elements not found.");
        return;
    }

    // Reset styles before applying new ones
    currentShapeGraphic.style.clipPath = 'none';
    nextShapeGraphic.style.clipPath = 'none';
    // Set default dimensions which might be overridden by clip-path needs
    currentShapeGraphic.style.width = '22px';
    currentShapeGraphic.style.height = '20px';
    nextShapeGraphic.style.width = '22px';
    nextShapeGraphic.style.height = '20px';

    // Update Current Piece Preview
    if (currentFallingTile) {
        if (currentFallingTile.geometry === hexGeometry) {
            currentShapeGraphic.style.clipPath = 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)';
        } else if (currentFallingTile.geometry === pentGeometry) {
            currentShapeGraphic.style.clipPath = 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)';
            currentShapeGraphic.style.width = '20px'; // Pentagon might look better slightly less wide
        } else {
            currentShapeGraphic.style.backgroundColor = 'transparent'; // Unknown shape
        }
        currentShapeGraphic.style.backgroundColor = `#${currentFallingTile.material.color.getHexString()}`;
    } else {
        currentShapeGraphic.style.backgroundColor = 'transparent';
        currentShapeGraphic.style.clipPath = 'none';
    }

    // Update Next Piece Preview
    if (nextTileGeometry && nextTileColor !== null) {
        if (nextTileGeometry === hexGeometry) {
            nextShapeGraphic.style.clipPath = 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)';
        } else if (nextTileGeometry === pentGeometry) {
            nextShapeGraphic.style.clipPath = 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)';
            nextShapeGraphic.style.width = '20px'; // Pentagon might look better slightly less wide
        } else {
            nextShapeGraphic.style.backgroundColor = 'transparent'; // Unknown shape
        }
        nextShapeGraphic.style.backgroundColor = `#${new THREE.Color(nextTileColor).getHexString()}`;
    } else {
        nextShapeGraphic.style.backgroundColor = 'transparent';
        nextShapeGraphic.style.clipPath = 'none';
    }
}
// --- End UI for Current and Next Piece ---

function createLayerCountDisplay() {
    const layerCountContainer = document.createElement('div');
    layerCountContainer.id = 'layer-count-display';
    layerCountContainer.style.position = 'absolute';
    layerCountContainer.style.top = '120px'; // Position below score and preview
    layerCountContainer.style.right = '10px';
    layerCountContainer.style.padding = '10px';
    layerCountContainer.style.backgroundColor = 'rgba(0,0,0,0.7)';
    layerCountContainer.style.color = 'white';
    layerCountContainer.style.fontFamily = 'Arial, sans-serif';
    layerCountContainer.style.fontSize = '16px';
    layerCountContainer.style.borderRadius = '5px';
    layerCountContainer.style.maxHeight = 'calc(100vh - 150px)'; 
    layerCountContainer.style.overflowY = 'auto'; 
    layerCountContainer.innerHTML = '<strong>Layer Counts:</strong>';
    document.body.appendChild(layerCountContainer);
}

function updateLayerCountDisplay() {
    const layerCountContainer = document.getElementById('layer-count-display');
    if (!layerCountContainer) return;

    let content = '<strong>Layer Counts:</strong><br>';
    
    const sortedLayers = Array.from(layerTiles.keys())
        .map(layer => parseFloat(layer)) 
        .sort((a, b) => a - b); 

    if (sortedLayers.length === 0) {
        content += '<em>No layers yet</em>';
    } else {
        for (const layerKey of sortedLayers) {
            const tilesInLayer = layerTiles.get(layerKey); 
            if (tilesInLayer) {
                content += `Layer ${layerKey.toFixed(1)}: ${tilesInLayer.length} tiles<br>`;
            } else {
                console.warn(`Layer key ${layerKey} not found in layerTiles during display update after sorting.`);
            }
        }
    }
    layerCountContainer.innerHTML = content;
}

function triggerGameOver() {
    if (isGameOver) return; // Prevent multiple triggers
    isGameOver = true;
    console.log("GAME OVER! Final Score:", score);

    // Stop falling tile if any
    if (currentFallingTile) {
        if (currentFallingTile.parent) {
            currentFallingTile.parent.remove(currentFallingTile);
        }
        currentFallingTile = null;
    }
    // Stop ghost tile
    if (ghostTile) {
        if (ghostTile.parent) {
            ghostTile.parent.remove(ghostTile);
        }
        ghostTile = null;
    }

    // Display Game Over message
    const gameOverDiv = document.createElement('div');
    gameOverDiv.id = 'game-over-display';
    gameOverDiv.style.position = 'absolute';
    gameOverDiv.style.top = '50%';
    gameOverDiv.style.left = '50%';
    gameOverDiv.style.transform = 'translate(-50%, -50%)';
    gameOverDiv.style.padding = '30px';
    gameOverDiv.style.backgroundColor = 'rgba(100, 0, 0, 0.9)'; // Dark red
    gameOverDiv.style.color = 'white';
    gameOverDiv.style.fontFamily = 'Arial, sans-serif';
    gameOverDiv.style.fontSize = '48px';
    gameOverDiv.style.fontWeight = 'bold';
    gameOverDiv.style.textAlign = 'center';
    gameOverDiv.style.border = '4px solid white';
    gameOverDiv.style.borderRadius = '15px';
    gameOverDiv.style.boxShadow = '0 0 20px rgba(0,0,0,0.7)';
    gameOverDiv.style.zIndex = '1001';
    gameOverDiv.innerHTML = `GAME OVER<br><span style="font-size: 32px; font-weight: normal;">Final Score: ${score}</span>`;
    document.body.appendChild(gameOverDiv);
    
    // No new piece preview updates needed after game over
    const currentShapeGraphic = document.getElementById('current-shape-graphic');
    const nextShapeGraphic = document.getElementById('next-shape-graphic');
    if(currentShapeGraphic) currentShapeGraphic.style.backgroundColor = 'transparent';
    if(nextShapeGraphic) nextShapeGraphic.style.backgroundColor = 'transparent';
}